// Accepted invitations stay in the calendar: a save the calendar server refuses is kept locally and reported (it used
// to be taken for success and then removed by the next sync), and an event the server never received is saved again
// instead of disappearing. Needs TEST_DAV_URL (server/test/setup-radicale.sh); runs with "npm run test:servers".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DAV = process.env.TEST_DAV_URL;
const opts = { skip: !DAV && 'set TEST_DAV_URL to run' };
let app, base, cookie = '', db, account, cal;

async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
const davList = async () => {
  const r = await fetch(new URL('cal1/', DAV), { method: 'PROPFIND', headers: { depth: '1', authorization: `Basic ${Buffer.from('alice:secret123').toString('base64')}` } });
  return [...(await r.text()).matchAll(/<(?:\w+:)?href>([^<]+\.ics)</g)].map((m) => m[1]);
};

before(async () => {
  if (!DAV) return;
  process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r19-'));
  process.env.HALCYON_LOG_LEVEL = 'error';
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  await api('POST', '/api/auth/setup', { email: 'r19@example.com', password: 'password123' });
  account = await api('POST', '/api/accounts', {
    email: 'alice@test.local', imap: { host: '127.0.0.1', port: 1, secure: false, password: 'x' }, smtp: { host: '127.0.0.1', port: 1, secure: false },
    caldavUrl: DAV, davUser: 'alice', davPassword: 'secret123', syncEnabled: false,
  });
  for (let i = 0; i < 100 && !cal; i++) { cal = (await api('GET', '/api/calendars')).find((c) => c.source === 'caldav' && c.name === 'Work'); if (!cal) await new Promise((r) => setTimeout(r, 100)); }
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('a save the server refuses keeps the event and reports why', opts, async () => {
  // Same UID as an event already on the server under another name: Radicale refuses the new file.
  const ev = await api('POST', '/api/events', { calendarId: cal.id, title: 'Clashing UID', uid: 'remote-ev-1', start: Date.UTC(2026, 10, 3, 9), end: Date.UTC(2026, 10, 3, 10) });
  await api('POST', `/api/calendars/${cal.id}/refresh`, {}).catch(() => {});
  const row = db.prepare('SELECT title, dirty FROM events WHERE id = ?').get(ev.id);
  assert.ok(row, 'still in the calendar');
  assert.equal(row.dirty, 1, 'still waiting to be saved');
  const p = (await api('GET', '/api/status/problems')).problems.find((x) => x.key === `cal:${cal.id}`);
  assert.ok(p, 'reported'); assert.match(p.text, /could not be saved/);
  db.prepare('DELETE FROM events WHERE id = ?').run(ev.id);
});

test('an event the server never received is saved again, not removed', opts, async () => {
  const ev = await api('POST', '/api/events', { calendarId: cal.id, title: 'Accepted meeting', start: Date.UTC(2026, 10, 4, 9), end: Date.UTC(2026, 10, 4, 10) });
  // As left by the old code after a refused save: marked saved, with an address the server does not have.
  db.prepare("UPDATE events SET dirty = 0, etag = NULL, href = ? WHERE id = ?").run(new URL('cal1/never-there.ics', DAV).href, ev.id);
  db.prepare('UPDATE calendars SET ctag = NULL WHERE id = ?').run(cal.id);
  await api('POST', `/api/calendars/${cal.id}/refresh`, {});
  assert.ok(db.prepare('SELECT id FROM events WHERE uid = ?').get(ev.uid), 'not removed');
  await api('POST', `/api/calendars/${cal.id}/refresh`, {});
  assert.ok((await davList()).some((h) => h.includes(ev.uid.replace(/[^A-Za-z0-9_.-]/g, '_'))), 'now on the server');
});
