// A login with only shared spaces (no mail or calendar of its own) works in its shared space by default: the space's
// calendars, lists and books are its defaults, and its own empty starters are not kept. Leaving is remembered.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r83-test-'));
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, db, shared;
const jar = {};
async function api(method, url, body) {
  const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const r = await fetch(base + url, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
  for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
  return { status: r.status, data: await r.json().catch(() => null) };
}

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  await api('POST', '/api/auth/setup', { email: 'u@example.org', name: 'U', password: 'password123' });
  shared = (await api('POST', '/api/shared', { name: 'Office' })).data.id;
  db.prepare("INSERT INTO calendars (user_id, name, color, source, is_default, created_at) VALUES (?, 'Office calendar', '#f00', 'local', 0, 0)").run(shared);
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('only shared spaces: the space is home, own empty starters go', async () => {
  const own = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = 1`).get().n;
  assert.ok(own('calendars') >= 1 && own('address_books') >= 1, 'a new login has its starters');
  const st = (await api('GET', '/api/auth/status')).data;
  assert.equal(st.acting?.id, shared, 'works in the shared space without entering it');
  const me = (await api('GET', '/api/me')).data;
  assert.equal(me.acting?.id, shared);
  assert.equal(own('calendars'), 0, 'empty own calendar removed');
  assert.equal(own('address_books'), 0, 'empty own address book removed');
  const cals = (await api('GET', '/api/calendars')).data;
  assert.ok(cals.some((c) => c.name === 'Office calendar') && cals.every((c) => c.name !== 'Calendar' || c.owner === undefined));
  const ev = await api('POST', '/api/events', { title: 'Meeting', start: Date.now() + 3600e3, end: Date.now() + 7200e3 });
  assert.equal(ev.status, 200);
  assert.equal(db.prepare('SELECT c.user_id FROM events e JOIN calendars c ON c.id = e.calendar_id WHERE e.id = ?').get(ev.data.id).user_id, shared, 'the event goes to the space');
});

test('leaving is remembered; own items are made when needed; entering again works', async () => {
  await api('POST', '/api/shared/leave');
  assert.equal((await api('GET', '/api/auth/status')).data.acting, null, 'own space chosen: stays there');
  const ev = await api('POST', '/api/events', { title: 'Dentist', start: Date.now() + 3600e3, end: Date.now() + 7200e3 });
  assert.equal(ev.status, 200, 'a calendar of its own is made when needed');
  assert.equal(db.prepare('SELECT c.user_id FROM events e JOIN calendars c ON c.id = e.calendar_id WHERE e.id = ?').get(ev.data.id).user_id, 1);
  await api('GET', '/api/me');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendars WHERE user_id = 1').get().n, 1, 'not removed while in own space, nor when it has events');
  await api('POST', `/api/shared/${shared}/enter`);
  assert.equal((await api('GET', '/api/auth/status')).data.acting?.id, shared);
});

test('a login with its own account is not taken into a shared space', async () => {
  delete jar.halcyon_as;
  db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (1, 'u@example.org', 0, 0)").run();
  (await import('../src/auth.js')).forgetHome();
  assert.equal((await api('GET', '/api/auth/status')).data.acting, null);
});
