// Read-only sessions (for looking at real mail without any risk) and the diagnostics page (numbers, no content).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r24-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, db, uid, account, inbox, msg;
async function call(cookie, method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  return { status: r.status, data: await r.json().catch(() => null), cookie: sc ? sc.split(';')[0] : cookie };
}

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  await call('', 'POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, 'me@example.org', 0, ?)").run(uid, Date.now()).lastInsertRowid);
  inbox = db.prepare('SELECT * FROM folders WHERE id = ?').get(db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'INBOX', '\\Inbox')").run(account.id).lastInsertRowid);
  msg = Number(db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, thread_id, subject, from_name, from_addr, to_json, cc_json, date, body_text, is_read, created_at)
    VALUES (?, ?, ?, 1, 'secret@x', 't1', 'Secret salary negotiation', 'Ana Novak', 'ana@private.example', '[]', '[]', ?, 'Very private text', 0, ?)`).run(uid, account.id, inbox.id, Date.now(), Date.now()).lastInsertRowid);
  db.prepare("INSERT INTO pending_ops (account_id, op, payload_json, attempts, error, created_at) VALUES (?, 'append', '{}', 2, 'NO [ALERT] Mailbox \"Sent Items\" for ana@private.example is full', ?)").run(account.id, Date.now());
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('a read-only session can read but the server refuses every change', async () => {
  const ro = await call('', 'POST', '/api/auth/login', { email: 'me@example.org', password: 'password123', readOnly: true });
  assert.equal(ro.status, 200);
  const c = ro.cookie;
  assert.equal((await call(c, 'GET', '/api/auth/status')).data.readOnly, true);
  // Reading works.
  assert.equal((await call(c, 'GET', `/api/messages/${msg}`)).status, 200);
  assert.equal((await call(c, 'GET', '/api/messages?view=unified')).status, 200);
  // Every kind of change is refused, before the route runs.
  for (const [method, url, body] of [
    ['POST', '/api/messages/actions', { ids: [msg], action: 'trash' }],
    ['POST', '/api/messages/actions', { ids: [msg], action: 'read' }],
    ['POST', '/api/send', { accountId: account.id, to: [{ address: 'x@y.example' }], subject: 's', html: 'h' }],
    ['PATCH', '/api/settings', { ai: { enabled: false } }],
    ['DELETE', `/api/drafts/1`],
    ['POST', '/api/ai/ask', { question: 'delete everything' }],
    ['POST', '/api/auth/password', { current: 'password123', password: 'newpassword1' }],
    ['GET', `/api/messages/${msg}/insight?wait=1`],
    ['GET', '/api/oauth/google/start'],
  ]) {
    const r = await call(c, method, url, body);
    assert.equal(r.status, 403, `${method} ${url}`);
    assert.equal(r.data.readOnly, true);
  }
  const m = db.prepare('SELECT is_read, folder_id FROM messages WHERE id = ?').get(msg);
  assert.deepEqual([m.is_read, m.folder_id], [0, inbox.id]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 0);
  // It cannot be switched back from inside; signing out works.
  assert.equal((await call(c, 'POST', '/api/auth/read-only')).status, 200);
  assert.equal((await call(c, 'GET', '/api/auth/status')).data.readOnly, true);
  assert.equal((await call(c, 'POST', '/api/auth/logout')).status, 200);
  // A normal session is unaffected; it can make itself read-only.
  const rw = await call('', 'POST', '/api/auth/login', { email: 'me@example.org', password: 'password123' });
  assert.equal((await call(rw.cookie, 'POST', '/api/messages/actions', { ids: [msg], action: 'flag' })).status, 200);
  await call(rw.cookie, 'POST', '/api/auth/read-only');
  assert.equal((await call(rw.cookie, 'POST', '/api/messages/actions', { ids: [msg], action: 'unflag' })).status, 403);
});

test('diagnostics give numbers without mail content, names or addresses', async () => {
  const s = await call('', 'POST', '/api/auth/login', { email: 'me@example.org', password: 'password123', readOnly: true });
  const r = await call(s.cookie, 'GET', '/api/diagnostics');
  assert.equal(r.status, 200, 'available in a read-only session');
  const text = JSON.stringify(r.data);
  for (const secret of ['Secret salary', 'Very private', 'Ana Novak', 'ana@private.example', 'me@example.org', 'Sent Items']) assert.ok(!text.includes(secret), secret);
  assert.equal(r.data.accounts[0].messages, 1);
  assert.equal(r.data.accounts[0].pendingServerChanges[0].op, 'append');
  assert.match(r.data.accounts[0].lastPendingError, /<address>/);
  assert.ok(r.data.folders.find((f) => f.folder === '\\Inbox').unread === 1);
  assert.ok(r.data.requests.routes.some((x) => x.route === 'GET /api/messages/:id'), 'request timings recorded');
});
