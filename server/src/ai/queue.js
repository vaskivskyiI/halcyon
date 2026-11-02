// Background AI job queue (SQLite-backed). Jobs are deduplicated per (type, ref, user) and processed by
// priority so that the newest/most relevant mail is analysed first. Results are pushed to clients live.
import { AsyncLocalStorage } from 'node:async_hooks';
import { all, get, run, now } from '../db/index.js';
import { getSettings } from '../settings.js';
import { logger } from '../util/log.js';
import { notify } from '../util/events.js';

const log = logger('ai-queue');
const handlers = {};
let running = 0;
let timer = null, timerDue = 0;
const perUser = new Map();
const MAX_GLOBAL = Number(process.env.HALCYON_AI_CONCURRENCY || 4);
// Running jobs in memory (admin activity view): since when, and the AI calls each one is making.
const active = new Map();
const jobScope = new AsyncLocalStorage();
let paused = false;

/** Called by the AI router around each provider call: the running job (if any) shows which provider/model it waits on. */
export function noteCall(provider, model, task) {
  const a = active.get(jobScope.getStore());
  if (!a) return () => {};
  const call = { provider, model, task, since: Date.now() };
  a.calls.push(call);
  return () => { a.calls.splice(a.calls.indexOf(call), 1); a.callsDone++; };
}

export function registerHandler(type, fn) { handlers[type] = fn; }

/** options: stored with the job and handed to the handler (job.options_json), e.g. { quiet: true }. */
export function enqueue(userId, type, refId, priority = 50, { delayMs = 0, force = false, options = null } = {}) {
  const opts = options ? JSON.stringify(options) : null;
  const ref = String(refId);
  const existing = get('SELECT id, status FROM ai_jobs WHERE user_id = ? AND type = ? AND ref_id = ?', userId, type, ref);
  let queued = true;
  if (existing) {
    if (force && existing.status !== 'running') {
      run("UPDATE ai_jobs SET status = 'queued', attempts = 0, error = NULL, priority = ?, run_after = ?, options_json = ?, updated_at = ? WHERE id = ?", priority, now() + delayMs, opts, now(), existing.id);
    } else if (existing.status === 'queued') {
      run('UPDATE ai_jobs SET priority = MAX(priority, ?) WHERE id = ?', priority, existing.id);
    } else queued = existing.status === 'running';
  } else {
    run('INSERT INTO ai_jobs (user_id, type, ref_id, priority, run_after, options_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', userId, type, ref, priority, now() + delayMs, opts, now(), now());
  }
  // Keep the message's visible state truthful: 'pending' only while a job will actually run.
  if (queued && type === 'analyze') run("UPDATE messages SET ai_status = 'pending' WHERE id = ? AND ai_status != 'done'", Number(ref));
  kick();
}

/** Queues (re)indexing of one memory item: kind message | thread | event | contact | fact. */
export function queueMemory(userId, kind, ref, priority = 5) {
  const s = getSettings(userId).ai;
  if (!s.enabled || !s.embeddings) return;
  if (kind === 'message') enqueue(userId, 'embed', ref, priority, { force: true });
  else enqueue(userId, 'memory', `${kind}:${ref}`, kind === 'fact' ? Math.max(priority, 20) : priority, { force: true });
}

// A new job must not wait behind a long sleep that was scheduled for a delayed job (retry back-off, brief refresh).
export function kick() {
  if (timer && timerDue <= Date.now() + 100) return;
  clearTimeout(timer);
  timerDue = Date.now() + 50;
  timer = setTimeout(tick, 50);
}

async function runJob(job) {
  // Atomic claim: an embed batch may already have taken this job since the tick's SELECT.
  if (!run("UPDATE ai_jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'queued'", now(), job.id).changes) return;
  running++;
  perUser.set(job.user_id, (perUser.get(job.user_id) || 0) + 1);
  const entry = { job, since: Date.now(), calls: [], callsDone: 0, released: false };
  active.set(job.id, entry);
  try {
    const h = handlers[job.type];
    if (!h) throw new Error(`No handler for ${job.type}`);
    await jobScope.run(job.id, () => h(job.user_id, job.ref_id, job));
    if (!entry.released) run("UPDATE ai_jobs SET status = 'done', error = NULL, updated_at = ? WHERE id = ?", now(), job.id);
  } catch (e) {
    if (entry.released) return;
    if (e.code === 'NO_PROVIDER' || e.code === 'AI_DISABLED') {
      // Parked until the user configures a provider (see resumeWaiting).
      run("UPDATE ai_jobs SET status = 'waiting', error = ?, attempts = 0, updated_at = ? WHERE id = ?", e.message, now(), job.id);
      if (job.type === 'analyze') run("UPDATE messages SET ai_status = 'waiting' WHERE id = ? AND ai_status != 'done'", Number(job.ref_id));
    } else if (e.code === 'SKIP') {
      run("UPDATE ai_jobs SET status = 'done', error = ?, updated_at = ? WHERE id = ?", e.message, now(), job.id);
    } else {
      const attempts = job.attempts + 1;
      const transient = !e.status || e.status >= 429;
      const failed = attempts >= (transient ? 6 : 2);
      log.warn(`job ${job.type}:${job.ref_id} failed (${attempts}): ${e.message}`);
      run('UPDATE ai_jobs SET status = ?, error = ?, run_after = ?, updated_at = ? WHERE id = ?',
        failed ? 'failed' : 'queued', e.message, now() + Math.min(30 * 60e3, 15e3 * 2 ** attempts), now(), job.id);
      if (job.type === 'analyze') run("UPDATE messages SET ai_status = ? WHERE id = ?", failed ? 'failed' : 'pending', Number(job.ref_id));
    }
  } finally {
    if (active.get(job.id) === entry) active.delete(job.id);
    if (!entry.released) release(job);
  }
}

