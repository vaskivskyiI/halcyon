// Invitations are recognised however they are packaged (Exchange with Windows time zones, octet-stream attachments,
// forwarded invitations), older mail is re-checked when opened, and unreadable calendar data is reported, not hidden.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r17-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, account, inbox, ingestMessage, n = 0;
async function api(method, url, body, { raw = false } = {}) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  if (raw) return r;
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
const b64 = (s) => Buffer.from(s).toString('base64').replace(/.{76}/g, '$&\r\n');
const ICS = [
  'BEGIN:VCALENDAR', 'METHOD:REQUEST', 'PRODID:Microsoft Exchange Server 2010', 'VERSION:2.0',
  'BEGIN:VTIMEZONE', 'TZID:Central Europe Standard Time',
  'BEGIN:STANDARD', 'DTSTART:16010101T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10', 'END:STANDARD',
  'BEGIN:DAYLIGHT', 'DTSTART:16010101T020000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3', 'END:DAYLIGHT',
  'END:VTIMEZONE', 'BEGIN:VEVENT', 'ORGANIZER;CN=Ana Novak:mailto:ana@x.example', 'ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:me@example.org',
  'UID:r17-1', 'SUMMARY;LANGUAGE=en-US:Plan review', 'DTSTART;TZID=Central Europe Standard Time:20261022T080000', 'DTEND;TZID=Central Europe Standard Time:20261022T090000',
  'DTSTAMP:20261020T101010Z', 'X-MICROSOFT-CDO-BUSYSTATUS:TENTATIVE', 'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n');
const msg = (subject, contentType, body) => Buffer.from([`Message-ID: <r17-${++n}@x>`, 'From: Ana Novak <ana@x.example>', 'To: me@example.org', `Subject: ${subject}`,
  `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0', `Content-Type: ${contentType}`, '', body].join('\r\n'));
const ingest = async (raw) => (await ingestMessage({ account, folder: inbox, uid: ++n, flags: [], raw })).id;
const card = (id) => api('GET', `/api/messages/${id}/invitation`);

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  ({ ingestMessage } = await import('../src/mail/store.js'));
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  const uid = db.prepare('SELECT id FROM users').get().id;
  await api('PATCH', '/api/settings', { calendar: { timezone: 'Europe/Ljubljana', tzAuto: false }, ai: { enabled: false } });
  account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, 'me@example.org', 0, ?)").run(uid, Date.now()).lastInsertRowid);
  inbox = db.prepare('SELECT * FROM folders WHERE id = ?').get(db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'INBOX', '\\Inbox')").run(account.id).lastInsertRowid);
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('an Exchange invitation (Windows time zone, base64 calendar part) shows the event at the right time', async () => {
  const id = await ingest(msg('Plan review', 'multipart/alternative; boundary="b"', ['--b', 'Content-Type: text/html; charset=utf-8', '', '<p>Hi, let us review the plan.</p>',
    '--b', 'Content-Type: text/calendar; charset="utf-8"; method=REQUEST', 'Content-Transfer-Encoding: base64', '', b64(ICS), '--b--', ''].join('\r\n')));
  const m = await api('GET', `/api/messages/${id}`);
  assert.equal(m.hasInvite, true); assert.match(m.html, /review the plan/);
  const c = await card(id);
  assert.equal(c.event.title, 'Plan review');
  assert.equal(new Date(c.event.start).toISOString(), '2026-10-22T06:00:00.000Z', '08:00 in Ljubljana');
});

test('calendar data in an attachment with a generic type, and in a forwarded invitation, is found', async () => {
  const octet = await ingest(msg('Meeting', 'multipart/mixed; boundary="m"', ['--m', 'Content-Type: text/plain', '', 'See attached.',
    '--m', 'Content-Type: application/octet-stream; name="meeting"', 'Content-Disposition: attachment; filename="meeting"', 'Content-Transfer-Encoding: base64', '', b64(ICS), '--m--', ''].join('\r\n')));
  assert.equal((await card(octet)).event.title, 'Plan review');
  const inner = msg('Plan review', 'multipart/alternative; boundary="b"', ['--b', 'Content-Type: text/plain', '', 'Original text',
    '--b', 'Content-Type: text/calendar; method=REQUEST', 'Content-Transfer-Encoding: base64', '', b64(ICS), '--b--', ''].join('\r\n')).toString();
  const fwd = await ingest(msg('Fwd: Plan review', 'multipart/mixed; boundary="f"', ['--f', 'Content-Type: text/plain', '', 'FYI, see the invitation below.',
    '--f', 'Content-Type: message/rfc822', 'Content-Disposition: attachment', '', inner, '--f--', ''].join('\r\n')));
  const m = await api('GET', `/api/messages/${fwd}`);
  assert.equal(m.hasInvite, true); assert.match(m.text, /FYI/);
  assert.equal((await card(fwd)).event.title, 'Plan review');
});

test('older mail is checked again for an invitation when opened', async () => {
  const id = await ingest(msg('Old invite', 'multipart/mixed; boundary="m"', ['--m', 'Content-Type: text/plain', '', 'Old text',
    '--m', 'Content-Type: application/octet-stream', 'Content-Transfer-Encoding: base64', '', b64(ICS), '--m--', ''].join('\r\n')));
  db.prepare('UPDATE messages SET calendar_ics = NULL WHERE id = ?').run(id); // as stored by an older version
  assert.equal((await api('GET', `/api/messages/${id}`)).hasInvite, true);
  assert.ok(db.prepare('SELECT calendar_ics FROM messages WHERE id = ?').get(id).calendar_ics.includes('BEGIN:VEVENT'));
  const plain = await ingest(msg('No invite', 'text/plain', 'Just text'));
  db.prepare('UPDATE messages SET calendar_ics = NULL WHERE id = ?').run(plain);
  assert.equal((await api('GET', `/api/messages/${plain}`)).hasInvite, false);
  assert.equal(db.prepare('SELECT calendar_ics FROM messages WHERE id = ?').get(plain).calendar_ics, '', 'checked once, remembered');
});

test('calendar data that cannot be read is reported, and can be downloaded', async () => {
  const id = await ingest(msg('Broken', 'multipart/mixed; boundary="m"', ['--m', 'Content-Type: text/plain', '', 'Body',
    '--m', 'Content-Type: text/calendar', '', 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:not-a-date\r\nEND:VEVENT\r\nEND:VCALENDAR', '--m--', ''].join('\r\n')));
  const c = await card(id);
  assert.ok(!c.event); assert.match(c.error, /could not be read|without an event/);
  await assert.rejects(() => api('POST', `/api/messages/${id}/invitation/respond`, { response: 'accept' }), /could not be read|without an event/);
  const r = await api('GET', `/api/messages/${id}/invitation.ics`, undefined, { raw: true });
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/calendar/); assert.match(await r.text(), /BEGIN:VCALENDAR/);
});
