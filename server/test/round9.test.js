// Sent mail and drafts kept on the server, nothing lost when that fails, and problems that are never silent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startSmtp } from './helpers.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r9-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';
process.env.HALCYON_TLS_INSECURE = '1';

let app, base, cookie = '', db, account, uid, smtp, sent, AccountSync;

async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
const waitFor = async (fn, ms = 10000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 50)); } };
const ops = (op) => db.prepare('SELECT * FROM pending_ops WHERE op = ? ORDER BY id').all(op).map((o) => ({ ...o, p: JSON.parse(o.payload_json) }));

before(async () => {
  smtp = await startSmtp(0);
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  ({ AccountSync } = await import('../src/mail/sync.js'));
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  await api('PATCH', '/api/settings', { mail: { undoSendSeconds: 0 }, ai: { enabled: false } });
  account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare(`INSERT INTO accounts (user_id, email, imap_host, imap_port, smtp_host, smtp_port, smtp_secure, smtp_user, sync_enabled, created_at)
    VALUES (?, 'me@example.org', '127.0.0.1', 1, '127.0.0.1', ?, 0, 'me', 0, ?)`).run(uid, smtp.port, Date.now()).lastInsertRowid);
  const { encrypt } = await import('../src/util/crypto.js');
  db.prepare('UPDATE accounts SET smtp_pass_enc = ? WHERE id = ?').run(encrypt('secret'), account.id);
  db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'INBOX', '\\Inbox')").run(account.id);
  // A server without SPECIAL-USE, Slovenian names under the INBOX. namespace.
  sent = db.prepare('SELECT * FROM folders WHERE id = ?').get(db.prepare("INSERT INTO folders (account_id, path, name) VALUES (?, 'INBOX.Poslani elementi', 'Poslani elementi')").run(account.id).lastInsertRowid);
  db.prepare("INSERT INTO folders (account_id, path, name) VALUES (?, 'INBOX.Osnutki', 'Osnutki')").run(account.id);
});
after(async () => { await app?.close(); smtp?.close?.(); setTimeout(() => process.exit(0), 50).unref(); });

let localId;
test('a sent message is stored in the server\'s Sent folder (found by its localised name) and kept locally meanwhile', async () => {
  await api('POST', '/api/send', { accountId: account.id, to: ['ana@company.example'], subject: 'Offer', html: '<p>Here it is</p>' });
  const op = await waitFor(() => ops('append')[0]);
  assert.equal(op.p.folder, 'INBOX.Poslani elementi');
  localId = op.p.localId;
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(localId);
  assert.equal(m.folder_id, sent.id); assert.equal(m.local_copy, 1); assert.equal(m.uid, null);
  const item = (await api('GET', `/api/messages/${localId}`));
  assert.equal(item.notOnServer, true);
});

test('when storing it on the server fails, the local copy is never cleaned up and the problem is reported', async () => {
  db.prepare("UPDATE pending_ops SET attempts = 5, error = 'NO without a reason from the server' WHERE op = 'append'").run();
  db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(Date.now() - 3600e3, localId);
  new AccountSync(account.id).reconcileOrphans();
  assert.ok(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(localId), 'still there');
  const { problems } = await api('GET', '/api/status/problems');
  assert.ok(problems.some((p) => p.key.startsWith('op:') && p.level === 'error' && p.actions.includes('retry-op')));
  db.prepare("DELETE FROM pending_ops WHERE op = 'append'").run(); // e.g. dismissed
  const again = (await api('GET', '/api/status/problems')).problems.find((p) => p.key.startsWith('unsaved:'));
  assert.match(again.title, /1 sent message is not saved on the server/);
  const r = await api('POST', '/api/messages/save-to-server', { all: true });
  assert.equal(r.queued, 1);
  assert.equal(ops('append')[0].p.localId, localId);
  assert.ok(!(await api('GET', '/api/status/problems')).problems.some((p) => p.key.startsWith('unsaved:')), 'queued again: no longer reported');
});

