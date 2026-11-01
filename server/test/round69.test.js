// How an event shows the user's time: its own status (free, working elsewhere, tentative, busy, away) — read from and
// written to the calendar data — and the user's own choice for one event of a free, informational or read-only calendar.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r69-test-'));
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
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

const T = Date.UTC(2031, 2, 3, 9);
const H = 3600e3;
const list = () => api('GET', `/api/events?from=${T - H}&to=${T + 24 * H}`);

test('an event has its own status; busy, tentative and away block time, free and working elsewhere do not', async () => {
  const work = await api('POST', '/api/calendars', { name: 'Work' });
  for (const [i, s] of ['free', 'elsewhere', 'tentative', 'busy', 'oof'].entries()) await api('POST', '/api/events', { calendarId: work.id, title: s, start: T + i * H, end: T + (i + 1) * H, showAs: s });
  const evs = await list();
  assert.deepEqual(evs.map((e) => [e.title, e.showAs, e.busy]), [['free', 'free', false], ['elsewhere', 'elsewhere', false], ['tentative', 'tentative', true], ['busy', 'busy', true], ['oof', 'oof', true]]);
  // The older busy flag still works, and resets the status.
  const e = evs.find((x) => x.title === 'oof');
  await api('PATCH', `/api/events/${e.id}`, { busy: false });
  assert.equal((await list()).find((x) => x.id === e.id).showAs, 'free');
  const { repo } = { repo: await import('../src/calendar/repo.js') };
  const slots = repo.findFreeSlots(uid, T, T + 5 * H, 60, { workStart: '00:00', workEnd: '23:59' });
  assert.ok(!slots.some((s) => s.start < T + 4 * H && s.end > T + 2 * H), 'no slot over tentative / busy');
});

test('the status is read from and written to calendar data (Outlook busy status)', async () => {
  const { parseIcs, buildIcs } = await import('../src/calendar/ics.js');
  const ics = (extra) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:x1', 'DTSTAMP:20310101T000000Z', 'DTSTART:20310303T090000Z', 'DTEND:20310303T100000Z', 'SUMMARY:X', ...extra, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  assert.equal(parseIcs(ics(['X-MICROSOFT-CDO-BUSYSTATUS:WORKINGELSEWHERE'])).events[0].showAs, 'elsewhere');
  assert.equal(parseIcs(ics(['X-MICROSOFT-CDO-BUSYSTATUS:BUSY', 'X-MICROSOFT-CDO-INTENDEDSTATUS:OOF'])).events[0].showAs, 'oof');
  assert.equal(parseIcs(ics(['TRANSP:TRANSPARENT'])).events[0].showAs, undefined);
  const out = buildIcs([{ uid: 'y', title: 'Y', start: T, end: T + H, eventShowAs: 'oof' }]);
  assert.match(out, /TRANSP:OPAQUE/); assert.match(out, /X-MICROSOFT-CDO-BUSYSTATUS:OOF/);
  const free = buildIcs([{ uid: 'z', title: 'Z', start: T, end: T + H, eventShowAs: 'free' }]);
  assert.match(free, /TRANSP:TRANSPARENT/); assert.doesNotMatch(free, /BUSYSTATUS/);
  // Imported into a calendar: kept; refreshed without the status: back to plain busy / free.
  const cal = await api('POST', '/api/calendars', { name: 'Imported' });
  const { importIcsInto } = await import('../src/calendar/caldav.js');
  importIcsInto(uid, cal.id, ics(['X-MICROSOFT-CDO-BUSYSTATUS:TENTATIVE']));
  assert.equal(db.prepare('SELECT show_as FROM events WHERE calendar_id = ?').get(cal.id).show_as, 'tentative');
  importIcsInto(uid, cal.id, ics([]));
  assert.equal(db.prepare('SELECT show_as FROM events WHERE calendar_id = ?').get(cal.id).show_as, null);
});

test('in a free, informational or read-only calendar the user can mark one event busy (kept in Halcyon only)', async () => {
  const info = await api('POST', '/api/calendars', { name: 'Conferences', showAs: 'info' });
  const free = await api('POST', '/api/calendars', { name: 'Team', showAs: 'free' });
  const a = await api('POST', '/api/events', { calendarId: info.id, title: 'Talk I attend', start: T + 20 * H, end: T + 21 * H });
  const b = await api('POST', '/api/events', { calendarId: free.id, title: 'Team offsite', start: T + 21 * H, end: T + 22 * H, rrule: 'FREQ=DAILY;COUNT=3' });
  db.prepare('UPDATE calendars SET readonly = 1 WHERE id = ?').run(info.id);
  const by = async (t) => (await list()).find((e) => e.title === t);
  assert.deepEqual([(await by('Talk I attend')).showAs, (await by('Talk I attend')).busy], ['info', false]);
  const { listRange } = await import('../src/calendar/repo.js');
  assert.ok(!listRange(uid, T, T + 24 * H, null, { includeInfo: false }).some((e) => e.title === 'Talk I attend'), 'informational: not in the brief');

  await api('PUT', `/api/events/${a.id}/my-show-as`, { showAs: 'busy' });
  await api('PUT', `/api/events/${b.id}/my-show-as`, { showAs: 'oof' });
  const ta = await by('Talk I attend');
  assert.deepEqual([ta.showAs, ta.busy, ta.myShowAs, ta.calendarShowAs], ['busy', true, 'busy', 'info']);
  assert.ok(listRange(uid, T, T + 24 * H, null, { includeInfo: false }).some((e) => e.title === 'Talk I attend'), 'marked busy: in the brief');
  assert.equal((await by('Team offsite')).showAs, 'oof');
  assert.equal(db.prepare('SELECT dirty FROM events WHERE id = ?').get(a.id).dirty, 0, 'nothing to push');

  // A refresh of the calendar keeps the choice.
  const { importIcsInto } = await import('../src/calendar/caldav.js');
  const uidA = db.prepare('SELECT uid FROM events WHERE id = ?').get(a.id).uid;
  importIcsInto(uid, info.id, ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', `UID:${uidA}`, 'DTSTAMP:20310101T000000Z', `DTSTART:${new Date(T + 20 * H).toISOString().replace(/[-:]|\.\d{3}/g, '')}`,
    `DTEND:${new Date(T + 21 * H).toISOString().replace(/[-:]|\.\d{3}/g, '')}`, 'SUMMARY:Talk I attend (room 2)', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n'), { replace: true });
  assert.equal((await by('Talk I attend (room 2)')).showAs, 'busy');

  await api('PUT', `/api/events/${a.id}/my-show-as`, { showAs: null });
  assert.equal((await by('Talk I attend (room 2)')).showAs, 'info', 'back to the calendar');
});
