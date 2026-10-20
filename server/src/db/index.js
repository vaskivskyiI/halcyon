import Database from 'better-sqlite3';
import { config } from '../config.js';
import { migrations } from './schema.js';

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const current = db.pragma('user_version', { simple: true });
for (let v = current; v < migrations.length; v++) {
  db.transaction(() => {
    db.exec(migrations[v]);
    db.pragma(`user_version = ${v + 1}`);
  })();
}

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
