// In-memory semantic index per user (unit-normalised Float32 vectors; cosine = dot product).
import { db, get, run } from '../db/index.js';

const indexes = new Map(); // userId -> { model, dim, ids: number[], vecs: Float32Array[] }

export function normalize(v) {
  const f = Float32Array.from(v);
  let n = 0;
  for (let i = 0; i < f.length; i++) n += f[i] * f[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < f.length; i++) f[i] /= n;
  return f;
}

function load(userId) {
  let idx = indexes.get(userId);
  if (idx) return idx;
  idx = { model: null, dim: 0, ids: [], vecs: [], pos: new Map() };
  for (const r of db.prepare('SELECT message_id, model, dim, vector FROM embeddings WHERE user_id = ?').iterate(userId)) {
    if (idx.model && r.model !== idx.model) continue;
    idx.model = r.model; idx.dim = r.dim;
    idx.pos.set(r.message_id, idx.ids.length);
    idx.ids.push(r.message_id);
    idx.vecs.push(new Float32Array(r.vector.buffer, r.vector.byteOffset, r.dim));
  }
  indexes.set(userId, idx);
  return idx;
}

export function storeEmbedding(userId, messageId, model, vector) {
  const v = normalize(vector);
  run('INSERT OR REPLACE INTO embeddings (message_id, user_id, model, dim, vector) VALUES (?, ?, ?, ?, ?)', messageId, userId, model, v.length, Buffer.from(v.buffer));
  const idx = indexes.get(userId);
  if (!idx) return;
  if (idx.model && idx.model !== model) { indexes.delete(userId); return; }
  idx.model = model; idx.dim = v.length;
  if (idx.pos.has(messageId)) idx.vecs[idx.pos.get(messageId)] = v;
  else { idx.pos.set(messageId, idx.ids.length); idx.ids.push(messageId); idx.vecs.push(v); }
}

export function search(userId, queryVec, model, k = 20, allow = null) {
  const idx = load(userId);
  if (!idx.ids.length || idx.model !== model) return [];
  const q = normalize(queryVec);
  if (q.length !== idx.dim) return [];
  const scored = [];
  for (let i = 0; i < idx.ids.length; i++) {
    if (allow && !allow.has(idx.ids[i])) continue;
    const v = idx.vecs[i];
    let s = 0;
    for (let j = 0; j < v.length; j++) s += v[j] * q[j];
    scored.push([idx.ids[i], s]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  // Drop rows whose messages were deleted.
  return scored.slice(0, k * 2).filter(([id]) => get('SELECT 1 AS x FROM messages WHERE id = ?', id)).slice(0, k).map(([id, score]) => ({ id, score }));
}

export function invalidate(userId) { indexes.delete(userId); }
export function indexStats(userId) { const i = load(userId); return { count: i.ids.length, model: i.model, dim: i.dim }; }
