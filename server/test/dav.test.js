// Two-way CalDAV / CardDAV sync against a real DAV server (e.g. Radicale). Skipped unless TEST_DAV_URL is set.
// Expects a user with a calendar collection and an address book, e.g. Radicale at http://127.0.0.1:5232/alice/.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { waitFor } from './helpers.js';

const DAV = process.env.TEST_DAV_URL;
const DAV_USER = process.env.TEST_DAV_USER || 'alice';
const DAV_PASS = process.env.TEST_DAV_PASS || 'secret123';
const opts = { skip: !DAV && 'set TEST_DAV_URL to run DAV sync tests' };

let app, base, cookie = '', account;
const auth = 'Basic ' + Buffer.from(`${DAV_USER}:${DAV_PASS}`).toString('base64');
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
const davList = async (coll) => {
  const r = await fetch(new URL(coll, DAV), { method: 'PROPFIND', headers: { authorization: auth, depth: '1' } });
  return (await r.text()).match(/<[^>]*href>[^<]+<\/[^>]*href>/g)?.map((h) => h.replace(/<[^>]+>/g, '')) || [];
};
const davGet = async (href) => { const r = await fetch(new URL(href, DAV), { headers: { authorization: auth } }); const t = await r.text(); if (!r.ok) throw new Error(`GET ${href} → ${r.status} ${t.slice(0, 200)}`); return t; };

before(async () => {
  if (!DAV) return;
  process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-dav-'));
  process.env.HALCYON_LOG_LEVEL ||= 'warn';
  const { buildServer } = await import('../src/index.js');
  app = await buildServer();
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  await api('POST', '/api/auth/setup', { email: 'dav@example.com', password: 'password123' });
});
after(async () => { if (app) { const { syncManager } = await import('../src/mail/sync.js'); await syncManager.stopAll(); await app.close(); } });

test('initial pull of remote calendars, events and contacts', opts, async () => {
  account = await api('POST', '/api/accounts', {
    email: 'alice@test.local', imap: { host: '127.0.0.1', port: 1143, secure: false, password: 'secret123' }, smtp: { host: '127.0.0.1', port: 1, secure: false },
    caldavUrl: DAV, carddavUrl: DAV, davUser: DAV_USER, davPassword: DAV_PASS, syncEnabled: false,
  });
  const cal = await waitFor(async () => (await api('GET', '/api/calendars')).find((c) => c.source === 'caldav' && c.name === 'Work'), { label: 'remote calendar' });
  const events = await waitFor(async () => { const e = await api('GET', `/api/events?from=${Date.UTC(2026, 9, 1)}&to=${Date.UTC(2026, 10, 1)}`); return e.some((x) => x.title.startsWith('Remote planning')) && e; }, { label: 'remote event' });
  assert.equal(events.find((x) => x.title.startsWith('Remote planning')).calendarId, cal.id);
  await waitFor(async () => (await api('GET', '/api/contacts?filter=all')).some((c) => c.displayName === 'Remote Person'), { label: 'remote contact' });
});

test('local changes are pushed: create, update, delete event; create contact', opts, async () => {
  const cal = (await api('GET', '/api/calendars')).find((c) => c.name === 'Work');
  const ev = await api('POST', '/api/events', { calendarId: cal.id, title: 'Pushed from Halcyon', start: Date.UTC(2026, 9, 22, 10), end: Date.UTC(2026, 9, 22, 11), rrule: 'FREQ=WEEKLY;COUNT=3' });
  await api('POST', `/api/calendars/${cal.id}/refresh`);
  const href = await waitFor(async () => (await davList('cal1/')).find((h) => h.includes(ev.uid)), { label: 'event on server' });
  const ics = await davGet(href);
  assert.match(ics, /SUMMARY:Pushed from Halcyon/);
  assert.match(ics, /RRULE:FREQ=WEEKLY;COUNT=3/);

  await api('PATCH', `/api/events/${ev.id}`, { title: 'Renamed in Halcyon' });
  await api('POST', `/api/calendars/${cal.id}/refresh`);
  await waitFor(async () => /SUMMARY:Renamed in Halcyon/.test(await davGet(href)), { label: 'event updated on server' });

  await api('DELETE', `/api/events/${ev.id}`);
  await api('POST', `/api/calendars/${cal.id}/refresh`);
  await waitFor(async () => !(await davList('cal1/')).some((h) => h.includes(ev.uid)), { label: 'event deleted on server' });

  const book = (await api('GET', '/api/address-books')).find((b) => b.source === 'carddav');
  const c = await api('POST', '/api/contacts', { addressBookId: book.id, firstName: 'Neža', lastName: 'Kranjc', emails: [{ type: 'work', value: 'neza@example.si' }] });
  await api('POST', `/api/accounts/${account.id}/sync`);
  const chref = await waitFor(async () => (await davList('book1/')).find((h) => h.includes(c.uid)), { label: 'contact on server' });
  assert.match(await davGet(chref), /FN:Neža Kranjc/);
});

test('remote changes are pulled', opts, async () => {
  const r = await fetch(new URL('cal1/ev1.ics', DAV), { method: 'PUT', headers: { authorization: auth, 'content-type': 'text/calendar' },
    body: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:test\r\nBEGIN:VEVENT\r\nUID:remote-ev-1\r\nDTSTAMP:20260102T000000Z\r\nDTSTART:20261021T080000Z\r\nDTEND:20261021T093000Z\r\nSUMMARY:Remote planning (moved)\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n' });
  assert.ok(r.ok);
  const cal = (await api('GET', '/api/calendars')).find((c) => c.name === 'Work');
  await api('POST', `/api/calendars/${cal.id}/refresh`);
  await waitFor(async () => (await api('GET', `/api/events?from=${Date.UTC(2026, 9, 1)}&to=${Date.UTC(2026, 10, 1)}`)).some((x) => x.title === 'Remote planning (moved)'), { label: 'remote update pulled' });
});
