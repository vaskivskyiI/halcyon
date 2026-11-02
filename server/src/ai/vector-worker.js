// Worker thread holding the AI memory index (see memory.js): per user one int8-quantised array of every chunk, loaded
// from SQLite on its own connection (WAL lets it read while the main thread writes) and searched by brute force. Loading
// a large memory takes seconds and each search scans every chunk; here neither holds up requests.
// The main thread writes the rows and then tells this thread what changed (add / kill / invalidate), in order, so a
// search always sees the rows committed before it was asked.
import Database from 'better-sqlite3';
import { workerData } from 'node:worker_threads';
import { serve } from '../util/workers.js';

const db = new Database(workerData.dbPath, { fileMustExist: true });
db.pragma('busy_timeout = 5000');
db.pragma('query_only = ON');
const loadRows = db.prepare('SELECT id, kind, ref_id, chunk, owner, dim, vector FROM memory WHERE user_id = ? AND model = ?');

const indexes = new Map(); // userId -> index
const IDLE_MS = 30 * 60e3;
const Q = 127;

function quantize(f, out, offset) {
  for (let i = 0; i < f.length; i++) out[offset + i] = Math.max(-Q, Math.min(Q, Math.round(f[i] * Q)));
}

function push(idx, rowId, meta, f) {
  // Rows committed just before a load arrive again as an add: once is enough.
  if (idx.slots.has(rowId)) return;
  if (idx.size === idx.cap) {
    idx.cap = Math.max(1024, idx.cap * 2);
    const q = new Int8Array(idx.cap * idx.dim);
    q.set(idx.q);
    idx.q = q;
  }
  quantize(f, idx.q, idx.size * idx.dim);
  idx.meta[idx.size] = { id: rowId, ...meta };
  idx.slots.set(rowId, idx.size);
  idx.size++;
}

function load(userId, model) {
  let idx = indexes.get(userId);
  if (idx && idx.model === model) { idx.used = Date.now(); return idx; }
  idx = { model, dim: 0, size: 0, cap: 0, q: new Int8Array(0), meta: [], slots: new Map(), dead: 0, used: Date.now() };
  for (const r of loadRows.iterate(userId, model)) {
    if (!idx.dim) idx.dim = r.dim;
    if (r.dim !== idx.dim) continue;
    push(idx, r.id, { kind: r.kind, ref: r.ref_id, chunk: r.chunk, owner: r.owner }, new Float32Array(r.vector.buffer.slice(r.vector.byteOffset, r.vector.byteOffset + r.dim * 4)));
  }
  indexes.set(userId, idx);
  return idx;
}

serve({
  // rows: [{ id, kind, ref, chunk, owner, f: Float32Array (normalised) }] just stored for this model.
  add({ userId, model, rows }) {
    const idx = indexes.get(userId);
    if (!idx || idx.model !== model) return;
    for (const { f, ...meta } of rows) {
      if (!idx.dim) idx.dim = f.length;
      if (idx.dim === f.length) push(idx, meta.id, meta, f);
    }
  },
  kill({ userId, ids }) {
    const idx = indexes.get(userId);
    if (!idx) return;
    for (const id of ids) {
      const s = idx.slots.get(id);
      if (s == null) continue;
      idx.meta[s] = null;
      idx.slots.delete(id);
      idx.dead++;
    }
    // Many deleted slots: drop the index; the next search reloads a compact one.
    if (idx.dead > 1000 && idx.dead > idx.size / 3) indexes.delete(userId);
  },
  invalidate({ userId }) { if (userId == null) indexes.clear(); else indexes.delete(userId); },
  search({ userId, vector: f, model, k, owners, kinds, minScore }) {
    const idx = load(userId, model);
    if (!idx.size || f.length !== idx.dim) return [];
    const qv = new Int8Array(idx.dim);
    quantize(f, qv, 0);
    const hits = [];
    const { q, dim, meta } = idx;
    const scale = 1 / (Q * Q);
    for (let s = 0; s < idx.size; s++) {
      const m = meta[s];
      if (!m || (owners && !owners.has(m.owner)) || (kinds && !kinds.has(m.kind))) continue;
      let dot = 0;
      for (let j = 0, o = s * dim; j < dim; j++) dot += q[o + j] * qv[j];
      const score = dot * scale;
      if (score >= minScore) hits.push([score, s]);
    }
    hits.sort((a, b) => b[0] - a[0]);
    return hits.slice(0, k).map(([score, s]) => ({ ...meta[s], score }));
  },
  stats({ userId }) {
    const idx = indexes.get(userId);
    return idx ? { model: idx.model, chunks: idx.slots.size, bytes: idx.q.byteLength } : null;
  },
});

setInterval(() => { for (const [u, idx] of indexes) if (Date.now() - idx.used > IDLE_MS) indexes.delete(u); }, 5 * 60e3).unref();
