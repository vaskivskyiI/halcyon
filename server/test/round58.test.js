// Administrators edit users and set new passwords; a person who is no administrator can do neither.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r58-test-'));
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, admin = '', adminId, bo, cy;
async function call(cookie, method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  return { status: r.status, data: await r.json(), cookie: sc ? sc.split(';')[0] : cookie };
}
const login = (email, password) => call('', 'POST', '/api/auth/login', { email, password });
const signedIn = async (cookie) => !!(await call(cookie, 'GET', '/api/auth/status')).data.user;

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  const s = await call('', 'POST', '/api/auth/setup', { email: 'admin@example.org', name: 'Admin', password: 'password123' });
  admin = s.cookie; adminId = s.data.user.id;
  bo = (await call(admin, 'POST', '/api/admin/users', { email: 'bo@example.org', name: 'Bo', password: 'password123' })).data.id;
  cy = (await call(admin, 'POST', '/api/admin/users', { email: 'cy@example.org', name: 'Cy', password: 'password123' })).data.id;
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('name, email and role are edited; the email stays unique and valid', async () => {
  const r = await call(admin, 'PATCH', `/api/admin/users/${bo}`, { name: 'Bo Novak', email: ' Bo.Novak@Example.org ', isAdmin: true });
  assert.deepEqual([r.data.name, r.data.email, r.data.isAdmin], ['Bo Novak', 'bo.novak@example.org', true]);
  assert.equal((await login('bo.novak@example.org', 'password123')).status, 200);
  assert.equal((await call(admin, 'PATCH', `/api/admin/users/${bo}`, { email: 'cy@example.org' })).status, 400);
  assert.equal((await call(admin, 'PATCH', `/api/admin/users/${bo}`, { email: 'nope' })).status, 400);
  await call(admin, 'PATCH', `/api/admin/users/${bo}`, { isAdmin: false });
});

test('the last administrator keeps the role', async () => {
  assert.equal((await call(admin, 'PATCH', `/api/admin/users/${adminId}`, { isAdmin: false })).status, 400);
});

test('a new password works at once, the old one does not, and the user is signed out', async () => {
  const s = await login('cy@example.org', 'password123');
  assert.ok(await signedIn(s.cookie));
  assert.equal((await call(admin, 'POST', `/api/admin/users/${cy}/password`, { password: 'short' })).status, 400);
  assert.equal((await call(admin, 'POST', `/api/admin/users/${cy}/password`, { password: 'another-password' })).status, 200);
  assert.ok(!(await signedIn(s.cookie)));
  assert.equal((await login('cy@example.org', 'password123')).status, 401);
  assert.equal((await login('cy@example.org', 'another-password')).status, 200);
});

test('an administrator resetting their own password stays signed in', async () => {
  assert.equal((await call(admin, 'POST', `/api/admin/users/${adminId}/password`, { password: 'password123' })).status, 200);
  assert.ok(await signedIn(admin));
});

test('nobody else can do this', async () => {
  const s = await login('cy@example.org', 'another-password');
  assert.equal((await call(s.cookie, 'PATCH', `/api/admin/users/${cy}`, { isAdmin: true })).status, 403);
  assert.equal((await call(s.cookie, 'POST', `/api/admin/users/${adminId}/password`, { password: 'password456' })).status, 403);
  assert.equal((await call(admin, 'POST', '/api/admin/users/99999/password', { password: 'password456' })).status, 404);
});
