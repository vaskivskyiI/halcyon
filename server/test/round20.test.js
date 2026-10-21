// Accepted invitations go to the receiving account's calendar (or the one chosen on the card / in the account's
// settings), and events can be moved between calendars.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r20-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, uid, ingestMessage, n = 0;
const acc = {}, cal = {};
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
const ics = (u) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'METHOD:REQUEST', 'BEGIN:VEVENT', `UID:${u}`, 'DTSTAMP:20260101T000000Z', 'DTSTART:20261110T080000Z', 'DTEND:20261110T090000Z',
  `SUMMARY:Meeting ${u}`, 'ORGANIZER:mailto:ana@x.example', 'ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:work@ijs.example', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
async function invite(account, u) {
  const folder = db.prepare("SELECT * FROM folders WHERE account_id = ? AND path = 'INBOX'").get(account.id);
  return (await ingestMessage({ account, folder, uid: ++n, flags: [], raw: Buffer.from(`Message-ID: <${u}@x>\r\nFrom: ana@x.example\r\nTo: ${account.email}\r\nSubject: Invite\r\nMIME-Version: 1.0\r\nContent-Type: text/calendar; method=REQUEST\r\n\r\n${ics(u)}`) })).id;
}
const calendarOf = (u) => db.prepare('SELECT calendar_id FROM events WHERE uid = ? AND deleted = 0').get(u)?.calendar_id;

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  ({ ingestMessage } = await import('../src/mail/store.js'));
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  await api('PATCH', '/api/settings', { mail: { undoSendSeconds: 600 }, ai: { enabled: false } });
  for (const [k, email] of [['private', 'me@example.org'], ['work', 'work@ijs.example']]) {
    acc[k] = db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare('INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, ?, 0, ?)').run(uid, email, Date.now()).lastInsertRowid);
    db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'INBOX', '\\Inbox')").run(acc[k].id);
  }
  const mk = (name, accountId, extra = '') => db.prepare(`INSERT INTO calendars (user_id, account_id, name, color, source, created_at${extra ? ', is_default' : ''}) VALUES (?, ?, ?, '#888', ?, ?${extra ? ', 1' : ''})`)
    .run(uid, accountId, name, accountId ? 'caldav' : 'local', Date.now()).lastInsertRowid;
  cal.home = mk('Home', null, 'default');            // the general default calendar
  cal.birthdays = mk('Birthdays', acc.work.id);      // the work account's calendars
  cal.work = mk('Calendar', acc.work.id);
  cal.other = mk('Projects', null);
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('an accepted invitation goes to the calendar of the account that received it', async () => {
  const id = await invite(acc.work, 'inv-a');
  const card = await api('GET', `/api/messages/${id}/invitation`);
  assert.equal(card.defaultCalendarId, cal.work, 'the work account\'s main calendar, not its Birthdays nor the general default');
  assert.ok(card.calendars.some((c) => c.id === cal.other), 'every writable calendar can be chosen');
  const r = await api('POST', `/api/messages/${id}/invitation/respond`, { response: 'accept', sendReply: false });
  assert.equal(calendarOf('inv-a'), cal.work);
  assert.equal(r.calendar.name, 'Calendar');
});

test('another calendar can be chosen on the card, and per account in its settings', async () => {
  const id = await invite(acc.work, 'inv-b');
  await api('POST', `/api/messages/${id}/invitation/respond`, { response: 'accept', sendReply: false, calendarId: cal.other });
  assert.equal(calendarOf('inv-b'), cal.other);
  await api('PATCH', `/api/accounts/${acc.work.id}`, { inviteCalendarId: cal.home });
  assert.equal((await api('GET', '/api/accounts')).find((a) => a.id === acc.work.id).inviteCalendarId, cal.home);
  const id2 = await invite(acc.work, 'inv-c');
  assert.equal((await api('GET', `/api/messages/${id2}/invitation`)).defaultCalendarId, cal.home);
  await api('POST', `/api/messages/${id2}/invitation/respond`, { response: 'tentative', sendReply: false });
  assert.equal(calendarOf('inv-c'), cal.home);
  // Answering again with another calendar moves it there.
  await api('POST', `/api/messages/${id2}/invitation/respond`, { response: 'accept', sendReply: false, calendarId: cal.other });
  assert.equal(calendarOf('inv-c'), cal.other);
});

test('an event moves to another calendar (with its changed occurrences), also out of a server calendar', async () => {
  const ev = await api('POST', '/api/events', { calendarId: cal.work, title: 'Weekly', start: Date.UTC(2026, 10, 2, 9), end: Date.UTC(2026, 10, 2, 10), rrule: 'FREQ=WEEKLY;COUNT=3' });
  await api('PATCH', `/api/events/${ev.id}`, { scope: 'this', occurrence: Date.UTC(2026, 10, 9, 9), title: 'Weekly (moved)' });
  db.prepare("UPDATE events SET href = 'https://dav.example/cal/w.ics', etag = 'e1', dirty = 0 WHERE uid = ?").run(ev.uid); // as if on the server
  const moved = await api('PATCH', `/api/events/${ev.id}`, { calendarId: cal.other, title: 'Weekly sync' });
  assert.equal(moved.calendarId, cal.other); assert.equal(moved.title, 'Weekly sync');
  const rows = db.prepare('SELECT calendar_id, deleted, dirty, href, recurrence_id FROM events WHERE uid = ? ORDER BY calendar_id, recurrence_id').all(ev.uid);
  const there = rows.filter((r) => r.calendar_id === cal.other);
  assert.equal(there.length, 2, 'master and the changed occurrence moved'); assert.ok(there.every((r) => !r.deleted && !r.href));
  const left = rows.filter((r) => r.calendar_id === cal.work);
  assert.ok(left.length && left.every((r) => r.deleted === 1 && r.dirty === 1), 'old server copy is deleted there on the next sync');
  const list = await api('GET', `/api/events?from=${Date.UTC(2026, 10, 1)}&to=${Date.UTC(2026, 10, 30)}`);
  assert.ok(list.filter((e) => e.uid === ev.uid).every((e) => e.calendarId === cal.other));
  assert.equal(list.filter((e) => e.uid === ev.uid).length, 3, 'all three occurrences shown once');
});
