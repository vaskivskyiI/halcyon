// How a calendar's events count: busy (blocks time), free (shown, never blocks), info (faint, no reminders, not in
// the brief). Checked through free-slot finding, the editor's overlap data, the brief and reminder ranges.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r13-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, uid;
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
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  await api('PATCH', '/api/settings', { calendar: { timezone: 'Europe/Ljubljana', tzAuto: false, workStart: '09:00', workEnd: '12:00' } });
  const { localToEpoch } = await import('../src/util/time.js');
  at = (h) => localToEpoch(mondayYmd, `${String(h).padStart(2, '0')}:00`, 'Europe/Ljubljana');
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

// Next Monday 09:00–12:00 in the user's zone (Ljubljana), whatever zone the test machine is in: three one-hour
// slots, each taken by one calendar.
const mondayYmd = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7)); return d.toISOString().slice(0, 10); })();
let at;

test('busy, free and informational calendars count differently', async () => {
  const work = await api('POST', '/api/calendars', { name: 'Work' });
  const team = await api('POST', '/api/calendars', { name: 'Team', showAs: 'free' });
  const info = await api('POST', '/api/calendars', { name: 'Conferences', showAs: 'info' });
  assert.deepEqual([work.showAs, team.showAs, info.showAs], ['busy', 'free', 'info']);
  await api('POST', '/api/events', { calendarId: work.id, title: 'Mine', start: at(9), end: at(10) });
  await api('POST', '/api/events', { calendarId: team.id, title: 'Colleague away', start: at(10), end: at(11) });
  await api('POST', '/api/events', { calendarId: info.id, title: 'Keynote stream', start: at(11), end: at(12) });

  const list = await api('GET', `/api/events?from=${at(0)}&to=${at(24)}`);
  const by = (t) => list.find((e) => e.title === t);
  assert.equal(by('Mine').busy, true);
  assert.equal(by('Colleague away').busy, false); assert.equal(by('Colleague away').showAs, 'free');
  assert.equal(by('Keynote stream').busy, false); assert.equal(by('Keynote stream').showAs, 'info');

  // Free time: only "Mine" blocks (10:00–12:00 is free).
  const slots = await api('GET', `/api/calendar/free-slots?from=${at(0)}&to=${at(24)}&duration=60`);
  const starts = slots.map((s) => s.start);
  assert.ok(!starts.includes(at(9)), '09:00 busy'); assert.ok(starts.includes(at(10)), 'free calendar does not block'); assert.ok(starts.includes(at(11)), 'info calendar does not block');

  // Brief and reminders leave informational calendars out.
  const { listRange } = await import('../src/calendar/repo.js');
  const titles = listRange(uid, at(0), at(24), null, { includeInfo: false }).map((e) => e.title);
  assert.deepEqual(titles.sort(), ['Colleague away', 'Mine']);

  // Changing how a calendar counts; unknown values are ignored.
  await api('PATCH', `/api/calendars/${team.id}`, { showAs: 'busy' });
  await api('PATCH', `/api/calendars/${info.id}`, { showAs: 'whatever' });
  const cals = await api('GET', '/api/calendars');
  assert.equal(cals.find((c) => c.id === team.id).showAs, 'busy');
  assert.equal(cals.find((c) => c.id === info.id).showAs, 'info');
  assert.equal((await api('GET', `/api/events?from=${at(0)}&to=${at(24)}`)).find((e) => e.title === 'Colleague away').busy, true);
});

test('an event marked "free" stays free in a busy calendar', async () => {
  const cal = (await api('GET', '/api/calendars')).find((c) => c.name === 'Work');
  await api('POST', '/api/events', { calendarId: cal.id, title: 'Optional lunch', start: at(13), end: at(14), busy: false });
  assert.equal((await api('GET', `/api/events?from=${at(0)}&to=${at(24)}`)).find((e) => e.title === 'Optional lunch').busy, false);
});
