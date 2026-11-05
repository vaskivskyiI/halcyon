// "Mail in Focused" notifications: mail already in Focused is told on arrival; mail the AI is still to read is told once
// the AI has put it into Focused, and not at all when it goes to Other. "Every new email" is told at once as before.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r88-test-'));
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, uid, account, folder, ingestMessage, afterIngest, analyzeMessage, n = 0;
const shown = [];
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
async function arrive(...mails) {
  const ids = [];
  for (const { from = 'ana@x.example', subject, body } of mails) {
    const raw = `Message-ID: <f${++n}@x>\r\nFrom: ${from}\r\nTo: me@example.org\r\nSubject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\nContent-Type: text/plain\r\n\r\n${body}\r\n`;
    ids.push((await ingestMessage({ account, folder, uid: n, flags: [], raw: Buffer.from(raw) })).id);
  }
  await afterIngest(account, folder, ids);
  return ids;
}

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  ({ ingestMessage } = await import('../src/mail/store.js'));
  ({ afterIngest } = await import('../src/mail/pipeline.js'));
  ({ analyzeMessage } = await import('../src/ai/tasks.js'));
  const { bus } = await import('../src/util/events.js');
  bus.on('user-event', (e) => { if (e.type === 'notify:show') shown.push(e.payload.title); });
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  await api('PATCH', '/api/settings', { ai: { enabled: true, autoAnalyze: true }, notifications: { mail: 'focused' } });
  await api('POST', '/api/ai/providers', { type: 'mock', name: 'Mock' });
  // Added yesterday: what arrives now is new mail, not the account's first sync.
  account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, 'me@example.org', 0, ?)").run(uid, Date.now() - 864e5).lastInsertRowid);
  folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'INBOX', '\\Inbox')").run(account.id).lastInsertRowid);
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('mail the AI is to read is told once it is in Focused, not when it goes to Other', async () => {
  shown.length = 0;
  const [ask, plain] = await arrive({ subject: 'Meeting', body: 'Can we meet on Friday?' }, { subject: 'Weekly digest', body: 'Things happened.' });
  assert.deepEqual(shown, [], 'nothing on arrival: both still to be sorted');
  await analyzeMessage(uid, ask, { interactive: true });
  await analyzeMessage(uid, plain, { interactive: true });
  assert.deepEqual(shown, ['ana@x.example'], 'the question, now in Focused; the digest went to Other');
});

test('a sender on the Focused list is told on arrival, and not again after the analysis', async () => {
  db.prepare("INSERT INTO focus_senders (user_id, address, focused, created_at) VALUES (?, 'boss@x.example', 1, ?)").run(uid, Date.now());
  shown.length = 0;
  const [id] = await arrive({ from: 'Boss <boss@x.example>', subject: 'Plan', body: 'Can you look at the plan?' });
  assert.deepEqual(shown, ['Boss']);
  await analyzeMessage(uid, id, { interactive: true });
  assert.deepEqual(shown, ['Boss'], 'once');
});

test('"Every new email" is told at once, and not again after the analysis', async () => {
  await api('PATCH', '/api/settings', { notifications: { mail: 'all' } });
  shown.length = 0;
  const [id] = await arrive({ subject: 'Lunch', body: 'Lunch tomorrow?' });
  assert.deepEqual(shown, ['ana@x.example']);
  await analyzeMessage(uid, id, { interactive: true });
  assert.deepEqual(shown, ['ana@x.example']);
});
