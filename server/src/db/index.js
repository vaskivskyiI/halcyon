import Database from 'better-sqlite3';
import { config } from '../config.js';
import { migrations } from './schema.js';

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
// 64 MB of pages kept in memory (the default is 2 MB): the list and count indexes of a large mailbox stay cached.
db.pragma('cache_size = -65536');
/** Text for comparing: lower case without accents (č → c, š → s, ž → z), so a search may leave them out. */
export const fold = (s) => (s == null ? s : String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase());
db.function('fold', { deterministic: true }, fold);

const current = db.pragma('user_version', { simple: true });
// Foreign keys are off while migrating: a table rebuilt (copied, dropped, renamed) would otherwise take the rows that
// point at it along when the old one is dropped.
if (current < migrations.length) db.pragma('foreign_keys = OFF');
for (let v = current; v < migrations.length; v++) {
  if (/DROP TABLE messages;/.test(migrations[v])) console.log(`Halcyon: reorganising the mail store (database update ${v + 1}); with a large mailbox this takes a few minutes`);
  db.transaction(() => {
    db.exec(migrations[v]);
    db.pragma(`user_version = ${v + 1}`);
  })();
}
db.pragma('foreign_keys = ON');
// A database that ran the Android app branch before it was merged had that branch's migration as number 38 and so
// skipped this repository's 38 (automatic retries): its columns are added now.
if (!db.prepare('PRAGMA table_info(pending_ops)').all().some((c) => c.name === 'auto_retries')) db.exec(migrations[37]); // "38" in schema.js (1-based)
// Table statistics let SQLite pick the list/count indexes; cheap, and only redone when the data changed a lot.
db.pragma('optimize = 0x10002');

// Statement cache helpers.
const cache = new Map();
const stmt = (sql) => {
  let s = cache.get(sql);
  if (!s) {
    // Scoped queries embed id lists, so the SQL text varies; keep the cache bounded on long-running servers.
    if (cache.size > 1000) cache.clear();
    s = db.prepare(sql); cache.set(sql, s);
  }
  return s;
};
export const all = (sql, ...p) => stmt(sql).all(...p);
export const get = (sql, ...p) => stmt(sql).get(...p);
export const run = (sql, ...p) => stmt(sql).run(...p);
export const tx = (fn) => db.transaction(fn)();

export const json = (s, fallback = null) => {
  if (s == null || s === '') return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};
export const now = () => Date.now();

// Generic partial UPDATE from an object of allowed columns.
export function update(table, id, fields, allowed) {
  const keys = Object.keys(fields).filter((k) => allowed.includes(k) && fields[k] !== undefined);
  if (!keys.length) return;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...keys.map((k) => fields[k]), id);
}
