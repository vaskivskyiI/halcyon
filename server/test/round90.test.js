// Emails and tasks added to an event already in the calendar ("Add to event"): listed with the event, the event shown
// with the email in the reader and with the task in the task list; removed again without touching them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r90-test-'));
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, uid, account, folder, ingestMessage, n = 0;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw Object.assign(new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`), { status: r.status });
  return data;
}
async function arrive(subject) {
  const raw = `Message-ID: <e${++n}@x>\r\nFrom: Ana <ana@x.example>\r\nTo: me@example.org\r\nSubject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\nContent-Type: text/plain\r\n\r\nAgenda attached\r\n`;
  return (await ingestMessage({ account, folder, uid: n, flags: [], raw: Buffer.from(raw) })).id;
}

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  ({ ingestMessage } = await import('../src/mail/store.js'));
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, 'me@example.org', 0, ?)").run(uid, Date.now()).lastInsertRowid);
  folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'INBOX', '\Inbox')").run(account.id).lastInsertRowid);
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('an email and a task added to an event are listed with it and show the event in turn', async () => {
  const start = Date.now() + 864e5;
  const e = await api('POST', '/api/events', { title: 'Project review', start, end: start + 3600e3 });
  const mid = await arrive('Re: Project review — agenda');
  const t = await api('POST', '/api/tasks', { title: 'Prepare slides' });
  await api('POST', `/api/events/${e.id}/links`, { kind: 'mail', id: mid });
  const links = await api('POST', `/api/events/${e.id}/links`, { kind: 'task', id: t.id });
  await api('POST', `/api/events/${e.id}/links`, { kind: 'mail', id: mid }); // twice: once
  assert.deepEqual(links.mail.map((m) => m.id), [mid]);
  assert.equal(links.mail[0].subject, 'Re: Project review — agenda');
  assert.deepEqual(links.tasks.map((x) => x.title), ['Prepare slides']);
  assert.equal((await api('GET', `/api/events/${e.id}/links`)).mail.length, 1);

  const m = await api('GET', `/api/messages/${mid}`);
  assert.equal(m.related.events.length, 1);
  assert.equal(m.related.events[0].title, 'Project review');
  assert.equal(m.related.events[0].linked, true);

  const task = (await api('GET', '/api/tasks')).find((x) => x.id === t.id);
  assert.deepEqual(task.events.map((x) => x.title), ['Project review']);

  // Moved to another calendar (a new row, same UID): the links follow.
  db.prepare('UPDATE events SET id = id + 1000 WHERE id = ?').run(e.id);
  assert.equal((await api('GET', `/api/events/${e.id + 1000}/links`)).tasks.length, 1);

  const left = await api('DELETE', `/api/events/${e.id + 1000}/links/task/${t.id}`);
  assert.equal(left.tasks.length, 0);
  assert.ok(db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(t.id), 'the task stays');
});

test('only one\'s own events, mail and tasks can be linked', async () => {
  const start = Date.now() + 2 * 864e5;
  const e = await api('POST', '/api/events', { title: 'Mine', start, end: start + 3600e3 });
  await assert.rejects(() => api('POST', `/api/events/${e.id}/links`, { kind: 'mail', id: 999999 }), (x) => x.status === 404);
  await assert.rejects(() => api('POST', '/api/events/999999/links', { kind: 'task', id: 1 }), (x) => x.status === 404);
  await assert.rejects(() => api('POST', `/api/events/${e.id}/links`, { kind: 'contact', id: 1 }), (x) => x.status === 400);
});
