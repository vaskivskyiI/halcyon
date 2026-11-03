// The Android app's own connection (/api/ws?device=<token>): notifications come over it and are answered; Firebase is
// used only when no answer comes. What was sent while the app was away is sent again when it connects.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import WebSocket from 'ws';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r81-test-'));
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

const TOKEN = 'live-app-token-1234567890:APA91b';
let app, base, cookie = '', db, uid, acc, inbox, n;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return r.json();
}
const waitFor = async (fn) => { for (let i = 0; i < 150 && !fn(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(fn()); };
const fcmTo = (token) => sends.filter((m) => m.token === token && m.data.action !== 'close');

function connect(query, { answer = true } = {}) {
  const got = [];
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/ws?${query}`, { headers: { cookie } });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    got.push(m);
    if (answer && m.type === 'notify:show') ws.send(JSON.stringify({ type: 'ack', id: m.payload.id }));
  });
  return { ws, got, closed: new Promise((r) => ws.on('close', (code) => r(code))) };
}

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
  (await import('../src/notifications.js')).setAnswerMs(300);
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  acc = db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, 'me@example.org', 0, 0)").run(uid).lastInsertRowid;
  inbox = db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'INBOX', '\\Inbox')").run(acc).lastInsertRowid;
  await api('POST', '/api/push/fcm/register', { token: TOKEN, device: 'Pixel', version: 8 });
  n = 0;
});
after(async () => { await app?.close(); mock.close(); setTimeout(() => process.exit(0), 50).unref(); });

const mail = () => { n++; return Number(db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, subject, from_addr, to_json, cc_json, date, is_read, created_at)
  VALUES (?, ?, ?, ?, ?, 'S', 'a@x.example', '[]', '[]', ?, 0, 0)`).run(uid, acc, inbox, n, `m${n}@x`, Date.now()).lastInsertRowid); };
const notifyMail = async (id) => (await import('../src/notifications.js')).notifyUser(uid, 'mail', { title: `M${id}`, body: 'b', tag: `mail-${id}`, about: { mail: [id] } });

test('an unknown device is refused', async () => {
  const c = connect('device=not-registered-token-123456');
  assert.equal(await c.closed, 4003);
});

test('answered over the connection: no Firebase; unanswered: Firebase as well', async () => {
  const c = connect(`device=${encodeURIComponent(TOKEN)}&since=0`);
  await waitFor(() => c.got.some((m) => m.type === 'hello'));
  const a = mail();
  await notifyMail(a);
  await waitFor(() => c.got.some((m) => m.type === 'notify:show' && m.payload.tag === `mail-${a}`));
  const shown = c.got.find((m) => m.type === 'notify:show');
  assert.equal(shown.payload.kind, 'mail');
  assert.equal(shown.payload.type, 'mail');
  assert.ok(shown.payload.at > 0 && shown.payload.id > 0);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(fcmTo(TOKEN).length, 0, 'the app answered: no Firebase');
  assert.ok(!c.got.some((m) => m.type === 'mail:changed'), 'only notifications on this connection');

  // Taken back over the connection too.
  db.prepare('UPDATE messages SET is_read = 1 WHERE id = ?').run(a);
  await (await import('../src/notifications.js')).sweepNotifications();
  await waitFor(() => c.got.some((m) => m.type === 'notify:close' && m.payload.tags.includes(`mail-${a}`)));
  assert.ok(!sends.some((m) => m.token === TOKEN && m.data.action === 'close'), 'no Firebase close while connected');
  c.ws.close();
  await c.closed;

  const quiet = connect(`device=${encodeURIComponent(TOKEN)}`, { answer: false });
  await waitFor(() => quiet.got.some((m) => m.type === 'hello'));
  const b = mail();
  await notifyMail(b);
  await waitFor(() => fcmTo(TOKEN).some((m) => m.data.tag === `mail-${b}`));
  quiet.ws.close();
  await quiet.closed;
});

test('what came while the app was away is sent again when it is back, and what was taken back is closed', async () => {
  const c = connect(`device=${encodeURIComponent(TOKEN)}`);
  await waitFor(() => c.got.some((m) => m.type === 'hello'));
  const since = c.got.find((m) => m.type === 'hello').payload.now;
  c.ws.close();
  await c.closed;
  await new Promise((r) => setTimeout(r, 5));

  const x = mail(), y = mail();
  await notifyMail(x);
  await notifyMail(y);
  await waitFor(() => fcmTo(TOKEN).some((m) => m.data.tag === `mail-${y}`));
  db.prepare('UPDATE messages SET is_read = 1 WHERE id = ?').run(y);
  await (await import('../src/notifications.js')).sweepNotifications();

  const back = connect(`device=${encodeURIComponent(TOKEN)}&since=${since}`);
  await waitFor(() => back.got.some((m) => m.type === 'hello'));
  const shows = back.got.filter((m) => m.type === 'notify:show').map((m) => m.payload.tag);
  assert.deepEqual(shows, [`mail-${x}`], 'the one still unread again; the read one not');
  assert.ok(back.got.some((m) => m.type === 'notify:close' && m.payload.tags.includes(`mail-${y}`)), 'the read one closed');
  assert.equal(back.got.at(-1).type, 'hello', 'hello last: its time is where the app takes up next time');
  back.ws.close();
  await back.closed;

  // Answered now: not sent again on the next connection.
  const again = connect(`device=${encodeURIComponent(TOKEN)}&since=${since}`);
  await waitFor(() => again.got.some((m) => m.type === 'hello'));
  assert.ok(!again.got.some((m) => m.type === 'notify:show'));
  again.ws.close();
  await again.closed;
});
