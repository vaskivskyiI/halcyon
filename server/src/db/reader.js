// Worker thread: read-only queries that scan much of the database (the AI backfill checks), on their own connection —
// WAL lets them read while the main thread writes — so they do not hold up requests. See readAll in db/index.js. It also
// checkpoints the write-ahead log.
import Database from 'better-sqlite3';
import { workerData } from 'node:worker_threads';
import { serve } from '../util/workers.js';

const db = new Database(workerData.dbPath, { fileMustExist: true });
db.pragma('busy_timeout = 5000');
db.pragma('cache_size = -32768');
// Writes the log back into the database file (see wal_autocheckpoint in db/index.js); never blocks a writer.
const checkpoint = db.prepare('PRAGMA wal_checkpoint(PASSIVE)');
db.pragma('query_only = ON');
const cache = new Map();

serve({
  checkpoint: () => checkpoint.get(),
  all({ sql, params }) {
    let s = cache.get(sql);
    if (!s) { if (cache.size > 200) cache.clear(); cache.set(sql, (s = db.prepare(sql))); }
    return s.all(...params);
  },
});
