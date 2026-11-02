// Notifications are taken back once they no longer apply: the mail read or moved out of the inbox, the task done, the
// event over, or the notification opened on another device. Devices that run an app version knowing it get a silent
// FCM message; the open app gets notify:close.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r80-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const sends = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/token') return res.end(JSON.stringify({ access_token: 'at-1', expires_in: 3600 }));
    sends.push(JSON.parse(body).message);
    res.end(JSON.stringify({ name: 'projects/demo/messages/1' }));
  });
});

let app, base, cookie = '', db, uid, acc, inbox;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return r.json();
}
const waitFor = async (fn) => { for (let i = 0; i < 150 && !fn(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(fn()); };
const closes = () => sends.filter((m) => m.data.action === 'close').flatMap((m) => m.data.tags.split(String.fromCharCode(10)));
const events = [];

before(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const m = `http://127.0.0.1:${mock.address().port}`;
  const key = path.join(dataDir, 'firebase.json');
  fs.writeFileSync(key, JSON.stringify({ type: 'service_account', project_id: 'demo', client_email: 'push@demo.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: `${m}/token` }));
  process.env.HALCYON_FCM_SERVICE_ACCOUNT = key;
  process.env.HALCYON_FCM_URL = m;
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  (await import('../src/util/events.js')).bus.on('user-event', (e) => { if (e.type === 'notify:close') events.push(e.payload.tags); });
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  acc = db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, 'me@example.org', 0, 0)").run(uid).lastInsertRowid;
  inbox = db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'INBOX', '\\Inbox')").run(acc).lastInsertRowid;
  await api('POST', '/api/push/fcm/register', { token: 'old-app-token-1234567890:APA91b', device: 'Old phone' });
  await api('POST', '/api/push/fcm/register', { token: 'new-app-token-1234567890:APA91b', device: 'Pixel', version: 7 });
});
after(async () => { await app?.close(); mock.close(); setTimeout(() => process.exit(0), 50).unref(); });

const mail = (n) => Number(db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, subject, from_addr, to_json, cc_json, date, is_read, created_at)
  VALUES (?, ?, ?, ?, ?, 'S', 'a@x.example', '[]', '[]', ?, 0, 0)`).run(uid, acc, inbox, n, `m${n}@x`, Date.now()).lastInsertRowid);

test('a mail notification is taken back on every device once the mail is read', async () => {
  const { notifyUser, sweepNotifications } = await import('../src/notifications.js');
  const id = mail(1);
  notifyUser(uid, 'mail', { title: 'A', body: 'b', url: `#/mail/unified/${id}`, tag: `mail-${id}`, about: { mail: [id] } });
  await waitFor(() => sends.length === 2);
  await sweepNotifications();
  assert.deepEqual(closes(), [], 'still unread: it stays');
  const { setFlags } = await import('../src/mail/actions.js');
  setFlags(uid, [id], { read: true });
  await waitFor(() => closes().length === 1);
  assert.equal(closes()[0], `mail-${id}`);
  const close = sends.find((m) => m.data.action === 'close');
  assert.equal(close.token, 'new-app-token-1234567890:APA91b', 'only the app version that knows it');
  assert.equal(close.android.priority, 'NORMAL');
  assert.equal(close.notification, undefined, 'nothing is shown for it');
  assert.deepEqual(events.at(-1), [`mail-${id}`], 'the open app closes it too');
});

test('a batch is taken back when all of it is read; tasks when done; events when over; opened elsewhere at once', async () => {
  const { notifyUser, sweepNotifications } = await import('../src/notifications.js');
  const a = mail(2), b = mail(3);
  notifyUser(uid, 'mail', { title: '2 new emails', body: '', tag: 'mail-batch-1', about: { mail: [a, b] } });
  db.prepare('UPDATE messages SET is_read = 1 WHERE id = ?').run(a);
  await sweepNotifications();
  assert.ok(!closes().includes('mail-batch-1'), 'one is still unread');
  db.prepare('UPDATE messages SET is_read = 1 WHERE id = ?').run(b); // read in another mail app (synced)
  await sweepNotifications();
  await waitFor(() => closes().includes('mail-batch-1'));

  const task = Number(db.prepare("INSERT INTO tasks (user_id, title, created_at, updated_at) VALUES (?, 'T', 0, 0)").run(uid).lastInsertRowid);
  notifyUser(uid, 'reminder', { title: 'T', tag: `rem-t${task}`, type: 'task', about: { task } });
  notifyUser(uid, 'reminder', { title: 'E', tag: 'rem-e1-0', type: 'event', about: { until: Date.now() + 300 } });
  await sweepNotifications();
  assert.ok(!closes().includes(`rem-t${task}`) && !closes().includes('rem-e1-0'));
  db.prepare('UPDATE tasks SET done = 1 WHERE id = ?').run(task);
  await new Promise((r) => setTimeout(r, 350));
  await sweepNotifications();
  await waitFor(() => closes().includes(`rem-t${task}`) && closes().includes('rem-e1-0'));

  notifyUser(uid, 'mail', { title: 'X', tag: 'mail-99', about: { mail: [mail(4)] } });
  await api('POST', '/api/push/close', { tag: 'mail-99' });
  await waitFor(() => closes().includes('mail-99'));
});
