// The suite: another configured app may show Halcyon beside it, no other site; signing out goes through both apps.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r62-test-'));
process.env.HALCYON_LOG_LEVEL = 'error';
process.env.HALCYON_SSO_SECRET = 's';
process.env.HALCYON_SSO_REDIRECTS = 'https://notes.test/api/auth/halcyon/callback';

let app, base, cookie = '';
const get = (url, c = cookie) => fetch(base + url, { redirect: 'manual', headers: { cookie: c } });

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  const r = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ann@example.org', name: 'Ann', password: 'password123' }) });
  cookie = r.headers.get('set-cookie').split(';')[0];
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('only the companion app may frame Halcyon', async () => {
  const csp = (await get('/api/auth/status')).headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'self' https:\/\/notes\.test/);
  assert.match(csp, /frame-src 'self' blob: https:\/\/notes\.test/);
});

test('the status says it is a suite', async () => {
  assert.equal((await (await get('/api/auth/status')).json()).suite, true);
});

test('signing out continues only to the companion app', async () => {
  const evil = await get(`/api/sso/logout?return=${encodeURIComponent('https://evil.test/')}`);
  assert.equal(evil.headers.get('location'), '/');
  assert.equal((await (await get('/api/auth/status')).json()).user, null, 'the session has ended');
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ann@example.org', password: 'password123' }) });
  const c = r.headers.get('set-cookie').split(';')[0];
  const ok = await get(`/api/sso/logout?return=${encodeURIComponent('https://notes.test/?signedout=1')}`, c);
  assert.equal(ok.headers.get('location'), 'https://notes.test/?signedout=1');
});
