// A local default calendar / task list next to synced ones: what is in it is moved to the server (what the server
// already has is skipped); subscriptions refresh in place (unchanged events keep their ids and timestamps).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r45-test-'));
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
const ics = (events) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:t\r\n${events.map(([u, title, day]) => `BEGIN:VEVENT\r\nUID:${u}\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:202611${day}T080000Z\r\nDTEND:202611${day}T090000Z\r\nSUMMARY:${title}\r\nEND:VEVENT\r\n`).join('')}END:VCALENDAR\r\n`;

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

test('events of a local calendar move to a synced one; what it already has is skipped', async () => {
  const acc = db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, mail, created_at) VALUES (?, 'me@example.org', 0, 0, ?)").run(uid, Date.now()).lastInsertRowid;
  const local = db.prepare("SELECT id FROM calendars WHERE user_id = ? AND source = 'local'").get(uid).id;
  const dav = db.prepare("INSERT INTO calendars (user_id, account_id, name, color, source, url, created_at) VALUES (?, ?, 'Default calendar', '#000', 'caldav', 'https://dav.example/cal/', ?)").run(uid, acc, Date.now()).lastInsertRowid;
  await api('POST', `/api/calendars/${local}/import`, { ics: ics([['a', 'Mine', '02'], ['b', 'Also on the server', '03']]) });
  db.prepare("INSERT INTO events (calendar_id, uid, title, start, \"end\", href, etag) VALUES (?, 'b', 'Also on the server', 1, 2, 'https://dav.example/cal/b.ics', 'e1')").run(dav);
  const cals = await api('GET', '/api/calendars');
  assert.equal(cals.find((c) => c.id === dav).origin, 'me@example.org · synced');
  assert.equal(cals.find((c) => c.id === local).origin, 'Kept in Halcyon only (on no other server)');
  const r = await api('POST', `/api/calendars/${local}/move-events`, { to: dav });
  assert.deepEqual(r, { moved: 1, skipped: 1 });
  const moved = db.prepare("SELECT calendar_id, dirty, href FROM events WHERE uid = 'a'").get();
  assert.deepEqual([moved.calendar_id, moved.dirty, moved.href], [dav, 1, null], 'to be saved on the server');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE uid = 'b'").get().n, 2, 'the duplicate stays where it was');
  await assert.rejects(api('POST', `/api/calendars/${dav}/move-events`, { to: local }), /kept in Halcyon/);
});

test('tasks of a local list move to a synced list', async () => {
  const [def] = await api('GET', '/api/task-lists');
  const dav = db.prepare("INSERT INTO task_lists (user_id, name, source, url, created_at) VALUES (?, 'Default calendar', 'caldav', 'https://dav.example/cal/', ?)").run(uid, Date.now()).lastInsertRowid;
  await api('POST', '/api/tasks', { title: 'One' });
  await api('POST', '/api/tasks', { title: 'Two' });
  const r = await api('POST', `/api/task-lists/${def.id}/move-tasks`, { to: dav });
  assert.deepEqual(r, { moved: 2, skipped: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE list_id = ? AND dirty = 1', ).get(dav).n, 2);
  assert.ok((await api('GET', '/api/task-lists')).every((l) => l.origin));
});

test('a subscription refreshed in place: unchanged events keep their id and timestamp, gone ones are removed', async () => {
  const { importIcsInto } = await import('../src/calendar/caldav.js');
  const cal = db.prepare("INSERT INTO calendars (user_id, name, color, source, url, readonly, created_at) VALUES (?, 'Holidays', '#000', 'subscription', 'https://x.example/h.ics', 1, ?)").run(uid, Date.now()).lastInsertRowid;
  importIcsInto(uid, cal, ics([['h1', 'One', '10'], ['h2', 'Two', '11'], ['h3', 'Three', '12']]));
  const before = Object.fromEntries(db.prepare('SELECT uid, id, updated_at FROM events WHERE calendar_id = ?').all(cal).map((e) => [e.uid, e]));
  await new Promise((r) => setTimeout(r, 20));
  importIcsInto(uid, cal, ics([['h1', 'One', '10'], ['h2', 'Two moved', '11']]), { replace: true });
  const now = Object.fromEntries(db.prepare('SELECT uid, id, updated_at, title FROM events WHERE calendar_id = ?').all(cal).map((e) => [e.uid, e]));
  assert.deepEqual(Object.keys(now).sort(), ['h1', 'h2']);
  assert.deepEqual([now.h1.id, now.h1.updated_at], [before.h1.id, before.h1.updated_at], 'unchanged: untouched');
  assert.equal(now.h2.id, before.h2.id);
  assert.ok(now.h2.updated_at > before.h2.updated_at);
  assert.equal(now.h2.title, 'Two moved');
});

test('events saved on a CalDAV server tell it not to send invitations itself', async () => {
  const { buildIcs } = await import('../src/calendar/ics.js');
  const e = { uid: 'x', title: 'Meet', start: Date.UTC(2026, 10, 2, 8), end: Date.UTC(2026, 10, 2, 9), organizer: { email: 'me@example.org' }, attendees: [{ email: 'ana@x.example', status: 'needs-action' }] };
  const server = buildIcs([e], { clientScheduling: true }).replace(/\r\n /g, '');
  assert.match(server, /ATTENDEE;[^\r\n]*SCHEDULE-AGENT=CLIENT:mailto:ana@x\.example/);
  assert.match(server, /ORGANIZER;[^\r\n]*SCHEDULE-AGENT=CLIENT:mailto:me@example\.org/);
  assert.doesNotMatch(buildIcs([e], { method: 'REQUEST' }), /SCHEDULE-AGENT/, 'invitations sent by Halcyon itself are plain');
});
