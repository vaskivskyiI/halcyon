// A DAV server that limits requests (Google's quota) is left alone for a while; Google is asked less often.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r55-test-'));
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, uid, S;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return r.json();
}
const account = (url) => db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, mail, carddav_url, created_at) VALUES (?, 'a@x.example', 0, 0, ?, ?)").run(uid, url, Date.now()).lastInsertRowid);

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  S = await import('../src/scheduler.js');
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('Google quota errors are recognised', () => {
  assert.ok(S.rateLimited(new Error('Collection query failed: 429 Too Many Requests. Raw response: { "status": "RESOURCE_EXHAUSTED" }')));
  assert.ok(!S.rateLimited(new Error('Collection query failed: 404 Not Found')));
});

test('during the pause the server is not asked, the panel shows a warning with the next try; a sync asked for still runs', async () => {
  const a = account('http://127.0.0.1:1/dav/');
  S.davHold.set(`${a.id}:card`, { until: Date.now() + 60e3, n: 1, error: 'Contacts (CardDAV): the server allows only so many requests and asks to wait. What is here stays' });
  const r = await S.syncDav(a);
  assert.equal(r.limited, true);
  assert.ok(r.retryAt > Date.now());
  const p = (await api('GET', '/api/status/problems')).problems.find((x) => x.key === `dav:${a.id}`);
  assert.equal(p.level, 'warn');
  assert.match(p.text, /trying again at/);
  const asked = await S.syncDav(a, { asked: true });
  assert.ok(!asked.limited, 'pressing retry tries the server');
  assert.match(asked.error, /could not be reached|cannot find/i);
  S.davStatus.delete(a.id);
});

test('Google is asked at most every 30 minutes unless something waits to be saved', async () => {
  const a = account('https://www.googleapis.com/carddav/v1/principals/a@x.example/lists/default/');
  S.davLast.set(`${a.id}:card`, Date.now());
  const r = await S.syncDav(a);
  assert.deepEqual([r.books, r.error], [null, null], 'skipped, no request and no error');
});
