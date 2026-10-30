// A task list is shared like a calendar: its tasks go along, every member sees them, and it can be moved back.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r59-test-'));
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, ann = '', ben = '', space, list, task;
async function call(cookie, method, url, body, as) {
  const r = await fetch(base + url, { method, headers: { cookie, ...(as ? { 'x-halcyon-as': String(as) } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  return { status: r.status, data: await r.json(), cookie: sc ? sc.split(';')[0] : cookie };
}

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ann = (await call('', 'POST', '/api/auth/setup', { email: 'ann@example.org', name: 'Ann', password: 'password123' })).cookie;
  await call(ann, 'POST', '/api/admin/users', { email: 'ben@example.org', name: 'Ben', password: 'password123' });
  ben = (await call('', 'POST', '/api/auth/login', { email: 'ben@example.org', password: 'password123' })).cookie;
  space = (await call(ann, 'POST', '/api/shared', { name: 'Studio' })).data.id;
  await call(ann, 'POST', `/api/shared/${space}/members`, { email: 'ben@example.org' });
  list = (await call(ann, 'POST', '/api/task-lists', { name: 'Project' })).data.id;
  task = (await call(ann, 'POST', '/api/tasks', { title: 'Book the venue', listId: list })).data.id;
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('a shared list and its tasks reach every member, and leave the sharer\'s own tasks', async () => {
  assert.equal((await call(ann, 'POST', `/api/shared/${space}/move-in`, { taskListId: list })).status, 200);
  const mine = (await call(ann, 'GET', '/api/tasks')).data;
  assert.ok(!(mine.items || mine).some((t) => t.id === task));
  const there = (await call(ben, 'GET', '/api/tasks', undefined, space)).data;
  assert.ok((there.items || there).some((t) => t.id === task && t.listId === list));
  assert.equal((await call(ben, 'PATCH', `/api/tasks/${task}`, { done: true }, space)).status, 200, 'a member can tick it');
  const s = (await call(ann, 'GET', '/api/shared')).data.find((x) => x.id === space);
  assert.ok(s.taskLists.some((l) => l.id === list && l.name === 'Project'));
});

test('someone else\'s list cannot be taken, and only the owner moves it back', async () => {
  const own = (await call(ben, 'POST', '/api/task-lists', { name: 'Private' })).data.id;
  assert.equal((await call(ann, 'POST', `/api/shared/${space}/move-in`, { taskListId: own })).status, 400);
  assert.notEqual((await call(ben, 'POST', `/api/shared/${space}/move-out`, { taskListId: list })).status, 200);
  assert.equal((await call(ann, 'POST', `/api/shared/${space}/move-out`, { taskListId: list })).status, 200);
  const back = (await call(ann, 'GET', '/api/tasks?done=1')).data;
  assert.ok((await call(ann, 'GET', '/api/task-lists?all=1')).data.some((l) => l.id === list));
  assert.equal((await call(ann, 'GET', '/api/shared')).data.find((x) => x.id === space).taskLists.some((l) => l.id === list), false);
  assert.ok(back);
});

test('an archive is shared with its mail, and not while it is still importing', async () => {
  const { db } = await import('../src/db/index.js');
  const a = (await call(ann, 'POST', '/api/archives', { name: 'Old mail' })).data;
  const f = { id: Number(db.prepare("INSERT INTO folders (account_id, path, name) VALUES (?, 'Old', 'Old')").run(a.id).lastInsertRowid) };
  const uid = db.prepare('SELECT user_id FROM accounts WHERE id = ?').get(a.id).user_id;
  const msg = Number(db.prepare("INSERT INTO messages (user_id, account_id, folder_id, message_id, subject, from_addr, date) VALUES (?, ?, ?, '<o@x>', 'Old contract', 'o@x.example', ?)").run(uid, a.id, f.id, Date.now() - 864e8).lastInsertRowid);
  const job = db.prepare("INSERT INTO archive_jobs (user_id, account_id, type, status, created_at) VALUES (?, ?, 'import', 'running', ?)").run(uid, a.id, Date.now()).lastInsertRowid;
  assert.equal((await call(ann, 'POST', `/api/shared/${space}/move-in`, { accountId: a.id })).status, 400);
  db.prepare("UPDATE archive_jobs SET status = 'done' WHERE id = ?").run(job);
  assert.equal((await call(ann, 'POST', `/api/shared/${space}/move-in`, { accountId: a.id })).status, 200);
  assert.ok((await call(ben, 'GET', '/api/archives', undefined, space)).data.archives.some((x) => x.id === a.id));
  assert.equal((await call(ben, 'GET', `/api/messages/${msg}`, undefined, space)).status, 200);
  assert.equal((await call(ann, 'GET', '/api/shared')).data.find((x) => x.id === space).accounts.find((x) => x.id === a.id).kind, 'archive');
  assert.equal((await call(ann, 'POST', `/api/shared/${space}/move-out`, { accountId: a.id })).status, 200);
  assert.equal(db.prepare('SELECT user_id FROM messages WHERE id = ?').get(msg).user_id, uid);
});
