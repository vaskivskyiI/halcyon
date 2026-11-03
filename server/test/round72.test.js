// "Busy only" calendar sharing between logins: a person lets another login or a shared space see when they are busy in
// chosen calendars — only the times, never titles, places, people or ids.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r72-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base;
const jar = { a: {}, b: {}, c: {} };
async function as(who, method, url, body) {
  const cookie = Object.entries(jar[who]).map(([k, v]) => `${k}=${v}`).join('; ');
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const c of r.headers.getSetCookie?.() || []) {
    const [kv, ...attrs] = c.split(';');
    const [k, v] = kv.split('=');
    if (attrs.some((a) => /expires=Thu, 01 Jan 1970/i.test(a)) || v === '') delete jar[who][k]; else jar[who][k] = v;
  }
  return { status: r.status, data: await r.json().catch(() => null) };
}
const ok = async (...a) => { const r = await as(...a); assert.ok(r.status < 300, `${a[1]} ${a[2]} → ${r.status} ${JSON.stringify(r.data)}`); return r.data; };

// A Monday two weeks ahead, in UTC (every login works in UTC here).
const monday = (() => { const d = new Date(Date.now() + 14 * 864e5); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.getTime(); })();
const at = (h, m = 0) => monday + h * 3600e3 + m * 60e3;
const from = monday, to = monday + 864e5;
let priv, holidays, grantB, sharedId;
const busyOf = (list) => list.filter((e) => e.sharedBusy);

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  await ok('a', 'POST', '/api/auth/setup', { email: 'a@example.org', name: 'Ann', password: 'password123' });
  await ok('a', 'POST', '/api/admin/users', { email: 'b@example.org', name: 'Ben', password: 'password123' });
  await ok('a', 'POST', '/api/admin/users', { email: 'c@example.org', name: 'Cid', password: 'password123' });
  await ok('b', 'POST', '/api/auth/login', { email: 'b@example.org', password: 'password123' });
  await ok('c', 'POST', '/api/auth/login', { email: 'c@example.org', password: 'password123' });
  for (const w of ['a', 'b', 'c']) jar[w].halcyon_as = '0'; // works in its own space (no home space)
  for (const w of ['a', 'b', 'c']) await ok(w, 'PATCH', '/api/settings', { calendar: { timezone: 'UTC', tzAuto: false, workStart: '08:00', workEnd: '17:00' } });
  priv = await ok('a', 'POST', '/api/calendars', { name: 'Private' });
  holidays = await ok('a', 'POST', '/api/calendars', { name: 'Holidays', showAs: 'info' });
  await ok('a', 'POST', '/api/events', { calendarId: priv.id, title: 'Doctor secret', location: 'Clinic Street 5', description: 'confidential', start: at(9), end: at(12),
    attendees: [{ email: 'doc@clinic.example', name: 'Dr Who' }] });
  await ok('a', 'POST', '/api/events', { calendarId: priv.id, title: 'Lunch maybe', start: at(13), end: at(14), showAs: 'free' });
  await ok('a', 'POST', '/api/events', { calendarId: holidays.id, title: 'Parade day', start: at(14), end: at(15) });
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('only the owner of a calendar can share it, with a real login or one of their spaces', async () => {
  assert.equal((await as('b', 'POST', '/api/shared/busy', { calendarId: priv.id, email: 'c@example.org' })).status, 400);
  assert.equal((await as('a', 'POST', '/api/shared/busy', { calendarId: priv.id, email: 'nobody@example.org' })).status, 400);
  assert.equal((await as('a', 'POST', '/api/shared/busy', { calendarId: priv.id, email: 'a@example.org' })).status, 400);
  grantB = await ok('a', 'POST', '/api/shared/busy', { calendarId: priv.id, email: 'B@example.org' });
  await ok('a', 'POST', '/api/shared/busy', { calendarId: holidays.id, email: 'b@example.org' });
  assert.equal(grantB.grantee, 'Ben');
  assert.equal(grantB.calendarName, 'Private');
  assert.equal((await ok('a', 'GET', '/api/shared/busy')).length, 2);
  assert.deepEqual(await ok('b', 'GET', '/api/shared/busy'), []);
});

