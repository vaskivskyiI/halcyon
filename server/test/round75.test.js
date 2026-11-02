// The mail store keeps the bodies at the end of each message row: the columns lists and counts read are reached
// without walking the body's overflow pages. An existing database is rebuilt so, keeping ids and what points at them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrations } from '../src/db/schema.js';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r75-test-'));
process.env.HALCYON_LOG_LEVEL = 'error';

test('a database from before is rebuilt with the bodies last; messages, analyses and tags stay', async () => {
  const before = migrations.findIndex((m) => /DROP TABLE messages;/.test(m));
  const old = new Database(path.join(process.env.HALCYON_DATA_DIR, 'halcyon.db'));
  old.pragma('journal_mode = WAL');
  for (let v = 0; v < before; v++) old.exec(migrations[v]);
  old.pragma(`user_version = ${before}`);
  old.pragma('foreign_keys = ON');
  old.exec(`INSERT INTO users (id, email, name, created_at) VALUES (1, 'u@example.org', 'U', 0);
    INSERT INTO accounts (id, user_id, email, created_at) VALUES (1, 1, 'u@example.org', 0);
    INSERT INTO folders (id, account_id, path, name) VALUES (1, 1, 'INBOX', 'INBOX');
    INSERT INTO messages (id, user_id, account_id, folder_id, uid, subject, body_html, body_text, is_read, sender_json, subject_key, date)
      VALUES (42, 1, 1, 1, 7, 'Hello', '<p>${'x'.repeat(20000)}</p>', 'text', 1, '{"a":1}', 'hello', 1000);
    INSERT INTO ai_insights (message_id, summary) VALUES (42, 'sum');
    INSERT INTO custom_categories (id, user_id, name, created_at) VALUES (1, 1, 'C', 0);
    INSERT INTO message_tags (message_id, category_id, source) VALUES (42, 1, 'user');`);
  old.close();

  const { db } = await import('../src/db/index.js');
  assert.equal(db.pragma('user_version', { simple: true }), migrations.length);
  const cols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  assert.deepEqual(cols.slice(-2), ['body_text', 'body_html'], 'the bodies are the last columns');
  assert.ok(cols.indexOf('sender_json') < cols.indexOf('body_text') && cols.indexOf('subject_key') < cols.indexOf('body_text'));
  const m = db.prepare('SELECT * FROM messages WHERE id = 42').get();
  assert.equal(m.subject, 'Hello');
  assert.equal(m.body_html.length, 20007);
  assert.equal(m.is_read, 1);
  assert.equal(m.sender_json, '{"a":1}');
  assert.equal(db.prepare('SELECT summary FROM ai_insights WHERE message_id = 42').get()?.summary, 'sum', 'its analysis is kept');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM message_tags WHERE message_id = 42').get().n, 1, 'its tag is kept');
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'foreign keys are on again');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  // Deleting the message still takes what points at it along (the references follow the rebuilt table).
  db.prepare('DELETE FROM messages WHERE id = 42').run();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_insights').get().n, 0);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_messages_list'").get(), 'the indexes are made again');
  db.close();
});
