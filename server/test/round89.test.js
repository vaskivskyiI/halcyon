// Notifications open what they are about (the email, the event, the task) and carry buttons — Mark read, Archive,
// Snooze, Mark done — that are done on the server through POST /api/push/action.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r89-test-'));
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, uid, account, folder, ingestMessage, afterIngest, n = 0;
const shown = [], closed = [];
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw Object.assign(new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`), { status: r.status });
  return data;
}
async function arrive(...subjects) {
  const ids = [];
  for (const subject of subjects) {
    const raw = `Message-ID: <a${++n}@x>\r\nFrom: Ana <ana@x.example>\r\nTo: me@example.org\r\nSubject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\nContent-Type: text/plain\r\n\r\nHello\r\n`;
    ids.push((await ingestMessage({ account, folder, uid: n, flags: [], raw: Buffer.from(raw) })).id);
  }
  await afterIngest(account, folder, ids);
  return ids;
}

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  ({ ingestMessage } = await import('../src/mail/store.js'));
  ({ afterIngest } = await import('../src/mail/pipeline.js'));
  const { bus } = await import('../src/util/events.js');
  bus.on('user-event', (e) => { if (e.type === 'notify:show') shown.push(e.payload); if (e.type === 'notify:close') closed.push(...e.payload.tags); });
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  await api('PATCH', '/api/settings', { notifications: { mail: 'all' } });
  account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, 'me@example.org', 0, ?)").run(uid, Date.now() - 864e5).lastInsertRowid);
  folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'INBOX', '\\Inbox')").run(account.id).lastInsertRowid);
  db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'Archive', 'Archive', '\\Archive')").run(account.id);
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('a mail notification opens the email and offers Mark read, Archive and Snooze', async () => {
  shown.length = 0;
  const [id] = await arrive('Hello');
  const p = shown.at(-1);
  assert.equal(p.url, `#/mail/unified/${id}`);
  assert.equal(p.ref, `mail:${id}`);
  assert.deepEqual(p.actions.map((a) => a.id), ['read', 'archive', 'snooze']);
  const [a, b] = await arrive('One', 'Two');
  assert.equal(shown.at(-1).ref, `mail:${a},${b}`);
  assert.deepEqual(shown.at(-1).actions.map((x) => x.id), ['read'], 'several at once: Mark all read');
});

test('the buttons are done on the server and take the notification back', async () => {
  const [r, s, z] = await arrive('Read me', 'Archive me', 'Later');
  closed.length = 0;
  await api('POST', '/api/push/action', { ref: `mail:${r}`, action: 'read', tag: `mail-${r}` });
  assert.equal(db.prepare('SELECT is_read FROM messages WHERE id = ?').get(r).is_read, 1);
  assert.ok(closed.includes(`mail-${r}`));
  await api('POST', '/api/push/action', { ref: `mail:${s}`, action: 'archive', tag: `mail-${s}` });
  assert.equal(db.prepare('SELECT f.special_use AS u FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.id = ?').get(s).u, '\\Archive');
  await api('POST', '/api/push/action', { ref: `mail:${z}`, action: 'snooze', tag: `mail-${z}` });
  const until = db.prepare('SELECT snoozed_until FROM messages WHERE id = ?').get(z).snoozed_until;
  assert.ok(until > Date.now() && until < Date.now() + 2 * 864e5, 'until tomorrow morning');
  await assert.rejects(() => api('POST', '/api/push/action', { ref: `mail:${r}`, action: 'explode', tag: 'x' }), (e) => e.status === 400);
});

test('a task reminder opens the task; Mark done finishes it, Snooze brings it back later', async () => {
  const { taskReminder, actionsOf, dueReminders } = await import('../src/notify-actions.js');
  const t = await api('POST', '/api/tasks', { title: 'Pay the bill', due: Date.now() });
  const data = taskReminder(db.prepare('SELECT * FROM tasks WHERE id = ?').get(t.id));
  assert.equal(data.url, `#/tasks/${t.id}`);
  const { ref, actions } = actionsOf('reminder', data);
  assert.equal(ref, `task:${t.id}`);
  assert.deepEqual(actions.map((a) => a.id), ['done', 'snooze']);
  await api('POST', '/api/push/action', { ref, action: 'snooze', tag: data.tag });
  const row = db.prepare('SELECT * FROM reminder_snoozes WHERE ref = ?').get(ref);
  assert.ok(row.due_at > Date.now() + 50 * 60e3);
  assert.deepEqual(dueReminders(Date.now()), [], 'not yet');
  assert.equal(dueReminders(row.due_at + 1)[0].data.tag, `rem-t${t.id}`, 'an hour later it is back');
  await api('POST', '/api/push/action', { ref, action: 'done', tag: data.tag });
  assert.equal(db.prepare('SELECT done FROM tasks WHERE id = ?').get(t.id).done, 1);
});

test('an event reminder opens that occurrence and snoozes for 5 minutes', async () => {
  const { eventReminder, actionsOf, dueReminders } = await import('../src/notify-actions.js');
  const start = Date.now() + 10 * 60e3;
  const e = await api('POST', '/api/events', { title: 'Standup', start, end: start + 15 * 60e3 });
  const data = eventReminder(uid, { ...e, id: e.id }, start);
  assert.equal(data.url, `#/calendar/event/${e.id}/${start}`);
  const { ref, actions } = actionsOf('reminder', data);
  assert.equal(ref, `event:${e.id}:${start}`);
  assert.deepEqual(actions.map((a) => a.id), ['snooze', 'dismiss']);
  await api('POST', '/api/push/action', { ref, action: 'snooze', tag: data.tag });
  const due = db.prepare('SELECT due_at FROM reminder_snoozes WHERE ref = ?').get(ref).due_at;
  const back = dueReminders(due + 1);
  assert.equal(back[0].data.tag, `rem-e${e.id}-${start}`);
  assert.equal(back[0].data.title, 'Standup');
  await assert.rejects(() => api('POST', '/api/push/action', { ref: 'event:999999:1', action: 'snooze', tag: 'x' }), (e2) => e2.status === 404);
});