test('the grantee sees masked busy blocks and nothing else; free and info events are not shared', async () => {
  for (const url of [`/api/events?from=${from}&to=${to}`, `/api/events?from=${from}&to=${to}&allSpaces=1`]) {
    const list = await ok('b', 'GET', url);
    const busy = busyOf(list);
    assert.equal(busy.length, 1, url);
    assert.equal(busy[0].title, 'Busy · Ann');
    assert.equal(busy[0].start, at(9));
    assert.equal(busy[0].end, at(12));
    assert.equal(busy[0].id, null);
    assert.equal(busy[0].calendarId, null);
    assert.ok(!('location' in busy[0]) && !('attendees' in busy[0]) && !('description' in busy[0]));
    assert.doesNotMatch(JSON.stringify(list), /Doctor|Clinic|confidential|Dr Who|clinic\.example|Lunch|Parade/);
  }
  // The owner sees their own event, not a block of themselves.
  const mine = await ok('a', 'GET', `/api/events?from=${from}&to=${to}`);
  assert.equal(busyOf(mine).length, 0);
  assert.ok(mine.some((e) => e.title === 'Doctor secret'));
});

test('free-slot search, the overlap check and proposed times avoid the shared busy time', async () => {
  const slots = await ok('b', 'GET', `/api/calendar/free-slots?from=${from}&to=${to}&duration=60`);
  assert.ok(slots.length);
  assert.ok(slots.every((s) => s.end <= at(9) || s.start >= at(12)), JSON.stringify(slots));
  assert.ok(slots.some((s) => s.start === at(13)), 'a free event does not block');
  const own = await ok('c', 'GET', `/api/calendar/free-slots?from=${from}&to=${to}&duration=60`);
  assert.ok(own.some((s) => s.start === at(9)), 'someone not shared with is not blocked');
  const check = await ok('b', 'POST', '/api/calendar/check', { ranges: [{ start: at(10), end: at(10, 30) }, { start: at(13), end: at(13, 30) }, { start: at(14), end: at(14, 30) }] });
  assert.equal(check[0].free, false);
  assert.equal(check[0].conflicts[0].title, 'Busy · Ann');
  assert.equal(check[1].free, true);
  assert.equal(check[2].free, true);
});

test('a non-grantee sees nothing', async () => {
  const list = await ok('c', 'GET', `/api/events?from=${from}&to=${to}&allSpaces=1`);
  assert.equal(list.length, 0);
});

test('a grant to a shared space shows to its members while they work in it', async () => {
  sharedId = (await ok('a', 'POST', '/api/shared', { name: 'Studio' })).id;
  await ok('a', 'POST', `/api/shared/${sharedId}/members`, { email: 'c@example.org' });
  await ok('a', 'POST', '/api/shared/busy', { calendarId: priv.id, sharedId });
  assert.equal((await as('c', 'POST', '/api/shared/busy', { calendarId: priv.id, sharedId })).status, 400);
  jar.c.halcyon_as = String(sharedId);
  const inSpace = busyOf(await ok('c', 'GET', `/api/events?from=${from}&to=${to}`));
  assert.equal(inSpace.length, 1);
  assert.equal(inSpace[0].title, 'Busy · Ann');
  const slots = await ok('c', 'GET', `/api/calendar/free-slots?from=${from}&to=${to}&duration=60`);
  assert.ok(slots.every((s) => s.end <= at(9) || s.start >= at(12)));
  jar.c.halcyon_as = '0';
  assert.equal(busyOf(await ok('c', 'GET', `/api/events?from=${from}&to=${to}`)).length, 0, 'not in their own calendar');
  // The owner working in the space sees their time as their own ("Blocked"), not as a share of themselves.
  jar.a.halcyon_as = String(sharedId);
  const owner = await ok('a', 'GET', `/api/events?from=${from}&to=${to}`);
  jar.a.halcyon_as = '0';
  assert.equal(busyOf(owner).length, 0);
});

test('removing the grant removes the blocks; only the owner can remove it', async () => {
  await ok('c', 'DELETE', `/api/shared/busy/${grantB.id}`);
  assert.equal(busyOf(await ok('b', 'GET', `/api/events?from=${from}&to=${to}`)).length, 1);
  await ok('a', 'DELETE', `/api/shared/busy/${grantB.id}`);
  assert.equal(busyOf(await ok('b', 'GET', `/api/events?from=${from}&to=${to}`)).length, 0);
  const slots = await ok('b', 'GET', `/api/calendar/free-slots?from=${from}&to=${to}&duration=60`);
  assert.ok(slots.some((s) => s.start === at(9)));
});

test('deleting the calendar removes its grants', async () => {
  await ok('a', 'DELETE', `/api/calendars/${priv.id}`);
  assert.ok((await ok('a', 'GET', '/api/shared/busy')).every((g) => g.calendarId !== priv.id));
});
