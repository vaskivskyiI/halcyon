// Tasks: lists in spaces (one space, or all together), repeating tasks, and two-way sync with a CalDAV server (VTODO).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r43-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';
const DAV = process.env.TEST_DAV_URL;

let app, base, cookie = '', db;
async function api(method, url, body, headers = {}) {
  const r = await fetch(base + url, { method, headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
const inSpace = (s) => ({ 'x-halcyon-space': encodeURIComponent(s) });

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  await api('POST', '/api/auth/setup', { email: 'alice@test.local', name: 'Alice', password: 'password123' });
  await api('PATCH', '/api/settings', { calendar: { timezone: 'Europe/Ljubljana' } });
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('task lists are in spaces: one space shows its lists, no space shows all of them', async () => {
  const [def] = await api('GET', '/api/task-lists');
  assert.equal(def.name, 'Tasks');
  assert.equal(def.isDefault, true);
  await api('PATCH', '/api/spaces/assign', { type: 'taskList', id: def.id, space: 'Work' });
  const home = await api('POST', '/api/task-lists', { name: 'Home', space: 'Private' });
  assert.equal(home.space, 'Private');
  // New tasks go to the list of the active space.
  const a = await api('POST', '/api/tasks', { title: 'Report' }, inSpace('Work'));
  const b = await api('POST', '/api/tasks', { title: 'Plants' }, inSpace('Private'));
  assert.deepEqual([a.listId, b.listId], [def.id, home.id]);
  const titles = async (h) => (await api('GET', '/api/tasks', undefined, h)).map((t) => t.title).sort();
  assert.deepEqual(await titles(inSpace('Work')), ['Report']);
  assert.deepEqual(await titles(inSpace('Private')), ['Plants']);
  assert.deepEqual(await titles({}), ['Plants', 'Report']);
  assert.deepEqual((await api('GET', '/api/task-lists', undefined, inSpace('Private'))).map((l) => l.name), ['Home']);
  // Moved to another list; a list kept in Halcyon can be deleted (not the last one).
  const moved = await api('PATCH', `/api/tasks/${b.id}`, { listId: def.id });
  assert.equal(moved.list, 'Tasks');
  await api('DELETE', `/api/task-lists/${home.id}`);
  await assert.rejects(api('DELETE', `/api/task-lists/${def.id}`), /only task list/);
  // Tasks made elsewhere without a list (follow-ups, MCP) land in the default list.
  db.prepare("INSERT INTO tasks (user_id, title, created_at, updated_at) VALUES ((SELECT id FROM users LIMIT 1), 'Loose', ?, ?)").run(Date.now(), Date.now());
  assert.ok((await api('GET', '/api/tasks')).some((t) => t.title === 'Loose' && t.listId === def.id));
});

test('a repeating task: done moves it to the next date and keeps the done occurrence', async () => {
  const due = Date.UTC(2026, 9, 20, 15, 0); // Tue 17:00 in Ljubljana (summer time)
  await assert.rejects(api('POST', '/api/tasks', { title: 'x', rrule: 'nonsense' }), /not understood/);
  const t = await api('POST', '/api/tasks', { title: 'Timesheet', due, rrule: 'FREQ=WEEKLY;COUNT=3' });
  assert.equal(t.rrule, 'FREQ=WEEKLY;COUNT=3');
  let r = await api('PATCH', `/api/tasks/${t.id}`, { done: true });
  assert.equal(r.done, false);
  // One week later at the same wall-clock time, also across the change to winter time (25 Oct).
  assert.equal(new Date(r.due).toLocaleString('en-GB', { timeZone: 'Europe/Ljubljana' }), '27/10/2026, 17:00:00');
  assert.equal(r.rrule, 'FREQ=WEEKLY;COUNT=2');
  assert.equal(r.completedCopy.done, true);
  assert.equal(r.completedCopy.due, due);
  assert.equal(r.completedCopy.rrule, null);
  r = await api('PATCH', `/api/tasks/${t.id}`, { done: true });
  assert.equal(r.rrule, 'FREQ=WEEKLY;COUNT=1');
  r = await api('PATCH', `/api/tasks/${t.id}`, { done: true });
  assert.equal(r.done, true, 'the last one is simply done');
  assert.equal((await api('GET', '/api/tasks?done=1')).filter((x) => x.title === 'Timesheet').length, 3);
});

test('a task as VTODO: what other apps set is kept, what Halcyon edits is replaced', async () => {
  const { todoIcs, parseTodos } = await import('../src/calendar/todos.js');
  const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:other\r\nBEGIN:VTODO\r\nUID:u1\r\nSUMMARY:Old\r\nCATEGORIES:Home\r\nDUE;VALUE=DATE:20261030\r\nPRIORITY:1\r\nEND:VTODO\r\nEND:VCALENDAR\r\n';
  const [p] = parseTodos(ics, 'Europe/Ljubljana');
  assert.deepEqual([p.title, p.dueAllDay, p.priority, p.done], ['Old', true, 1, false]);
  assert.equal(new Date(p.due).toLocaleString('en-GB', { timeZone: 'Europe/Ljubljana' }), '30/10/2026, 17:00:00');
  const out = todoIcs({ uid: 'u1', title: 'New', notes: 'n', due: p.due, due_all_day: 1, priority: 0, done: 1, completed_at: Date.now(), rrule: 'FREQ=DAILY', ics }, 'Europe/Ljubljana');
  assert.match(out, /CATEGORIES:Home/);
  assert.match(out, /SUMMARY:New/);
  assert.match(out, /DUE;VALUE=DATE:20261030/);
  assert.match(out, /DTSTART;VALUE=DATE:20261030/);
  assert.match(out, /STATUS:COMPLETED/);
  assert.match(out, /RRULE:FREQ=DAILY/);
  assert.doesNotMatch(out, /PRIORITY/);
  const [back] = parseTodos(out, 'Europe/Ljubljana');
  assert.deepEqual([back.title, back.done, back.rrule], ['New', true, 'FREQ=DAILY']);
});

test('tasks sync both ways with a CalDAV server', { skip: !DAV && 'set TEST_DAV_URL' }, async () => {
  const auth = { authorization: `Basic ${Buffer.from('alice:secret123').toString('base64')}` };
  const coll = new URL(`chores-${Date.now()}/`, DAV).href;
  // A collection for tasks only, with one task made by another app.
  let r = await fetch(coll, { method: 'MKCOL', headers: { ...auth, 'content-type': 'application/xml' }, body: '<?xml version="1.0"?><mkcol xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><set><prop><resourcetype><collection/><C:calendar/></resourcetype><displayname>Chores</displayname><C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set></prop></set></mkcol>' });
  assert.ok(r.ok, `MKCOL ${r.status}`);
  r = await fetch(`${coll}r1.ics`, { method: 'PUT', headers: { ...auth, 'content-type': 'text/calendar' }, body: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:other\r\nBEGIN:VTODO\r\nUID:remote-task-1\r\nDTSTAMP:20260101T000000Z\r\nSUMMARY:Water the plants\r\nCATEGORIES:Home\r\nDTSTART:20261026T080000Z\r\nDUE:20261026T080000Z\r\nRRULE:FREQ=WEEKLY\r\nEND:VTODO\r\nEND:VCALENDAR\r\n' });
  assert.ok(r.ok);
  const acc = await api('POST', '/api/accounts', { services: ['calendar'], caldavUrl: DAV, davUser: 'alice', davPassword: 'secret123', name: 'Radicale' });
  assert.equal(acc.dav.error, null);
  const lists = await api('GET', '/api/task-lists');
  const chores = lists.find((l) => l.name === 'Chores');
  assert.equal(chores.source, 'caldav');
  assert.ok(!(await api('GET', '/api/calendars')).some((c) => c.name === 'Chores'), 'a tasks-only collection is no calendar');
  let tasks = await api('GET', `/api/tasks?listId=${chores.id}`);
  const remote = tasks.find((t) => t.title === 'Water the plants');
  assert.equal(remote.rrule, 'FREQ=WEEKLY');

  const sync = () => api('POST', `/api/accounts/${acc.id}/sync?dav=1`);
  const onServer = async (file) => { const x = await fetch(`${coll}${file}`, { headers: auth }); return x.ok ? x.text() : null; };
  // Added here → on the server.
  const mine = await api('POST', '/api/tasks', { title: 'Buy bulbs', listId: chores.id, due: Date.UTC(2026, 10, 2, 16) });
  await sync();
  const uid = db.prepare('SELECT uid FROM tasks WHERE id = ?').get(mine.id).uid;
  assert.match(await onServer(`${uid}.ics`), /SUMMARY:Buy bulbs/);
  // Edited here: the other app's categories survive. Done (repeating): the server gets the next date.
  await api('PATCH', `/api/tasks/${remote.id}`, { title: 'Water all plants' });
  await sync();
  let text = await onServer('r1.ics');
  assert.match(text, /SUMMARY:Water all plants/);
  assert.match(text, /CATEGORIES:Home/);
  await api('PATCH', `/api/tasks/${remote.id}`, { done: true });
  await sync();
  assert.match(await onServer('r1.ics'), /DUE:20261102T080000Z/);
  // Changed on the server → here.
  r = await fetch(`${coll}${uid}.ics`, { method: 'PUT', headers: { ...auth, 'content-type': 'text/calendar' }, body: (await onServer(`${uid}.ics`)).replace('SUMMARY:Buy bulbs', 'SUMMARY:Buy tulip bulbs') });
  assert.ok(r.ok);
  await sync();
  tasks = await api('GET', `/api/tasks?listId=${chores.id}&done=1`);
  assert.ok(tasks.some((t) => t.title === 'Buy tulip bulbs'));
  // Deleted here → deleted on the server; deleted there → gone here.
  await api('DELETE', `/api/tasks/${mine.id}`);
  await sync();
  assert.equal(await onServer(`${uid}.ics`), null);
  await fetch(`${coll}r1.ics`, { method: 'DELETE', headers: auth });
  await sync();
  assert.ok(!(await api('GET', `/api/tasks?listId=${chores.id}`)).some((t) => t.id === remote.id));
  // Assigned to a space like a calendar.
  await api('PATCH', '/api/spaces/assign', { type: 'taskList', id: chores.id, space: 'Private' });
  assert.ok((await api('GET', '/api/spaces')).taskLists.some((l) => l.id === chores.id && l.space === 'Private' && /synced/.test(l.origin)));
  await fetch(coll, { method: 'DELETE', headers: auth });
});
