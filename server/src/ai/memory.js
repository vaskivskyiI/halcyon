// AI memory: embedded chunks of messages, conversation summaries, events, contacts and facts (table `memory`).
// Vectors live in SQLite (float32) and are loaded per user on first use into one int8-quantised array (4x smaller than
// float32, ~1 KB per chunk at 768 dims); indexes of users idle for 30 min are dropped, so a multi-user server only
// holds the active users in RAM. Every entry carries an owner key, which is how searches are scoped to a space.
import { db, all, run, tx, now } from '../db/index.js';

const indexes = new Map(); // userId -> index
const IDLE_MS = 30 * 60e3;
const Q = 127;

export function normalize(v) {
  const f = Float32Array.from(v);
  let n = 0;
  for (let i = 0; i < f.length; i++) n += f[i] * f[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < f.length; i++) f[i] /= n;
  return f;
}

function quantize(f, out, offset) {
  for (let i = 0; i < f.length; i++) out[offset + i] = Math.max(-Q, Math.min(Q, Math.round(f[i] * Q)));
}

function newIndex(model, dim) {
  return { model, dim, size: 0, cap: 0, q: new Int8Array(0), meta: [], slots: new Map(), dead: 0, used: Date.now() };
}

function push(idx, rowId, meta, f) {
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

function kill(idx, s, rowId) {
  idx.meta[s] = null;
  idx.slots.delete(rowId);
  idx.dead++;
}

// Many deleted slots: drop the index; the next search reloads a compact one from SQLite.
function compact(userId) {
  const idx = indexes.get(userId);
  if (idx && idx.dead > 1000 && idx.dead > idx.size / 3) indexes.delete(userId);
}

function load(userId, model) {
  let idx = indexes.get(userId);
  if (idx && idx.model === model) { idx.used = Date.now(); return idx; }
  idx = newIndex(model, 0);
  for (const r of db.prepare('SELECT id, kind, ref_id, chunk, owner, dim, vector FROM memory WHERE user_id = ? AND model = ?').iterate(userId, model)) {
    if (!idx.dim) idx.dim = r.dim;
    if (r.dim !== idx.dim) continue;
    push(idx, r.id, { kind: r.kind, ref: r.ref_id, chunk: r.chunk, owner: r.owner }, new Float32Array(r.vector.buffer.slice(r.vector.byteOffset, r.vector.byteOffset + r.dim * 4)));
  }
  indexes.set(userId, idx);
  return idx;
}

/** Replaces the memory of one item (all its chunks). chunks: [{ text, vector }] */
export function storeMemory(userId, { kind, ref, owner, date, model, chunks }) {
  ref = String(ref);
  const idx = indexes.get(userId);
  tx(() => {
    for (const r of all('SELECT id FROM memory WHERE user_id = ? AND kind = ? AND ref_id = ?', userId, kind, ref)) {
      const s = idx?.slots.get(r.id);
      if (s != null) kill(idx, s, r.id);
    }
    run('DELETE FROM memory WHERE user_id = ? AND kind = ? AND ref_id = ?', userId, kind, ref);
    chunks.forEach((c, i) => {
      const f = normalize(c.vector);
      const r = run('INSERT INTO memory (user_id, kind, ref_id, chunk, owner, text, date, model, dim, vector, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        userId, kind, ref, i, owner, c.text, date || null, model, f.length, Buffer.from(f.buffer), now());
      if (idx && idx.model === model && (!idx.dim || idx.dim === f.length)) {
        if (!idx.dim) idx.dim = f.length;
        push(idx, Number(r.lastInsertRowid), { kind, ref, chunk: i, owner }, f);
      }
    });
  });
  compact(userId);
}

export function removeMemory(userId, kind, refs) {
  const idx = indexes.get(userId);
  for (const ref of refs) {
    for (const r of all('SELECT id FROM memory WHERE user_id = ? AND kind = ? AND ref_id = ?', userId, kind, String(ref))) {
      const s = idx?.slots.get(r.id);
      if (s != null) kill(idx, s, r.id);
    }
    run('DELETE FROM memory WHERE user_id = ? AND kind = ? AND ref_id = ?', userId, kind, String(ref));
  }
  compact(userId);
}

/**
 * Nearest chunks to a query vector. owners: Set of owner keys allowed (null = all, i.e. unscoped);
 * kinds: Set of kinds (null = all). Returns [{ id, kind, ref, chunk, owner, score }] best first.
 */
export function searchMemory(userId, vector, model, { k = 20, owners = null, kinds = null, minScore = 0.2 } = {}) {
  const idx = load(userId, model);
  if (!idx.size) return [];
  const f = normalize(vector);
  if (f.length !== idx.dim) return [];
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
}

export function memoryText(ids) {
  if (!ids.length) return new Map();
  return new Map(all(`SELECT id, text FROM memory WHERE id IN (${ids.map(Number).join(',')})`).map((r) => [r.id, r.text]));
}

export function invalidate(userId) { indexes.delete(userId); }
export function invalidateAll() { indexes.clear(); }

export function memoryStats(userId) {
  const rows = all('SELECT kind, model, COUNT(*) AS n, COUNT(DISTINCT ref_id) AS items FROM memory WHERE user_id = ? GROUP BY kind, model', userId);
  const idx = indexes.get(userId);
  return { rows, loaded: idx ? { model: idx.model, chunks: idx.slots.size, bytes: idx.q.byteLength } : null };
}

/** Splits text into overlapping chunks on paragraph/sentence boundaries. */
export function chunkText(text, { size = 1400, overlap = 200, max = 6 } = {}) {
  const t = String(text || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (t.length <= size) return [t];
  const out = [];
  let start = 0;
  while (start < t.length && out.length < max) {
    let end = Math.min(t.length, start + size);
    if (end < t.length) {
      const cut = Math.max(t.lastIndexOf('\n\n', end), t.lastIndexOf('. ', end));
      if (cut > start + size / 2) end = cut + 1;
    }
    out.push(t.slice(start, end).trim());
    if (end >= t.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out;
}

setInterval(() => { for (const [u, idx] of indexes) if (Date.now() - idx.used > IDLE_MS) indexes.delete(u); }, 5 * 60e3).unref();
