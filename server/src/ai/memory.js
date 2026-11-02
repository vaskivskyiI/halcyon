// AI memory: embedded chunks of messages, conversation summaries, events, contacts and facts (table `memory`).
// Vectors live in SQLite (float32) and are loaded per user on first use into one int8-quantised array (4x smaller than
// float32, ~1 KB per chunk at 768 dims) in a worker thread; indexes of users idle for 30 min are dropped, so a
// multi-user server only holds the active users in RAM. Every entry carries an owner key, which is how searches are
// scoped to a space.
import { all, run, tx, now } from '../db/index.js';
import { config } from '../config.js';
import { workerPool } from '../util/workers.js';
import { logger } from '../util/log.js';

const log = logger('memory');

// The index and the search live in a worker thread (vector-worker.js); this thread writes the rows and tells it.
const vectors = workerPool(new URL('./vector-worker.js', import.meta.url), { name: 'AI memory search', workerData: { dbPath: config.dbPath } });

export function normalize(v) {
  const f = Float32Array.from(v);
  let n = 0;
  for (let i = 0; i < f.length; i++) n += f[i] * f[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < f.length; i++) f[i] /= n;
  return f;
}

/** Replaces the memory of one item (all its chunks). chunks: [{ text, vector }] */
export function storeMemory(userId, { kind, ref, owner, date, model, chunks }) {
  ref = String(ref);
  const added = [];
  let gone = [];
  tx(() => {
    gone = all('SELECT id FROM memory WHERE user_id = ? AND kind = ? AND ref_id = ?', userId, kind, ref).map((r) => r.id);
    run('DELETE FROM memory WHERE user_id = ? AND kind = ? AND ref_id = ?', userId, kind, ref);
    chunks.forEach((c, i) => {
      const f = normalize(c.vector);
      const r = run('INSERT INTO memory (user_id, kind, ref_id, chunk, owner, text, date, model, dim, vector, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        userId, kind, ref, i, owner, c.text, date || null, model, f.length, Buffer.from(f.buffer), now());
      added.push({ id: Number(r.lastInsertRowid), kind, ref, chunk: i, owner, f });
    });
  });
  if (gone.length) vectors.post('kill', { userId, ids: gone });
  if (added.length) vectors.post('add', { userId, model, rows: added });
}

export function removeMemory(userId, kind, refs) {
  const gone = [];
  for (const ref of refs) {
    for (const r of all('SELECT id FROM memory WHERE user_id = ? AND kind = ? AND ref_id = ?', userId, kind, String(ref))) gone.push(r.id);
    run('DELETE FROM memory WHERE user_id = ? AND kind = ? AND ref_id = ?', userId, kind, String(ref));
  }
  if (gone.length) vectors.post('kill', { userId, ids: gone });
}

/**
 * Nearest chunks to a query vector. owners: Set of owner keys allowed (null = all, i.e. unscoped);
 * kinds: Set of kinds (null = all). Resolves to [{ id, kind, ref, chunk, owner, score }] best first.
 */
export function searchMemory(userId, vector, model, { k = 20, owners = null, kinds = null, minScore = 0.2 } = {}) {
  // Should the worker fail, nothing is found this time (the next search starts a new one, which reloads the index).
  return vectors.call('search', { userId, vector: normalize(vector), model, k, owners, kinds, minScore }).catch((e) => { log.warn(`memory search: ${e.message}`); return []; });
}

export function memoryText(ids) {
  if (!ids.length) return new Map();
  return new Map(all(`SELECT id, text FROM memory WHERE id IN (${ids.map(Number).join(',')})`).map((r) => [r.id, r.text]));
}

export function invalidate(userId) { vectors.post('invalidate', { userId }); }
export function invalidateAll() { vectors.post('invalidate', { userId: null }); }

export async function memoryStats(userId) {
  const rows = all('SELECT kind, model, COUNT(*) AS n, COUNT(DISTINCT ref_id) AS items FROM memory WHERE user_id = ? GROUP BY kind, model', userId);
  return { rows, loaded: await vectors.call('stats', { userId }).catch(() => null) };
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
