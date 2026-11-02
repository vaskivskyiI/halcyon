// What the server is doing in the background right now, in memory only: labelled work with start and finish (scheduled
// jobs, calendar/contacts syncs, heavy parsing), slow HTTP requests and process load. For the admin's activity view
// (routes/admin-activity.js), to find what keeps the CPU busy.
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

let seq = 0;
const active = new Map();
/** Totals per kind + label: how often it ran, how long it took. */
const totals = new Map();
/** The last finished pieces of work that took long, newest first. */
const slowWork = [];
const slowRequests = [];
const SLOW_WORK_MS = 1000, SLOW_REQUEST_MS = 500, KEEP = 50;

/** Marks work as running; returns end(). meta: small plain values shown with it (account id, user id, …). */
export function track(kind, label, meta = null) {
  const id = ++seq, since = Date.now();
  active.set(id, { id, kind, label, meta, since });
  return () => {
    if (!active.delete(id)) return;
    const ms = Date.now() - since, key = `${kind}\u0000${label}`;
    let t = totals.get(key);
    if (!t) totals.set(key, t = { kind, label, runs: 0, totalMs: 0, maxMs: 0, lastAt: 0, lastMs: 0 });
    t.runs++; t.totalMs += ms; t.maxMs = Math.max(t.maxMs, ms); t.lastAt = Date.now(); t.lastMs = ms;
    if (ms >= SLOW_WORK_MS) { slowWork.unshift({ kind, label, meta, at: since, ms }); slowWork.length = Math.min(slowWork.length, KEEP); }
  };
}

/** Runs fn (sync or async) as tracked work; errors pass through. */
export function tracked(kind, label, meta, fn) {
  const end = track(kind, label, meta);
  let r;
  try { r = fn(); } catch (e) { end(); throw e; }
  if (r && typeof r.then === 'function') return r.finally(end);
  end();
  return r;
}

// Stalls of the event loop: a timer every TICK_MS notes how late it fires. A request that took long while the loop was
// stalled waited for other work (sync, AI, a heavy query) rather than being slow itself. A request that arrived during a
// stall is only seen by Fastify when the stall ends, so the stall just before it started counts as waiting too.
const TICK_MS = 10, STALL_MS = 20;
let lastTick = performance.now(), stalledMs = 0;
const stalls = []; // { end, ms }, the last few seconds
setInterval(() => {
  const t = performance.now(), late = t - lastTick - TICK_MS;
  lastTick = t;
  if (late < STALL_MS) return;
  stalledMs += late;
  stalls.push({ end: t, ms: late });
  while (stalls.length && stalls[0].end < t - 60e3) stalls.shift();
}, TICK_MS).unref();
// Includes a stall still going on (the timer has not fired yet because the loop is busy).
const stalledNow = () => { const late = performance.now() - lastTick - TICK_MS; return stalledMs + (late >= STALL_MS ? late : 0); };
/** Called when a request comes in: what to compare with in recordRequest. */
export function requestStart(req) {
  req.loop0 = stalledNow();
  const t = performance.now(), prev = stalls[stalls.length - 1];
  req.queuedMs = prev && t - prev.end < 2 * TICK_MS ? prev.ms : 0;
}

/**
 * onRoute hook: times the synchronous part of each handler (up to its first await — with better-sqlite3 that is
 * usually all its database work), so a stall caused by the request itself is not taken for other work.
 */
export function timeHandler(route) {
  if (route.websocket) return;
  const h = route.handler;
  route.handler = function timed(req, reply) {
    const t = performance.now();
    try { return h.call(this, req, reply); } finally { req.ownMs = (req.ownMs || 0) + performance.now() - t; }
  };
}

export function recordRequest(req, status, ms) {
  const stalled = req.loop0 == null ? 0 : stalledNow() - req.loop0;
  const waited = req.queuedMs || 0;
  if (ms + waited < SLOW_REQUEST_MS) return;
  const url = req.routeOptions?.url || req.url.split('?')[0];
  if (url === '/api/ws') return;
  // ownMs: the handler's own synchronous work; busyMs: how long the server was busy with other work meanwhile (sync,
  // AI, scheduled jobs, other requests), including before the request was even read. Together they tell a slow
  // handler from a busy server; the rest is waiting (on a provider, a mail server, the disk).
  const ownMs = Math.min(ms, req.ownMs || 0);
  slowRequests.unshift({ method: req.method, route: url, status, ms: Math.round(ms + waited), ownMs: Math.round(ownMs), busyMs: Math.round(Math.max(0, Math.min(ms, stalled) - ownMs) + waited),
    at: Date.now() - Math.round(ms + waited), userId: req.user?.id ?? null });
  slowRequests.length = Math.min(slowRequests.length, KEEP);
}

/** Longest stall and total stalled time of the stalls that began in the last windowMs (admin view, benchmarks). */
export function recentStalls(windowMs = 60e3) {
  const from = performance.now() - windowMs, r = stalls.filter((s) => s.end - s.ms >= from);
  return { count: r.length, totalMs: Math.round(r.reduce((a, s) => a + s.ms, 0)), maxMs: Math.round(Math.max(0, ...r.map((s) => s.ms))) };
}

// Load since the previous snapshot (or the start): CPU share, event-loop delay and utilisation.
const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();
let last = { at: performance.now(), cpu: process.cpuUsage(), elu: performance.eventLoopUtilization() };
const ms = (ns) => Math.round(ns / 1e5) / 10;

export function processStats() {
  const at = performance.now(), cpu = process.cpuUsage(last.cpu), elu = performance.eventLoopUtilization(last.elu);
  const wall = Math.max(1, at - last.at), mem = process.memoryUsage();
  const out = {
    pid: process.pid, node: process.version, uptimeSec: Math.round(process.uptime()), sampleSec: Math.round(wall / 100) / 10,
    // Of one core: 100 = one core busy the whole time.
    cpuPercent: Math.round((cpu.user + cpu.system) / 1000 / wall * 1000) / 10,
    cpuUserPercent: Math.round(cpu.user / 1000 / wall * 1000) / 10,
    eventLoop: { utilisation: Math.round(elu.utilization * 1000) / 10, delayMeanMs: ms(loop.mean || 0), delayP99Ms: ms(loop.percentile(99) || 0), delayMaxMs: ms(loop.max || 0) },
    memoryMb: { rss: Math.round(mem.rss / 1048576), heapUsed: Math.round(mem.heapUsed / 1048576), heapTotal: Math.round(mem.heapTotal / 1048576), external: Math.round(mem.external / 1048576) },
  };
  last = { at, cpu: process.cpuUsage(), elu: performance.eventLoopUtilization() };
  loop.reset();
  return out;
}

export function activitySnapshot() {
  const t = Date.now();
  return {
    running: [...active.values()].map((w) => ({ ...w, ms: t - w.since })).sort((a, b) => a.since - b.since),
    totals: [...totals.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, 40),
    slowWork: [...slowWork],
    slowRequests: [...slowRequests],
  };
}
