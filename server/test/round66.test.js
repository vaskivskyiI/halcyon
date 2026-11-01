// Task sync: a task changed while its first save to the server runs is not created a second time (412 Precondition Failed).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r66-test-'));
process.env.HALCYON_LOG_LEVEL = 'error';

const REMOTE = { url: 'https://dav.example/cal/tasks/', displayName: 'Tasks', ctag: 'c1', components: ['VTODO'] };

/** A CalDAV collection in memory that answers like a real server: create on an existing address → 412. */
function fakeDav({ onCreate } = {}) {
  const objects = new Map();
  let etag = 0;
  const c = {
    objects, calls: [],
    async createCalendarObject({ filename, iCalString }) {
      const url = new URL(filename, REMOTE.url).href;
      c.calls.push(['create', url]);
      if (objects.has(url)) return { ok: false, status: 412, statusText: 'Precondition Failed' };
      objects.set(url, { data: iCalString, etag: `"${++etag}"` });
      await onCreate?.();
      return { ok: true, status: 201 };
    },
    async updateCalendarObject({ calendarObject: { url, data, etag: want } }) {
      c.calls.push(['update', url]);
      if (want && objects.get(url)?.etag !== want) return { ok: false, status: 412, statusText: 'Precondition Failed' };
      objects.set(url, { data, etag: `"${++etag}"` });
      return { ok: true, status: 204 };
    },
    async deleteCalendarObject({ calendarObject: { url } }) { objects.delete(url); return { ok: true, status: 204 }; },
    async fetchCalendarObjects() { return [...objects].map(([url, o]) => ({ url, etag: o.etag, data: o.data })); },
  };
  return c;
}

let db, run, syncTodoCollection, newTaskUid, n = 0;
const account = { id: null, user_id: 1 };
const list = () => db.prepare('SELECT * FROM task_lists WHERE url = ?').get(REMOTE.url);
const task = (id) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
const addTask = (title) => Number(run(`INSERT INTO tasks (user_id, list_id, list, title, uid, dirty, created_at, updated_at) VALUES (1, ?, 'Tasks', ?, ?, 1, ?, ?)`,
  list().id, title, newTaskUid(), Date.now(), Date.now() + ++n).lastInsertRowid);

before(async () => {
  ({ db, run } = await import('../src/db/index.js'));
  run("INSERT INTO users (id, email, name, created_at) VALUES (1, 'me@x.example', 'Me', 0)");
  ({ syncTodoCollection, newTaskUid } = await import('../src/calendar/todos.js'));
  await syncTodoCollection(fakeDav(), account, REMOTE);
});
after(() => setTimeout(() => process.exit(0), 50).unref());

test('a task edited during its first save keeps its server address and is updated, not created again', async () => {
  const id = addTask('Buy milk');
  const dav = fakeDav({ onCreate: () => run("UPDATE tasks SET title = 'Buy oat milk', updated_at = updated_at + 1000 WHERE id = ?", id) });
  await syncTodoCollection(dav, account, { ...REMOTE, ctag: 'c2' });
  let t = task(id);
  assert.ok(t.href, 'address kept');
  assert.equal(t.dirty, 1, 'the later edit still waits to be saved');
  await syncTodoCollection(dav, account, { ...REMOTE, ctag: 'c3' });
  t = task(id);
  assert.equal(list().sync_error, null);
  assert.equal(t.dirty, 0);
  assert.deepEqual(dav.calls.map(([k]) => k), ['create', 'update']);
  assert.equal(dav.objects.size, 1);
  assert.match([...dav.objects.values()][0].data, /SUMMARY:Buy oat milk/);
});

test('a task already on the server whose address was lost is overwritten instead of refused', async () => {
  const id = addTask('Call Ana');
  const dav = fakeDav();
  await syncTodoCollection(dav, account, { ...REMOTE, ctag: 'c4' });
  run("UPDATE tasks SET href = NULL, etag = NULL, title = 'Call Ana back', dirty = 1 WHERE id = ?", id);
  await syncTodoCollection(dav, account, { ...REMOTE, ctag: 'c5' });
  assert.equal(list().sync_error, null);
  assert.equal(task(id).dirty, 0);
  assert.ok(task(id).href);
  assert.match([...dav.objects.values()].find((o) => /Call Ana/.test(o.data)).data, /SUMMARY:Call Ana back/);
});
