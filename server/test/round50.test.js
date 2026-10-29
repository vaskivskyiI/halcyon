// A database that ran the Android app branch before it was merged (its FCM table was migration 38 there) starts with
// today's schema: the skipped automatic-retry columns are added, the FCM table is kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r50-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

test('the pre-merge Android branch database is repaired on start', async () => {
  const { migrations } = await import('../src/db/schema.js');
  const old = new Database(path.join(dataDir, 'halcyon.db'));
  for (const m of migrations.slice(0, 37)) old.exec(m);
  old.exec(migrations[39]); // the branch's FCM table ("40" now), then numbered 38
  old.exec("INSERT INTO users (email, name) VALUES ('me@example.org', 'Me')");
  old.exec("INSERT INTO fcm_tokens (user_id, token, device) VALUES (1, 'kept-token-0123456789abcdef', 'Pixel')");
  old.pragma('user_version = 38');
  old.close();

  const { db } = await import('../src/db/index.js');
  assert.equal(db.pragma('user_version', { simple: true }), migrations.length);
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  assert.ok(cols('pending_ops').includes('next_retry_at'));
  assert.ok(cols('outbox').includes('auto_retries'));
  assert.ok(cols('pinned_threads').includes('thread_key'));
  assert.equal(db.prepare('SELECT token FROM fcm_tokens').get().token, 'kept-token-0123456789abcdef');
  db.close();
});
