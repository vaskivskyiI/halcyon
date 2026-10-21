// Google accounts: an administrator sets up "Sign in with Google" in the app (no environment variables needed); the
// sign-in then starts with that client; the secret never leaves the server; expired sign-ins offer "Sign in again".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r14-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';
delete process.env.GOOGLE_CLIENT_ID;

let app, base, db;
const jar = { admin: '', user: '' };
async function api(who, method, url, body, { raw = false } = {}) {
  const r = await fetch(base + url, { method, redirect: 'manual', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), cookie: jar[who] }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) jar[who] = sc.split(';')[0];
  if (raw) return r;
  const data = await r.json();
  if (!r.ok) { const e = new Error(data.error || String(r.status)); e.status = r.status; throw e; }
  return data;
}

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  await api('admin', 'POST', '/api/auth/setup', { email: 'admin@example.org', name: 'Admin', password: 'password123' });
  await api('admin', 'POST', '/api/admin/users', { email: 'user@example.org', name: 'User', password: 'password123', isAdmin: false });
  await api('user', 'POST', '/api/auth/login', { email: 'user@example.org', password: 'password123' });
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('an administrator sets up "Sign in with Google" in the app; other users cannot', async () => {
  assert.equal((await api('user', 'GET', '/api/me')).oauth.google, false);
  await assert.rejects(() => api('user', 'GET', '/api/admin/oauth'), (e) => e.status === 403);
  await assert.rejects(() => api('user', 'PUT', '/api/admin/oauth/google', { clientId: 'x', clientSecret: 'y' }), (e) => e.status === 403);
  const st = await api('admin', 'GET', '/api/admin/oauth');
  assert.equal(st.google.configured, false);
  assert.match(st.redirectUri, /\/api\/oauth\/callback$/);
  await assert.rejects(() => api('admin', 'PUT', '/api/admin/oauth/google', { clientId: 'only-id' }), /secret is needed/);
  await api('admin', 'PUT', '/api/admin/oauth/google', { clientId: 'abc.apps.googleusercontent.com', clientSecret: 'TOP-SECRET' });
  const after = await api('admin', 'GET', '/api/admin/oauth');
  assert.deepEqual({ ...after.google, tenant: undefined }, { configured: true, clientId: 'abc.apps.googleusercontent.com', source: 'settings', tenant: undefined });
  assert.equal(JSON.stringify(after).includes('TOP-SECRET'), false, 'secret never returned');
  const stored = db.prepare("SELECT value FROM app_state WHERE key = 'oauth:google'").get().value;
  assert.equal(stored.includes('TOP-SECRET'), false, 'stored encrypted');
  assert.equal((await api('user', 'GET', '/api/me')).oauth.google, true, 'now offered to every user');
});

test('sign-in starts at Google with that client and asks for mail, calendar and contacts', async () => {
  const r = await api('user', 'GET', '/api/oauth/google/start', undefined, { raw: true });
  assert.equal(r.status, 302);
  const to = new URL(r.headers.get('location'));
  assert.equal(to.host, 'accounts.google.com');
  assert.equal(to.searchParams.get('client_id'), 'abc.apps.googleusercontent.com');
  assert.match(to.searchParams.get('redirect_uri'), /\/api\/oauth\/callback$/);
  for (const s of ['https://mail.google.com/', 'https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/carddav']) assert.ok(to.searchParams.get('scope').includes(s), s);
  assert.equal(to.searchParams.get('access_type'), 'offline');
});

test('removing it turns the option off again', async () => {
  await api('admin', 'PUT', '/api/admin/oauth/google', { clientId: '' });
  assert.equal((await api('user', 'GET', '/api/me')).oauth.google, false);
  const r = await api('user', 'GET', '/api/oauth/google/start', undefined, { raw: true });
  assert.equal(r.status, 400);
});

test('a Google account whose sign-in stopped working offers "Sign in again"', async () => {
  const uid = db.prepare("SELECT id FROM users WHERE email = 'user@example.org'").get().id;
  db.prepare("INSERT INTO accounts (user_id, email, auth_type, sync_enabled, sync_state, sync_error, created_at) VALUES (?, 'me@gmail.com', 'oauth-google', 1, 'error', 'OAuth session expired — please reconnect the account', ?)").run(uid, Date.now());
  const p = (await api('user', 'GET', '/api/status/problems')).problems.find((x) => x.key.startsWith('imap:'));
  assert.equal(p.provider, 'google');
  assert.deepEqual(p.actions, ['reauth', 'reconnect']);
});
