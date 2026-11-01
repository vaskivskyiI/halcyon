// Task lists can be removed: one its server no longer offers is marked and can be deleted; one still on the server is
// removed from Halcyon only, does not come back with the next sync, and can be brought back.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r67-test-'));
process.env.HALCYON_LOG_LEVEL = 'error';

const OLD = { url: 'https://dav.example/cal/igor%40x/default/', displayName: 'Work', ctag: 'a1', components: ['VEVENT', 'VTODO'] };
const NEW = { url: 'https://dav.example/cal/igor@x/default/', displayName: 'Work', ctag: 'b1', components: ['VEVENT', 'VTODO'] };
const todo = (uid, title) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:${uid}\r\nSUMMARY:${title}\r\nSTATUS:NEEDS-ACTION\r\nEND:VTODO\r\nEND:VCALENDAR\r\n`;
const fakeDav = () => ({
  calls: 0,
  async fetchCalendarObjects() { this.calls++; return [{ url: 'https://dav.example/t1.ics', etag: '"1"', data: todo('t1', 'Call Ana') }]; },
  async createCalendarObject() { return { ok: true, status: 201 }; },
  async updateCalendarObject() { return { ok: true, status: 204 }; },
  async deleteCalendarObject() { return { ok: true, status: 204 }; },
});

let app, base, me = '', db, syncTodoCollection, markGoneTaskLists, account;
async function call(method, url, body) {
  const r = await fetch(base + url, { method, headers: { cookie: me, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) me = sc.split(';')[0];
  return { status: r.status, data: await r.json() };
}
const lists = async () => (await call('GET', '/api/task-lists?all=1')).data;
const byUrl = (u) => db.prepare('SELECT * FROM task_lists WHERE url = ?').get(u);
// One sync of the account's collections, as syncCalDav does it.
async function sync(cols, dav = fakeDav()) {
  for (const [i, c] of cols.entries()) await syncTodoCollection(dav, account, c, i);
  markGoneTaskLists(account.id, cols.map((c) => c.url));
  return dav;
}

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  await call('POST', '/api/auth/setup', { email: 'me@x.example', name: 'Me', password: 'password123' });
  ({ db } = await import('../src/db/index.js'));
  ({ syncTodoCollection, markGoneTaskLists } = await import('../src/calendar/todos.js'));
  const uid = db.prepare('SELECT id FROM users LIMIT 1').get().id;
  const id = Number(db.prepare('INSERT INTO accounts (user_id, email, created_at) VALUES (?, ?, ?)').run(uid, 'igor@x.example', Date.now()).lastInsertRowid);
  account = { id, user_id: uid };
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('a list its server no longer offers is marked, and can be deleted with its tasks', async () => {
  await sync([OLD]);
  // The server is now reached at another address for the same collection: a second list, the first one stale.
  await sync([NEW]);
  const old = (await lists()).find((l) => l.id === byUrl(OLD.url).id);
  assert.equal(old.gone, true);
  assert.equal((await lists()).find((l) => l.id === byUrl(NEW.url).id).gone, false);
  const r = await call('DELETE', `/api/task-lists/${old.id}`);
  assert.equal(r.status, 200);
  assert.ok(!r.data.removed);
  assert.equal(byUrl(OLD.url), undefined, 'deleted');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE list_id = ?').get(old.id).n, 0);
  await sync([NEW]);
  assert.equal(byUrl(OLD.url), undefined, 'not made again: the server does not offer it');
});

test('a second list for the same collection is not synced, is marked, and can be deleted', async () => {
  const URL3 = 'https://dav.example/cal/twin/';
  const ins = (name) => Number(db.prepare("INSERT INTO task_lists (user_id, account_id, name, source, url, created_at) VALUES (?, ?, ?, 'caldav', ?, ?)").run(account.user_id, account.id, name, URL3, Date.now()).lastInsertRowid);
  const first = ins('Work'), twin = ins('Work (2)');
  await sync([NEW, { ...NEW, url: URL3, ctag: 'c1' }]);
  const all = await lists();
  assert.equal(all.find((l) => l.id === first).gone, false);
  assert.equal(all.find((l) => l.id === first).total, 1, 'the first one is synced');
  assert.equal(all.find((l) => l.id === twin).gone, true);
  assert.equal(all.find((l) => l.id === twin).total, 0);
  assert.equal((await call('DELETE', `/api/task-lists/${twin}`)).data.removed, undefined);
  assert.equal(db.prepare('SELECT COUNT(*) FROM task_lists WHERE id = ?').pluck().get(twin), 0, 'deleted');
});

test('a list still on the server is removed from Halcyon only, stays removed, and can be brought back', async () => {
  const live = byUrl(NEW.url);
  assert.equal((await call('DELETE', `/api/task-lists/${live.id}`)).data.removed, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE list_id = ?').get(live.id).n, 0);
  assert.ok(!(await call('GET', '/api/task-lists')).data.some((l) => l.id === live.id), 'not shown');
  const dav = await sync([{ ...NEW, ctag: 'b2' }]);
  assert.equal(dav.calls, 0, 'not synced');
  assert.equal(db.prepare('SELECT COUNT(*) FROM task_lists WHERE url = ?').pluck().get(NEW.url), 1, 'no new list for it');
  assert.equal(db.prepare('SELECT COUNT(*) FROM tasks WHERE list_id = ?').pluck().get(live.id), 0);
  assert.equal((await lists()).find((l) => l.id === live.id).removed, true, 'listed in Settings');
  assert.equal((await call('PATCH', `/api/task-lists/${live.id}`, { hidden: false })).status, 200);
  await sync([{ ...NEW, ctag: 'b2' }]);
  assert.equal(db.prepare('SELECT COUNT(*) FROM tasks WHERE list_id = ?').pluck().get(live.id), 1, 'synced again');
  assert.ok((await call('GET', '/api/task-lists')).data.some((l) => l.id === live.id && !l.removed));
});
