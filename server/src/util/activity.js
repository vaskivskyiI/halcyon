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

export function recordRequest(req, status, ms) {
  if (ms < SLOW_REQUEST_MS) return;
  const url = req.routeOptions?.url || req.url.split('?')[0];
  if (url === '/api/ws') return;
  slowRequests.unshift({ method: req.method, route: url, status, ms: Math.round(ms), at: Date.now() - Math.round(ms), userId: req.user?.id ?? null });
  slowRequests.length = Math.min(slowRequests.length, KEEP);
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