test('the server copy is matched to the local one (no duplicate), also when it went to another folder', async () => {
  const w = new AccountSync(account.id);
  w.syncFolderList = async () => { db.prepare("INSERT OR IGNORE INTO folders (account_id, path, name, special_use) VALUES (?, 'Sent Items', 'Sent Items', '\\Sent')").run(account.id); };
  const appended = [];
  w.client = {
    async append(folder, raw) { if (folder === 'INBOX.Poslani elementi') { const e = new Error('Command failed'); e.responseStatus = 'NO'; throw e; } appended.push(folder); },
    async list() { return [{ path: 'INBOX' }, { path: 'Sent Items', specialUse: '\\Sent' }]; },
  };
  const op = ops('append')[0];
  await w.applyOp('append', op.p);
  assert.deepEqual(appended, ['Sent Items']);
  const target = db.prepare("SELECT id FROM folders WHERE path = 'Sent Items'").get();
  assert.equal(db.prepare('SELECT folder_id FROM messages WHERE id = ?').get(localId).folder_id, target.id, 'local copy moved along');
  const { ingestMessage } = await import('../src/mail/store.js');
  const raw = Buffer.from(op.p.raw, 'base64');
  const r = await ingestMessage({ account, folder: db.prepare('SELECT * FROM folders WHERE id = ?').get(target.id), uid: 77, flags: ['\\Seen'], raw });
  assert.equal(r.id, localId); assert.equal(r.isNew, false);
  const m = db.prepare('SELECT uid, local_copy FROM messages WHERE id = ?').get(localId);
  assert.deepEqual({ ...m }, { uid: 77, local_copy: 0 });
});

test('folders created on the server are subscribed, so other mail apps show them', async () => {
  const w = new AccountSync(account.id);
  const calls = [];
  w.client = { async mailboxCreate(p) { calls.push(`create ${p}`); }, async mailboxSubscribe(p) { calls.push(`subscribe ${p}`); } };
  await w.createMailbox('Sent');
  assert.deepEqual(calls, ['create Sent', 'subscribe Sent']);
});

test('drafts are saved to the server automatically, the new copy before the old one is removed', async () => {
  const { syncDraftsToServer } = await import('../src/mail/send.js');
  db.prepare('DELETE FROM pending_ops').run();
  const d = await api('POST', '/api/drafts', { accountId: account.id, to: ['ana@company.example'], subject: 'Draft 1', html: '<p>v1</p>' });
  await syncDraftsToServer();
  assert.equal(ops('append').length, 0, 'not while still being edited');
  db.prepare('UPDATE drafts SET updated_at = ? WHERE id = ?').run(Date.now() - 60e3, d.id);
  await syncDraftsToServer();
  const first = ops('append');
  assert.equal(first.length, 1); assert.equal(first[0].p.folder, 'INBOX.Osnutki'); assert.ok(first[0].p.flags.includes('\\Draft'));
  await syncDraftsToServer();
  assert.equal(ops('append').length, 1, 'unchanged draft is not stored again');
  await api('POST', '/api/drafts', { id: d.id, accountId: account.id, to: ['ana@company.example'], subject: 'Draft 1', html: '<p>v2</p>' });
  db.prepare('UPDATE drafts SET updated_at = ? WHERE id = ?').run(Date.now() - 60e3, d.id);
  await syncDraftsToServer();
  const all = db.prepare("SELECT op FROM pending_ops ORDER BY id").all().map((o) => o.op);
  assert.deepEqual(all, ['append', 'append', 'deleteByMessageId']);
});

test('a message that could not be sent can be sent again or kept as a draft; an interrupted send is not repeated by itself', async () => {
  const { processOutbox } = await import('../src/mail/send.js');
  const o = db.prepare("INSERT INTO outbox (user_id, account_id, payload_json, send_at, status, attempts, error, created_at) VALUES (?, ?, ?, ?, 'failed', 5, 'Mailbox unavailable', ?)")
    .run(uid, account.id, JSON.stringify({ accountId: account.id, to: ['x@y.example'], subject: 'Quote', html: '<p>hi</p>' }), Date.now(), Date.now()).lastInsertRowid;
  const p = (await api('GET', '/api/status/problems')).problems.find((x) => x.outboxId === Number(o));
  assert.equal(p.level, 'error'); assert.deepEqual(p.actions, ['retry-send', 'to-draft']);
  const r = await api('POST', `/api/outbox/${o}/to-draft`, {});
  assert.ok(db.prepare('SELECT 1 FROM drafts WHERE id = ?').get(r.draftId));
  assert.equal(db.prepare('SELECT 1 FROM outbox WHERE id = ?').get(o), undefined);
  const s = db.prepare("INSERT INTO outbox (user_id, account_id, payload_json, send_at, status, created_at) VALUES (?, ?, '{}', ?, 'sending', ?)").run(uid, account.id, Date.now(), Date.now()).lastInsertRowid;
  await processOutbox();
  const row = db.prepare('SELECT status, error FROM outbox WHERE id = ?').get(s);
  assert.equal(row.status, 'failed'); assert.match(row.error, /interrupted/);
});
