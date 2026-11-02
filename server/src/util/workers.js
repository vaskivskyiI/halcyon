// Worker threads for CPU-heavy work (mail parsing, the AI memory scan): better-sqlite3 and JavaScript run on the main
// thread, so while one of these runs no request is answered. A worker file calls serve(handlers); the main thread gets
// a client whose call(type, payload) returns a promise. Workers start on first use, are restarted when one dies, and
// keep the process alive only while a call is outstanding. stats() feeds the admin's Server activity view.
import { Worker, parentPort, isMainThread } from 'node:worker_threads';
import { logger } from './log.js';

const log = logger('workers');
const all = [];

/** In a worker file: answers calls with handlers[type](payload) (sync or async). */
export function serve(handlers) {
  parentPort.on('message', async ({ id, type, payload }) => {
    try {
      const h = handlers[type];
      if (!h) throw new Error(`No handler for ${type}`);
      const result = await h(payload);
      if (id) parentPort.postMessage({ id, result });
    } catch (e) {
      if (id) parentPort.postMessage({ id, error: String(e?.message || e) });
    }
  });
}

/** name: shown to the admin; size: threads (calls go to the least busy one); workerData: handed to each thread. */
export function workerPool(file, { name, size = 1, workerData = null }) {
  const threads = [], started = [];
  const stats = { name, size, calls: 0, failed: 0, restarts: 0, busyMs: 0 };
  let seq = 0;

  function spawn(slot) {
    const w = new Worker(file, { workerData });
    const t = { w, slot, pending: new Map(), elu: w.performance.eventLoopUtilization() };
    // Not keeping the process alive while idle (again once started: an unref before that does not hold).
    const idle = () => { if (!t.pending.size) w.unref(); };
    w.unref();
    w.on('online', idle);
    w.on('message', ({ id, result, error }) => {
      const p = t.pending.get(id);
      if (!p) return;
      t.pending.delete(id);
      stats.busyMs += performance.now() - p.at;
      idle();
      if (error) { stats.failed++; p.reject(new Error(error)); } else p.resolve(result);
    });
    const dead = (e) => {
      if (threads[slot] !== t) return;
      threads[slot] = null;
      if (e) log.warn(`${name} worker stopped: ${e.message || e}`);
      for (const p of t.pending.values()) p.reject(e instanceof Error ? e : new Error(`${name} worker stopped`));
      t.pending.clear();
    };
    w.on('error', dead);
    w.on('exit', (code) => dead(code ? new Error(`exit code ${code}`) : null));
    return t;
  }

  const thread = () => {
    let best = null;
    for (let i = 0; i < size; i++) {
      if (!threads[i]) { if (started[i]) stats.restarts++; started[i] = true; threads[i] = spawn(i); }
      if (!best || threads[i].pending.size < best.pending.size) best = threads[i];
    }
    return best;
  };

  const pool = {
    /** Runs type in a worker; transfer: ArrayBuffers handed over instead of copied. */
    call(type, payload, transfer) {
      const t = thread(), id = ++seq;
      stats.calls++;
      t.w.ref();
      return new Promise((resolve, reject) => {
        t.pending.set(id, { resolve, reject, at: performance.now() });
        t.w.postMessage({ id, type, payload }, transfer);
      });
    },
    /** To every running thread, no answer (cache invalidation and the like); messages keep their order per thread. */
    post(type, payload) {
      for (const t of threads) if (t) t.w.postMessage({ type, payload });
    },
    stats() {
      const live = threads.filter(Boolean);
      return {
        ...stats, busyMs: Math.round(stats.busyMs), running: live.length, pending: live.reduce((n, t) => n + t.pending.size, 0),
        // Share of the time since the previous look that each thread was busy (100 = all of it).
        busyPercent: live.map((t) => { const e = t.w.performance.eventLoopUtilization(t.elu); t.elu = t.w.performance.eventLoopUtilization(); return Math.round(e.utilization * 1000) / 10; }),
      };
    },
    async close() { await Promise.all(threads.splice(0).filter(Boolean).map((t) => t.w.terminate())); },
  };
  all.push(pool);
  return pool;
}

export const workerStats = () => all.map((p) => p.stats());
export const inWorker = !isMainThread;