function release(job) {
  running--;
  perUser.set(job.user_id, perUser.get(job.user_id) - 1);
  kick();
}

function tick() {
  timer = null;
  if (paused || running >= MAX_GLOBAL) return;
  const jobs = all("SELECT * FROM ai_jobs WHERE status = 'queued' AND run_after <= ? ORDER BY priority DESC, id DESC LIMIT 50", now());
  for (const job of jobs) {
    if (running >= MAX_GLOBAL) break;
    const limit = getSettings(job.user_id).ai.maxConcurrency || 2;
    if ((perUser.get(job.user_id) || 0) >= limit) continue;
    runJob(job);
  }
  const next = get("SELECT MIN(run_after) AS t FROM ai_jobs WHERE status = 'queued'")?.t;
  if (next && !timer) {
    const delay = Math.max(500, Math.min(60e3, next - now()));
    timerDue = now() + delay;
    timer = setTimeout(tick, delay);
  }
}

export function resumeWaiting(userId) {
  run(`UPDATE messages SET ai_status = 'pending' WHERE user_id = ? AND ai_status IN ('waiting', 'failed') AND CAST(id AS TEXT) IN
    (SELECT ref_id FROM ai_jobs WHERE user_id = ? AND type = 'analyze' AND status IN ('waiting', 'failed'))`, userId, userId);
  run("UPDATE ai_jobs SET status = 'queued', attempts = 0, run_after = 0 WHERE user_id = ? AND status IN ('waiting', 'failed')", userId);
  kick();
}

export function startQueue() {
  run("UPDATE ai_jobs SET status = 'queued' WHERE status = 'running'");
  run("DELETE FROM ai_jobs WHERE status = 'done' AND updated_at < ?", now() - 7 * 864e5);
  setInterval(kick, 30e3).unref();
  kick();
}

export function queueStats(userId) {
  const rows = all('SELECT type, status, COUNT(*) AS n FROM ai_jobs WHERE user_id = ? GROUP BY type, status', userId);
  const lastError = get("SELECT type, error, updated_at FROM ai_jobs WHERE user_id = ? AND error IS NOT NULL AND status != 'done' ORDER BY updated_at DESC LIMIT 1", userId);
  return { rows, lastError, running };
}

/** Admin: stops starting new jobs (running ones finish); in memory, so a restart resumes. */
export function pauseQueue(on) { paused = !!on; if (!paused) kick(); return paused; }
export const queuePaused = () => paused;

/**
 * Admin: a queued job is dropped; a running one is marked failed and its slot freed at once, so a call that hangs
 * (a model server that never answers) stops holding up the queue. Its handler may still finish in the background;
 * what it returns then is ignored.
 */
export function cancelJob(id) {
  const job = get('SELECT * FROM ai_jobs WHERE id = ?', id);
  if (!job || !['queued', 'running', 'waiting'].includes(job.status)) return false;
  run("UPDATE ai_jobs SET status = 'failed', error = 'Cancelled by an administrator', updated_at = ? WHERE id = ?", now(), id);
  if (job.type === 'analyze') run("UPDATE messages SET ai_status = 'failed' WHERE id = ? AND ai_status != 'done'", Number(job.ref_id));
  const entry = active.get(id);
  if (entry && !entry.released) { entry.released = true; active.delete(id); release(entry.job); }
  return true;
}

/** Running jobs (from memory: since when, current AI calls) and the next queued ones, for the admin view. */
export function queueActivity(limit = 50) {
  const t = Date.now();
  return {
    paused, running, maxGlobal: MAX_GLOBAL,
    active: [...active.values()].map(({ job, since, calls, callsDone }) => ({
      id: job.id, type: job.type, userId: job.user_id, refId: job.ref_id, priority: job.priority, attempts: job.attempts + 1, since, ms: t - since,
      calls: calls.map((c) => ({ ...c, ms: t - c.since })), callsDone,
    })),
    queued: all("SELECT id, type, user_id AS userId, ref_id AS refId, priority, attempts, run_after AS runAfter, created_at AS createdAt FROM ai_jobs WHERE status = 'queued' ORDER BY run_after <= ? DESC, priority DESC, id DESC LIMIT ?", now(), limit),
    counts: all("SELECT type, status, COUNT(*) AS n FROM ai_jobs WHERE status IN ('queued', 'running', 'waiting') GROUP BY type, status ORDER BY n DESC"),
  };
}

export const notifyAI = (userId, type, payload) => notify(userId, type, payload);
