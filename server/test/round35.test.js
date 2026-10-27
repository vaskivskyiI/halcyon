// Notifications: one place decides by the user's settings (which mail, reminders, quiet hours, muted accounts and
// shared spaces, hidden content); push subscriptions per device.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r35-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';
process.env.HALCYON_ANDROID_PACKAGE = 'cc.halcyon.mail';
process.env.HALCYON_ANDROID_SHA256 = 'AA:BB, CC:DD';

let app, base, cookie = '', db, uid, N, bus;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
// What reaches the user's open app.
const shown = [];

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  N = await import('../src/notifications.js');
  ({ bus } = await import('../src/util/events.js'));
  bus.on('user-event', (e) => { if (e.type === 'notify:show') shown.push({ to: e.userId, ...e.payload }); });
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  await api('PATCH', '/api/settings', { calendar: { timezone: 'UTC' } });
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('what notifies follows the settings: all / important / none, muted accounts, hidden content', async () => {
  const mail = (o = {}) => N.notifyUser(uid, 'mail', { title: 'Ana', body: 'Budget', url: '#/mail/unified/1', tag: 'mail-1', accountId: 7, ...o });
  shown.length = 0;
  mail(); assert.equal(shown.length, 1); assert.equal(shown[0].title, 'Ana');
  await api('PATCH', '/api/settings', { notifications: { mail: 'important' } });
  shown.length = 0; mail(); mail({ important: true, title: 'Important: Ana' });
  assert.deepEqual(shown.map((s) => s.title), ['Important: Ana']);
  await api('PATCH', '/api/settings', { notifications: { mail: 'all', muteAccounts: [7] } });
  shown.length = 0; mail(); mail({ accountId: 8 });
  assert.equal(shown.length, 1, 'muted account is quiet, others are not');
  await api('PATCH', '/api/settings', { notifications: { muteAccounts: [], hideContent: true } });
  shown.length = 0; mail();
  assert.deepEqual([shown[0].title, shown[0].body], ['New email', '']);
  await api('PATCH', '/api/settings', { notifications: { hideContent: false, mail: 'none' } });
  shown.length = 0; mail(); N.notifyUser(uid, 'reminder', { title: 'Meeting', body: '10:00' });
  assert.deepEqual(shown.map((s) => s.title), ['Meeting'], 'no mail notifications, reminders still');
  await api('PATCH', '/api/settings', { notifications: { mail: 'all' } });
});

test('quiet hours (in the user\'s time zone, also across midnight)', async () => {
  const at = (h, m = 0) => Date.UTC(2026, 10, 2, h, m);
  await api('PATCH', '/api/settings', { notifications: { quiet: { enabled: true, start: '22:00', end: '07:00' } } });
  assert.equal(N.inQuietHours(uid, N.prefsOf(uid), at(23)), true);
  assert.equal(N.inQuietHours(uid, N.prefsOf(uid), at(3)), true);
  assert.equal(N.inQuietHours(uid, N.prefsOf(uid), at(12)), false);
  await api('PATCH', '/api/settings', { notifications: { quiet: { enabled: true, start: '12:00', end: '13:00' } } });
  assert.equal(N.inQuietHours(uid, N.prefsOf(uid), at(12, 30)), true);
  await api('PATCH', '/api/settings', { notifications: { quiet: { enabled: false } } });
});

test('mail of a shared space notifies its members (unless they muted it); push subscriptions per device', async () => {
  const sp = await api('POST', '/api/shared', { name: 'Studio' });
  shown.length = 0;
  N.notifyUser(sp.id, 'mail', { title: 'Client', body: 'Booking', tag: 'mail-9' });
  assert.deepEqual(shown.map((s) => [s.to, s.as]), [[uid, sp.id]]);
  await api('PATCH', '/api/settings', { notifications: { muteShared: [sp.id] } });
  shown.length = 0; N.notifyUser(sp.id, 'mail', { title: 'Client', body: 'Booking' });
  assert.equal(shown.length, 0);
  const { publicKey } = await api('GET', '/api/push/key');
  assert.ok(publicKey.length > 60);
  await api('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://push.example/abc', keys: { p256dh: 'BKey', auth: 'auth' } }, device: 'Android' });
  assert.deepEqual((await api('GET', '/api/push/devices')).map((d) => d.device), ['Android']);
  await api('POST', '/api/push/unsubscribe', { endpoint: 'https://push.example/abc' });
  assert.equal((await api('GET', '/api/push/devices')).length, 0);
  await assert.rejects(api('POST', '/api/push/subscribe', { subscription: { endpoint: 'x' } }), /Not a push subscription/);
});

test('the Android app is linked to the server through assetlinks.json', async () => {
  const r = await fetch(base + '/.well-known/assetlinks.json');
  assert.equal(r.status, 200);
  const [link] = await r.json();
  assert.deepEqual(link.target, { namespace: 'android_app', package_name: 'cc.halcyon.mail', sha256_cert_fingerprints: ['AA:BB', 'CC:DD'] });
});
