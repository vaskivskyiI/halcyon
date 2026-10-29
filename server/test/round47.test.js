// The native Android app's notifications: FCM device tokens per user, and FCM HTTP v1 data messages sent wherever Web
// Push goes — against a local stand-in for Google's token and FCM endpoints.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r47-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const got = { tokens: 0, sends: [] };
let answer = () => [200, { name: 'projects/demo/messages/1' }];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const reply = (code, d) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); };
    if (req.url === '/token') {
      const jwt = new URLSearchParams(body).get('assertion').split('.');
      const ok = crypto.verify('RSA-SHA256', Buffer.from(`${jwt[0]}.${jwt[1]}`), publicKey, Buffer.from(jwt[2], 'base64url'));
      const claims = JSON.parse(Buffer.from(jwt[1], 'base64url'));
      if (!ok || claims.iss !== 'push@demo.iam.gserviceaccount.com' || !/firebase\.messaging/.test(claims.scope)) return reply(400, { error: 'invalid_grant' });
      got.tokens++;
      return reply(200, { access_token: 'at-1', expires_in: 3600 });
    }
    if (req.url === '/v1/projects/demo/messages:send') {
      if (req.headers.authorization !== 'Bearer at-1') return reply(401, { error: { status: 'UNAUTHENTICATED' } });
      const m = JSON.parse(body).message;
      got.sends.push(m);
      return reply(...answer(m));
    }
    reply(404, {});
  });
});

let app, base, cookie = '', db, uid;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
const waitFor = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(fn()); };
const TOKEN = 'dGVzdC10b2tlbi0x:APA91bExampleTokenForTheAndroidAppOnly_1234567890';

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
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
});
after(async () => { await app?.close(); mock.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('the Android app registers its token; it is listed among the devices and refused when malformed', async () => {
  assert.deepEqual(await api('GET', '/api/push/fcm'), { available: true, error: null });
  await assert.rejects(api('POST', '/api/push/fcm/register', { token: 'x', device: 'Pixel' }), /400/);
  await api('POST', '/api/push/fcm/register', { token: TOKEN, device: 'Pixel 9' });
  await api('POST', '/api/push/fcm/register', { token: TOKEN, device: 'Pixel 9' }); // again (each app start): still one
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fcm_tokens WHERE user_id = ?').get(uid).n, 1);
  const devs = await api('GET', '/api/push/devices');
  assert.deepEqual(devs.map((d) => [d.device, d.kind]), [['Pixel 9', 'android']]);
});

test('a notification goes out as a high-priority FCM data message with only what it shows', async () => {
  await api('POST', '/api/push/test');
  await waitFor(() => got.sends.length === 1);
  const m = got.sends[0];
  assert.equal(got.tokens, 1);
  assert.equal(m.token, TOKEN);
  assert.equal(m.android.priority, 'HIGH');
  assert.equal(m.notification, undefined, 'data only: the app draws it');
  assert.deepEqual(m.data, { title: 'Halcyon', body: 'Notifications work on this device.', url: '#/settings/notifications', tag: 'test', silent: 'false', as: '', kind: 'reminder' });
  await waitFor(() => db.prepare('SELECT last_ok_at FROM fcm_tokens').get().last_ok_at > 0);

  // New mail with "hide content": no sender or subject leaves the server.
  const { notifyUser } = await import('../src/notifications.js');
  await api('PATCH', '/api/settings', { notifications: { hideContent: true, sound: false } });
  notifyUser(uid, 'mail', { title: 'Alice', body: 'Secret plans', url: '#/mail/unified/7', tag: 'mail-7', important: false });
  await waitFor(() => got.sends.length === 2);
  assert.deepEqual(got.sends[1].data, { title: 'New email', body: '', url: '#/mail/unified/7', tag: 'mail-7', silent: 'true', as: '', kind: 'mail' });
  assert.equal(got.tokens, 1, 'the access token is reused');
});

test('a token FCM no longer knows is forgotten; the app can unregister its own', async () => {
  answer = () => [404, { error: { code: 404, status: 'NOT_FOUND', message: 'Requested entity was not found.', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } }];
  await api('POST', '/api/push/test');
  await waitFor(() => !db.prepare('SELECT 1 FROM fcm_tokens').get());
  answer = () => [200, {}];

  await api('POST', '/api/push/fcm/register', { token: TOKEN, device: 'Pixel 9' });
  assert.deepEqual(await api('POST', '/api/push/fcm/unregister', { token: 'someone-elses' }), { removed: 0 });
  assert.deepEqual(await api('POST', '/api/push/fcm/unregister', { token: TOKEN }), { removed: 1 });
  const n = got.sends.length;
  await api('POST', '/api/push/test');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(got.sends.length, n, 'nothing sent without a token');
});
