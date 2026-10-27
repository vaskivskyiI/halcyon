// Outlook-style features: automatic replies (safely), ignore conversation, block sender, sweep, follow-up, quick
// steps, folder export.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r33-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, uid, account, inbox, n = 0, afterIngest, ingestMessage;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
// A real message (raw on disk), arriving in the Inbox through the normal pipeline.
async function arrive(from, subject, { headers = '', thread = null } = {}) {
  const raw = Buffer.from(`From: ${from}\r\nTo: me@example.org\r\nSubject: ${subject}\r\nMessage-ID: <r33-${++n}@x>\r\n${thread ? `In-Reply-To: <${thread}>\r\nReferences: <${thread}>\r\n` : ''}Date: ${new Date().toUTCString()}\r\n${headers}\r\nHello ${n}`);
  const r = await ingestMessage({ account, folder: inbox, uid: 1000 + n, flags: [], raw });
  await afterIngest(account, inbox, [r.id]);
  return r.id;
}
const outbox = () => db.prepare('SELECT payload_json FROM outbox').all().map((o) => JSON.parse(o.payload_json));

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  ({ afterIngest } = await import('../src/mail/pipeline.js'));
  ({ ingestMessage } = await import('../src/mail/store.js'));
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  await api('PATCH', '/api/settings', { ai: { autoAnalyze: false } });
  account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, 'me@example.org', 0, ?)").run(uid, Date.now()).lastInsertRowid);
  const folder = (p, s) => db.prepare('SELECT * FROM folders WHERE id = ?').get(db.prepare('INSERT INTO folders (account_id, path, name, special_use) VALUES (?, ?, ?, ?)').run(account.id, p, p, s).lastInsertRowid);
  inbox = folder('INBOX', '\\Inbox'); folder('Archive', '\\Archive'); folder('Junk', '\\Junk'); folder('Sent', '\\Sent');
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('automatic reply: once per sender, never to lists, automated mail, other auto-replies or the user', async () => {
  await assert.rejects(api('PUT', `/api/accounts/${account.id}/auto-reply`, { enabled: true, message: '' }), /Write the reply/);
  const cfg = await api('PUT', `/api/accounts/${account.id}/auto-reply`, { enabled: true, message: 'I am away until Monday.', subject: 'Away' });
  assert.equal(cfg.active, true);
  account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(account.id);
  await arrive('Ana <ana@x.example>', 'Question');
  await arrive('Ana <ana@x.example>', 'Another question');
  await arrive('News <news@shop.example>', 'Sale', { headers: 'List-Id: <sale.shop.example>\r\n' });
  await arrive('noreply@service.example', 'Your receipt');
  await arrive('Bob <bob@x.example>', 'Re: Away', { headers: 'Auto-Submitted: auto-replied\r\n' });
  await arrive('Me <me@example.org>', 'Note to self');
  const sent = outbox();
  assert.deepEqual(sent.map((p) => p.to[0].address), ['ana@x.example']);
  assert.equal(sent[0].autoReply, true); assert.equal(sent[0].subject, 'Away');
  const { buildMime } = await import('../src/mail/send.js');
  const raw = (await buildMime(account, sent[0])).toString();
  assert.match(raw, /Auto-Submitted: auto-replied/);
  await api('PUT', `/api/accounts/${account.id}/auto-reply`, { enabled: false, message: 'I am away until Monday.' });
  account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(account.id);
  await arrive('Cid <cid@x.example>', 'Hi');
  assert.equal(outbox().length, 1, 'switched off: no more replies');
});

test('ignore conversation: later messages are archived and read on arrival', async () => {
  const first = await arrive('Ana <ana@x.example>', 'Long thread');
  const t = db.prepare('SELECT thread_id FROM messages WHERE id = ?').get(first).thread_id;
  await api('POST', `/api/threads/${encodeURIComponent(t)}/mute`, { muted: true });
  assert.equal((await api('GET', `/api/threads/${encodeURIComponent(t)}/muted`)).muted, true);
  const later = await arrive('Ana <ana@x.example>', 'Re: Long thread', { thread: `r33-${n}@x` });
  const m = db.prepare('SELECT m.is_read, f.special_use FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.id = ?').get(later);
  assert.deepEqual([m.is_read, m.special_use], [1, '\\Archive']);
});

test('block sender (rule, existing mail to Junk), sweep, follow-up', async () => {
  const a = await arrive('Spammy <promo@spammy.example>', 'Deal 1');
  const r = await api('POST', '/api/senders/block', { address: 'promo@spammy.example', existing: true });
  assert.equal(r.moved, 1);
  assert.equal(db.prepare('SELECT f.special_use AS s FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.id = ?').get(a).s, '\\Junk');
  assert.ok((await api('GET', '/api/rules')).some((x) => x.name === 'Blocked: promo@spammy.example'));
  const b = await arrive('Spammy <promo@spammy.example>', 'Deal 2');
  await new Promise((r) => setTimeout(r, 200)); // rules run right after arrival, in the background
  assert.equal(db.prepare('SELECT f.special_use AS s FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.id = ?').get(b).s, '\\Junk', 'future mail too');
  await api('DELETE', '/api/senders/block?address=promo@spammy.example');
  const x1 = await arrive('Shop <shop@x.example>', 'Order 1'); const x2 = await arrive('Shop <shop@x.example>', 'Order 2');
  assert.deepEqual((await api('GET', '/api/messages/from-sender?address=shop@x.example&keepLatest=1')).ids, [x1]);
  assert.equal((await api('GET', '/api/messages/from-sender?address=shop@x.example')).ids.length, 2);
  const due = Date.now() + 864e5;
  await api('POST', `/api/messages/${x2}/follow-up`, { due });
  const task = db.prepare('SELECT * FROM tasks WHERE source_message_id = ?').get(x2);
  assert.equal(task.due, due); assert.match(task.title, /^Follow up: Order 2/);
  assert.equal(db.prepare('SELECT is_flagged FROM messages WHERE id = ?').get(x2).is_flagged, 1);
});

test('quick steps and folder export', async () => {
  await assert.rejects(api('POST', '/api/quick-steps', { name: 'Empty', actions: [] }), /at least one action/);
  const q = await api('POST', '/api/quick-steps', { name: 'Done', actions: [{ type: 'markRead' }, { type: 'archive' }, { type: 'bogus' }] });
  assert.deepEqual((await api('GET', '/api/quick-steps')).find((x) => x.id === q.id).actions.map((a) => a.type), ['markRead', 'archive']);
  const mbox = await api('GET', `/api/folders/${inbox.id}/export.mbox`);
  assert.match(mbox, /^From /); assert.match(mbox, /Subject: Order 2/);
});
