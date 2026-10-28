// Calendars / contacts set up on an account: saving waits for the first sync and says what was found — or why not
// (wrong address, password, server not reachable); a failure stays visible in the problems panel.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r39-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';
const DAV = process.env.TEST_DAV_URL;

let app, base, cookie = '', db, account;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  await api('POST', '/api/auth/setup', { email: 'alice@test.local', name: 'Alice', password: 'password123' });
  const uid = db.prepare('SELECT id FROM users').get().id;
  account = db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, 'alice@test.local', 0, ?)").run(uid, Date.now()).lastInsertRowid;
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('a server that cannot be reached is reported when saving, and stays in the problems panel', async () => {
  const r = await api('PATCH', `/api/accounts/${account}`, { caldavUrl: 'http://127.0.0.1:9/dav/', davUser: 'alice', davPassword: 'x' });
  assert.match(r.dav.error, /Calendars \(CalDAV\): the server could not be reached/);
  const { problems } = await api('GET', '/api/status/problems');
  assert.ok(problems.some((p) => p.key === `dav:${account}` && p.actions.includes('retry-dav')));
  // Saving something else does not wait for the calendars again… unless they are still failing (then it retries).
  const again = await api('PATCH', `/api/accounts/${account}`, { name: 'Alice' });
  assert.ok(again.dav?.error);
});

test('the calendars and address books found are reported; a wrong password is said so', { skip: !DAV && 'set TEST_DAV_URL' }, async () => {
  let r = await api('PATCH', `/api/accounts/${account}`, { caldavUrl: DAV, carddavUrl: DAV, davUser: 'alice', davPassword: 'wrong' });
  assert.match(r.dav.error, /refused the username or password/);
  r = await api('PATCH', `/api/accounts/${account}`, { davPassword: 'secret123' });
  assert.equal(r.dav.error, null);
  assert.ok(r.dav.calendars >= 1 && r.dav.books >= 1);
  assert.ok((await api('GET', '/api/calendars')).some((c) => c.name === 'Work'));
  const { problems } = await api('GET', '/api/status/problems');
  assert.ok(!problems.some((p) => p.key === `dav:${account}`), 'fixed → gone from the problems panel');
});
