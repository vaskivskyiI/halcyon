// Extra read-only calendars: ICS links (Google / Outlook secret address, webcal) and CalDAV servers that are not a
// mail account; their events can be read but never changed. The CalDAV part needs TEST_DAV_URL (setup-radicale.sh).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r12-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';
const DAV = process.env.TEST_DAV_URL;

let app, base, cookie = '', db, icsServer, icsBase, icsBody;

async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) { const e = new Error(data.error || `${r.status}`); e.status = r.status; throw e; }
  return data;
}
const ics = (title, start) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:test\r\nBEGIN:VEVENT\r\nUID:sub-${title}\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:${start}\r\nDTEND:${start.replace('T08', 'T09')}\r\nSUMMARY:${title}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

before(async () => {
  icsBody = ics('Team offsite', '20261021T080000Z');
  icsServer = http.createServer((req, res) => {
    if (req.url === '/cal.ics') { res.writeHead(200, { 'content-type': 'text/calendar' }); res.end(icsBody); }
    else if (req.url === '/page') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>login</html>'); }
    else { res.writeHead(404); res.end(); }
  }).listen(0, '127.0.0.1');
  await new Promise((r) => icsServer.once('listening', r));
  icsBase = `http://127.0.0.1:${icsServer.address().port}`;
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
});
after(async () => { await app?.close(); icsServer?.close(); setTimeout(() => process.exit(0), 50).unref(); });

let subId, subEvent;
test('a calendar link is subscribed read-only; a wrong link is refused with a reason', async () => {
  await assert.rejects(() => api('POST', '/api/calendars', { name: 'Bad', url: `${icsBase}/page` }), /does not return a calendar/);
  await assert.rejects(() => api('POST', '/api/calendars', { name: 'Gone', url: `${icsBase}/missing.ics` }), /answered 404/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM calendars WHERE name IN ('Bad', 'Gone')").get().n, 0, 'nothing half-added');
  const c = await api('POST', '/api/calendars', { name: 'Shared', url: `${icsBase}/cal.ics`.replace('http:', 'webcal:').replace('webcal:', 'http:') });
  subId = c.id;
  assert.equal(c.readonly, true);
  const evs = await api('GET', `/api/events?from=${Date.parse('2026-10-21')}&to=${Date.parse('2026-10-22')}`);
  subEvent = evs.find((e) => e.title === 'Team offsite');
  assert.ok(subEvent); assert.equal(subEvent.readonly, true); assert.equal(subEvent.calendarName, 'Shared');
});

test('events of read-only calendars cannot be changed, moved, deleted, or created there', async () => {
  await assert.rejects(() => api('PATCH', `/api/events/${subEvent.id}`, { title: 'x' }), /read-only/);
  await assert.rejects(() => api('DELETE', `/api/events/${subEvent.id}`), /read-only/);
  await assert.rejects(() => api('POST', '/api/events', { calendarId: subId, title: 'x', start: Date.now(), end: Date.now() + 3600e3 }), /read-only/);
  const mine = await api('POST', '/api/events', { title: 'Mine', start: Date.parse('2026-10-21T08:30:00Z'), end: Date.parse('2026-10-21T09:30:00Z') });
  await assert.rejects(() => api('PATCH', `/api/events/${mine.id}`, { calendarId: subId }), /read-only/, 'cannot be moved into it');
  assert.equal(db.prepare('SELECT title FROM events WHERE id = ?').get(subEvent.id).title, 'Team offsite');
});

test('overlapping events are found for the editor (also from read-only calendars)', async () => {
  // The editor asks for events in the new event's time range: 08:30–09:30 overlaps the subscribed 08:00–09:00.
  const from = Date.parse('2026-10-21T08:30:00Z'), to = Date.parse('2026-10-21T09:30:00Z');
  const list = await api('GET', `/api/events?from=${from}&to=${to}`);
  const overlapping = list.filter((o) => o.start < to && o.end > from && o.title !== 'Mine');
  assert.deepEqual(overlapping.map((o) => o.title), ['Team offsite']);
});

test('a subscription that stops working is reported, and recovers', async () => {
  icsBody = 'not a calendar';
  await assert.rejects(() => api('POST', `/api/calendars/${subId}/refresh`, {}), /does not return a calendar/);
  const p = (await api('GET', '/api/status/problems')).problems.find((x) => x.key === `cal:${subId}`);
  assert.ok(p); assert.deepEqual(p.actions, ['refresh-calendar']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events WHERE calendar_id = ?').get(subId).n, 1, 'events kept while the link fails');
  icsBody = ics('Team offsite moved', '20261022T080000Z');
  await api('POST', `/api/calendars/${subId}/refresh`, {});
  assert.ok(!(await api('GET', '/api/status/problems')).problems.some((x) => x.key === `cal:${subId}`));
  assert.equal(db.prepare('SELECT title FROM events WHERE calendar_id = ?').get(subId).title, 'Team offsite moved');
});

test('a CalDAV server that cannot be read is refused and leaves nothing behind', async () => {
  await assert.rejects(() => api('POST', '/api/calendar-sources', { url: 'ftp://x' }), /CalDAV address/);
  await assert.rejects(() => api('POST', '/api/calendar-sources', { url: `${icsBase}/nothing/`, username: 'a', password: 'b' }), /Could not read calendars/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_sources').get().n, 0);
});

test('calendars from a CalDAV server are added read-only, and never written back', { skip: !DAV && 'set TEST_DAV_URL to run' }, async () => {
  const src = await api('POST', '/api/calendar-sources', { url: DAV, username: 'alice', password: 'secret123', name: 'Radicale' });
  assert.ok(src.calendars >= 1);
  assert.equal(JSON.stringify(src).includes('secret123'), false, 'password never returned');
  const cals = (await api('GET', '/api/calendars')).filter((c) => c.sourceId === src.id);
  assert.ok(cals.every((c) => c.readonly));
  const ev = db.prepare("SELECT e.id FROM events e JOIN calendars c ON c.id = e.calendar_id WHERE c.source_id = ? AND e.uid = 'remote-ev-1'").get(src.id);
  assert.ok(ev, 'remote event downloaded');
  await assert.rejects(() => api('PATCH', `/api/events/${ev.id}`, { title: 'changed' }), /read-only/);
  await api('POST', `/api/calendar-sources/${src.id}/refresh`, {});
  await api('DELETE', `/api/calendar-sources/${src.id}`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendars WHERE source_id = ?').get(src.id).n, 0);
});
