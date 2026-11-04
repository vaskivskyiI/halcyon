// Reading an email also reads its copies in other accounts (the conversation shows them as one message, unread while
// any copy is); search in conversation view lists each conversation once.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r86-test-'));
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, uid, ingestMessage, n = 0;
const acc = {};
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
async function mail(account, { id, subject, body, refs = '' }) {
  const folder = db.prepare("SELECT * FROM folders WHERE account_id = ? AND path = 'INBOX'").get(account.id);
  const raw = `Message-ID: <${id}@x>\r\n${refs ? `In-Reply-To: <${refs}@x>\r\nReferences: <${refs}@x>\r\n` : ''}From: ana@x.example\r\nTo: ${account.email}\r\nSubject: ${subject}\r\n`
    + `Date: ${new Date(Date.now() - 3600e3 + ++n * 60e3).toUTCString()}\r\nContent-Type: text/plain\r\n\r\n${body}\r\n`;
  return (await ingestMessage({ account, folder, uid: n, flags: [], raw: Buffer.from(raw) })).id;
}

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  ({ ingestMessage } = await import('../src/mail/store.js'));
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  await api('PATCH', '/api/settings', { ai: { enabled: false }, ui: { conversationView: true } });
  for (const [k, email] of [['home', 'me@example.org'], ['work', 'work@ijs.example']]) {
    acc[k] = db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare('INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, ?, 0, ?)').run(uid, email, Date.now()).lastInsertRowid);
    db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'INBOX', '\\Inbox')").run(acc[k].id);
  }
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

const isRead = (id) => !!db.prepare('SELECT is_read FROM messages WHERE id = ?').get(id).is_read;

test('reading an email reads its copy in another account, so the conversation does not stay unread', async () => {
  const a = await mail(acc.home, { id: 'fwd1', subject: 'Budget', body: 'numbers' });
  const b = await mail(acc.work, { id: 'fwd1', subject: 'Budget', body: 'numbers' });
  const tid = db.prepare('SELECT thread_id FROM messages WHERE id = ?').get(a).thread_id;
  const shown = (await api('GET', `/api/threads/${encodeURIComponent(tid)}`)).messages;
  assert.equal(shown.length, 1, 'the copies are one message');
  await api('POST', '/api/messages/actions', { ids: [shown[0].id], action: 'read' });
  assert.ok(isRead(a) && isRead(b));
  assert.equal((await api('GET', `/api/threads/${encodeURIComponent(tid)}`)).messages[0].isRead, true);
  await api('POST', '/api/messages/actions', { ids: [a], action: 'unread' });
  assert.ok(!isRead(a) && !isRead(b));
});

test('search in conversation view lists a conversation once, however many of its messages match', async () => {
  await mail(acc.home, { id: 'z1', subject: 'Zebra crossing', body: 'zebra one' });
  await mail(acc.home, { id: 'z2', subject: 'Re: Zebra crossing', body: 'zebra two', refs: 'z1' });
  await mail(acc.home, { id: 'z3', subject: 'Re: Zebra crossing', body: 'zebra three', refs: 'z2' });
  await mail(acc.home, { id: 'z9', subject: 'Other zebra', body: 'zebra elsewhere' });
  const r = await api('GET', '/api/messages?view=unified&q=zebra&semantic=0');
  assert.equal(r.items.length, 2);
  const conv = r.items.find((m) => m.threadCount === 3);
  assert.ok(conv, 'the conversation, counted whole');
  assert.equal(conv.threadUnread, 3);
  const flat = await api('GET', '/api/messages?view=unified&q=zebra&semantic=0&threads=0');
  assert.equal(flat.items.length, 4, 'one row per message without conversation view');
});

test('an autosave that arrives after Send does not bring the sent draft back', async () => {
  const d = await api('POST', '/api/drafts', { accountId: acc.home.id, to: [{ address: 'ana@x.example' }], subject: 'Late', html: '<p>hi</p>' });
  await api('POST', '/api/send', { accountId: acc.home.id, to: [{ address: 'ana@x.example' }], subject: 'Late', html: '<p>hi</p>', draftId: d.id });
  const late = await api('POST', '/api/drafts', { id: d.id, accountId: acc.home.id, to: [{ address: 'ana@x.example' }], subject: 'Late', html: '<p>hi</p>' });
  assert.equal(late.sent, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM drafts').get().n, 0);
});
