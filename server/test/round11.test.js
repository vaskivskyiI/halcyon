// Time zone end to end: a server that still reads times in UTC is corrected by the browser's zone on any request;
// AI-read events and server-computed task due times keep their wall-clock time, times the user picked do not move;
// a zone the model invents (not in the email) is ignored.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r11-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, account, inbox, uid;

async function api(method, url, body, headers = {}) {
  const r = await fetch(base + url, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
const iso = (t) => new Date(t).toISOString();

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  // A container in UTC: the server's own default.
  await api('PATCH', '/api/settings', { calendar: { timezone: 'UTC' }, ai: { enabled: false } });
  account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, 'me@example.org', 0, ?)").run(uid, Date.now()).lastInsertRowid);
  inbox = db.prepare('SELECT * FROM folders WHERE id = ?').get(db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'INBOX', '\\Inbox')").run(account.id).lastInsertRowid);
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('read in UTC, then corrected by the browser zone: events and server-read due times keep 08:00, picked times stay', async () => {
  const mid = Number(db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, message_id, thread_id, subject, from_name, from_addr, to_json, cc_json, date, created_at)
    VALUES (?, ?, ?, 'm1@x', 't1', 'Meeting', 'Ana', 'ana@x.example', '[]', '[]', ?, ?)`).run(uid, account.id, inbox.id, Date.now(), Date.now()).lastInsertRowid);
  const { normalizeEvent } = await import('../src/util/time.js');
  const ev = normalizeEvent({ title: 'Meeting', date: '2026-10-22', start_time: '08:00' }, 'UTC', { text: 'See you Thursday at 8:00' });
  db.prepare('INSERT INTO ai_insights (message_id, events_json, action_items_json, created_at) VALUES (?, ?, ?, ?)')
    .run(mid, JSON.stringify([ev]), JSON.stringify([{ text: 'Prepare slides', due: '2026-10-22T08:00' }]), Date.now());
  // Tasks while the server still thinks it is UTC: one typed ("... tomorrow at 10"), one from the email, one picked.
  const typed = await api('POST', '/api/tasks', { text: 'Call the bank on 2026-10-23 at 10:00' });
  const proposal = await api('GET', `/api/tasks/from-message/${mid}`);
  assert.equal(iso(proposal.items[0].due), '2026-10-22T08:00:00.000Z', 'read in UTC (the bug)');
  const [fromMail] = await api('POST', `/api/tasks/from-message/${mid}`, { items: proposal.items });
  const picked = await api('POST', '/api/tasks', { title: 'Picked', due: Date.parse('2026-10-24T07:00:00Z') });
  assert.equal(db.prepare('SELECT due_tz FROM tasks WHERE id = ?').get(fromMail.id).due_tz, 'UTC');

  // Any request from a browser in Ljubljana corrects it.
  await api('GET', '/api/tasks', undefined, { 'x-halcyon-tz': encodeURIComponent('Europe/Ljubljana') });
  const me = await api('GET', '/api/me');
  assert.equal(me.settings.calendar.timezone, 'Europe/Ljubljana');
  const stored = JSON.parse(db.prepare('SELECT events_json FROM ai_insights WHERE message_id = ?').get(mid).events_json)[0];
  assert.equal(stored.start, '2026-10-22T06:00:00.000Z', 'event: 08:00 in Ljubljana');
  const due = (id) => iso(db.prepare('SELECT due FROM tasks WHERE id = ?').get(id).due);
  assert.equal(due(fromMail.id), '2026-10-22T06:00:00.000Z', 'task from the email: 08:00 in Ljubljana');
  if (typed.due) assert.equal(due(typed.id), '2026-10-23T08:00:00.000Z', 'typed task: 10:00 in Ljubljana');
  assert.equal(due(picked.id), '2026-10-24T07:00:00.000Z', 'picked time unchanged');
  // New proposals are read in the right zone straight away.
  assert.equal(iso((await api('GET', `/api/tasks/from-message/${mid}`)).items[0].due), '2026-10-22T06:00:00.000Z');
});

test('a time zone the model adds but the email does not state is ignored', async () => {
  const { normalizeEvent } = await import('../src/util/time.js');
  const tz = 'Europe/Ljubljana';
  const e = { date: '2026-10-22', start_time: '08:00', tz: 'UTC' };
  assert.equal(normalizeEvent(e, tz, { text: 'Meeting on Thursday at 8:00.' }).start, '2026-10-22T06:00:00.000Z', 'invented UTC ignored');
  assert.equal(normalizeEvent(e, tz, { text: 'The call is at 08:00 UTC.' }).start, '2026-10-22T08:00:00.000Z', 'stated UTC used');
  const cet = { date: '2026-10-22', start_time: '08:00', tz: 'CET' };
  assert.equal(normalizeEvent(cet, tz, { text: 'Some facet of the plan, 8:00' }).read.tz, tz, '"CET" inside a word is not a stated zone');
  assert.deepEqual(normalizeEvent(e, tz, { text: 'at 8' }).read, { date: '2026-10-22', time: '08:00', tz });
});

test('with "use this device\'s time zone" off, the browser does not change it', async () => {
  await api('PATCH', '/api/settings', { calendar: { tzAuto: false, timezone: 'America/New_York' } });
  await api('GET', '/api/tasks', undefined, { 'x-halcyon-tz': 'Asia/Tokyo' });
  assert.equal((await api('GET', '/api/me')).settings.calendar.timezone, 'America/New_York');
});
