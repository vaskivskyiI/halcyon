// Background AI job queue (SQLite-backed). Jobs are deduplicated per (type, ref, user) and processed by
// priority so that the newest/most relevant mail is analysed first. Results are pushed to clients live.
import { all, get, run, now } from '../db/index.js';
import { getSettings } from '../settings.js';
import { logger } from '../util/log.js';
import { notify } from '../util/events.js';

const log = logger('ai-queue');
const handlers = {};
let running = 0;
let timer = null;
const perUser = new Map();
const MAX_GLOBAL = Number(process.env.HALCYON_AI_CONCURRENCY || 4);

export function registerHandler(type, fn) { handlers[type] = fn; }

export function enqueue(userId, type, refId, priority = 50, { delayMs = 0, force = false } = {}) {
  const ref = String(refId);
  const existing = get('SELECT id, status FROM ai_jobs WHERE user_id = ? AND type = ? AND ref_id = ?', userId, type, ref);
  if (existing) {
    if (force && existing.status !== 'running') {
      run("UPDATE ai_jobs SET status = 'queued', attempts = 0, error = NULL, priority = ?, run_after = ?, updated_at = ? WHERE id = ?", priority, now() + delayMs, now(), existing.id);
    } else if (existing.status === 'queued') {
      run('UPDATE ai_jobs SET priority = MAX(priority, ?) WHERE id = ?', priority, existing.id);
    }
  } else {
    run('INSERT INTO ai_jobs (user_id, type, ref_id, priority, run_after, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', userId, type, ref, priority, now() + delayMs, now(), now());
  }
  kick();
}

export function kick() { if (!timer) timer = setTimeout(tick, 50); }

async function runJob(job) {
  running++;
  perUser.set(job.user_id, (perUser.get(job.user_id) || 0) + 1);
  run("UPDATE ai_jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?", now(), job.id);
  try {
    const h = handlers[job.type];
    if (!h) throw new Error(`No handler for ${job.type}`);
    await h(job.user_id, job.ref_id, job);
    run("UPDATE ai_jobs SET status = 'done', error = NULL, updated_at = ? WHERE id = ?", now(), job.id);
  } catch (e) {
    if (e.code === 'NO_PROVIDER' || e.code === 'AI_DISABLED') {
      // Parked until the user configures a provider (see resumeWaiting).
      run("UPDATE ai_jobs SET status = 'waiting', error = ?, attempts = 0, updated_at = ? WHERE id = ?", e.message, now(), job.id);
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
    running--;
    perUser.set(job.user_id, perUser.get(job.user_id) - 1);
    kick();
  }
}

function tick() {
  timer = null;
  if (running >= MAX_GLOBAL) return;
  const jobs = all("SELECT * FROM ai_jobs WHERE status = 'queued' AND run_after <= ? ORDER BY priority DESC, id DESC LIMIT 50", now());
  for (const job of jobs) {
    if (running >= MAX_GLOBAL) break;
    const limit = getSettings(job.user_id).ai.maxConcurrency || 2;
    if ((perUser.get(job.user_id) || 0) >= limit) continue;
    runJob(job);
  }
  const next = get("SELECT MIN(run_after) AS t FROM ai_jobs WHERE status = 'queued'")?.t;
  if (next && !timer) timer = setTimeout(tick, Math.max(500, Math.min(60e3, next - now())));
}

export function resumeWaiting(userId) {
  run("UPDATE ai_jobs SET status = 'queued', run_after = 0 WHERE user_id = ? AND status IN ('waiting', 'failed')", userId);
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
  const lastError = get("SELECT error, updated_at FROM ai_jobs WHERE user_id = ? AND error IS NOT NULL AND status != 'done' ORDER BY updated_at DESC LIMIT 1", userId);
  return { rows, lastError, running };
}

export const notifyAI = (userId, type, payload) => notify(userId, type, payload);
