// Permanent deletion can be undone for a while: the messages come back with the same id, search text and analysis;
// the deletion reaches the mail server only when the hold ends.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r85-test-'));
process.env.HALCYON_LOG_LEVEL = 'error';

let db, A, account, trash;
before(async () => {
  ({ db } = await import('../src/db/index.js'));
  A = await import('../src/mail/actions.js');
  const u = db.prepare("INSERT INTO users (email, name, created_at) VALUES ('me@example.org', 'Me', ?)").run(Date.now()).lastInsertRowid;
  const a = db.prepare("INSERT INTO accounts (user_id, email, imap_host, imap_port, sync_enabled, created_at) VALUES (?, 'me@example.org', '127.0.0.1', 1, 0, ?)").run(u, Date.now());
  account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(a.lastInsertRowid);
  trash = db.prepare('SELECT * FROM folders WHERE id = ?').get(db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'Trash', 'Trash', '\\Trash')").run(account.id).lastInsertRowid);
});

const add = (uid, subject) => {
  const id = Number(db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, thread_id, subject, from_addr, date, body_text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'x@example.org', ?, 'body', ?)`).run(account.user_id, account.id, trash.id, uid, `m${uid}@x`, `t${uid}`, subject, Date.now(), Date.now()).lastInsertRowid);
  db.prepare("INSERT INTO messages_fts (rowid, subject, sender, recipients, body) VALUES (?, ?, 'x@example.org', '', 'body')").run(id, subject);
  db.prepare("INSERT INTO ai_insights (message_id, summary) VALUES (?, 'sum')").run(id);
  return id;
};
const deleteOps = () => db.prepare("SELECT * FROM pending_ops WHERE op = 'delete'").all();

test('deleted at once, back with the same id, search text and analysis; nothing sent to the server', () => {
  const id = add(11, 'Quarterly zebra report');
  const held = A.deletePermanently(account.user_id, [id]);
  assert.equal(held.length, 1);
  assert.equal(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(id), undefined);
  assert.equal(deleteOps().length, 0, 'the mail server is not asked yet');
  assert.equal(A.undeleteMessages(account.user_id, held), 1);
  assert.equal(db.prepare('SELECT subject FROM messages WHERE id = ?').get(id).subject, 'Quarterly zebra report');
  assert.equal(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'zebra'").get().rowid, id);
  assert.equal(db.prepare('SELECT summary FROM ai_insights WHERE message_id = ?').get(id).summary, 'sum');
  assert.equal(db.prepare('SELECT total FROM folders WHERE id = ?').get(trash.id).total, 1);
  assert.equal(A.undeleteMessages(account.user_id, held), 0, 'only once');
});

test('another user cannot undo it; after the hold the deletion goes to the server', () => {
  const id = add(12, 'Gone for good');
  const held = A.deletePermanently(account.user_id, [id]);
  assert.equal(A.undeleteMessages(account.user_id + 99, held), 0);
  assert.equal(A.finishDeletes(Date.now()), 0, 'still on hold');
  assert.equal(A.finishDeletes(Date.now() + A.DELETE_HOLD_MS + 1), 1);
  const op = deleteOps().at(-1);
  assert.deepEqual(JSON.parse(op.payload_json), { folder: 'Trash', uids: [12] });
  assert.equal(A.undeleteMessages(account.user_id, held), 0, 'too late');
});
