// Calendars, task lists and address books managed in one place: ones from a server are hidden (out of every view,
// still synced, shown again any time) instead of deleted; ones kept in Halcyon are deleted with what they hold.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r46-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, uid, acc;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  acc = db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, mail, created_at) VALUES (?, 'me@example.org', 0, 0, ?)").run(uid, Date.now()).lastInsertRowid;
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('a synced calendar is hidden, not deleted, and shown again; a local one is deleted with its events', async () => {
  const local = db.prepare("SELECT id FROM calendars WHERE user_id = ? AND source = 'local'").get(uid).id;
  const dav = db.prepare("INSERT INTO calendars (user_id, account_id, name, color, source, url, created_at) VALUES (?, ?, 'Work', '#000', 'caldav', 'https://dav.example/w/', ?)").run(uid, acc, Date.now()).lastInsertRowid;
  const t = Date.now() + 3600e3;
  db.prepare("INSERT INTO events (calendar_id, uid, title, start, \"end\") VALUES (?, 'w1', 'Server meeting', ?, ?)").run(dav, t, t + 3600e3);
  const range = `/api/events?from=${t - 864e5}&to=${t + 864e5}`;
  assert.equal((await api('GET', range)).length, 1);

  const r = await api('DELETE', `/api/calendars/${dav}`);
  assert.equal(r.hidden, true);
  assert.ok(db.prepare('SELECT 1 FROM calendars WHERE id = ?').get(dav), 'still there (and synced)');
  assert.ok(!(await api('GET', '/api/calendars')).some((c) => c.id === dav));
  assert.equal((await api('GET', range)).length, 0, 'its events are out of view');
  const all = await api('GET', '/api/calendars?all=1');
  assert.deepEqual(all.filter((c) => c.id === dav).map((c) => [c.hidden, c.events]), [[true, 1]]);

  await api('PATCH', `/api/calendars/${dav}`, { hidden: false });
  assert.equal((await api('GET', range)).length, 1);
  // The default can be hidden only when another calendar takes over.
  await api('PATCH', `/api/calendars/${dav}`, { isDefault: true });
  await api('PATCH', `/api/calendars/${dav}`, { hidden: true });
  assert.equal(db.prepare('SELECT is_default FROM calendars WHERE id = ?').get(local).is_default, 1);
  await api('PATCH', `/api/calendars/${dav}`, { isDefault: true });
  assert.equal(db.prepare('SELECT hidden FROM calendars WHERE id = ?').get(dav).hidden, 0, 'made default = shown');

  db.prepare("INSERT INTO events (calendar_id, uid, title, start, \"end\") VALUES (?, 'l1', 'Local', ?, ?)").run(local, t, t + 3600e3);
  await api('DELETE', `/api/calendars/${local}`);
  assert.ok(!db.prepare('SELECT 1 FROM calendars WHERE id = ?').get(local));
  assert.ok(!db.prepare("SELECT 1 FROM events WHERE uid = 'l1'").get(), 'its events went with it');
});

test('task lists: a synced one is hidden with its tasks out of view; a local one is deleted', async () => {
  const [def] = await api('GET', '/api/task-lists');
  const dav = db.prepare("INSERT INTO task_lists (user_id, account_id, name, source, url, created_at) VALUES (?, ?, 'Server tasks', 'caldav', 'https://dav.example/w/', ?)").run(uid, acc, Date.now()).lastInsertRowid;
  await api('POST', '/api/tasks', { title: 'On the server', listId: dav });
  await api('DELETE', `/api/task-lists/${dav}`);
  assert.ok(db.prepare('SELECT 1 FROM task_lists WHERE id = ?').get(dav));
  assert.ok(!(await api('GET', '/api/tasks')).some((t) => t.title === 'On the server'));
  assert.ok(!(await api('GET', '/api/task-lists')).some((l) => l.id === dav));
  assert.equal((await api('GET', '/api/task-lists?all=1')).find((l) => l.id === dav).total, 1);
  await api('PATCH', `/api/task-lists/${dav}`, { hidden: false, isDefault: true });
  assert.ok((await api('GET', '/api/tasks')).some((t) => t.title === 'On the server'));
  await api('DELETE', `/api/task-lists/${def.id}`);
  assert.ok(!db.prepare('SELECT 1 FROM task_lists WHERE id = ?').get(def.id));
});

test('address books: a local one is deleted with its contacts, a synced one hidden', async () => {
  const local = db.prepare("SELECT id FROM address_books WHERE user_id = ? AND source = 'local'").get(uid).id;
  const dav = db.prepare("INSERT INTO address_books (user_id, account_id, name, source, url, created_at) VALUES (?, ?, 'People', 'carddav', 'https://dav.example/p/', ?)").run(uid, acc, Date.now()).lastInsertRowid;
  const c = await api('POST', '/api/contacts', { displayName: 'Ana', emails: [{ value: 'ana@x.example' }], addressBookId: dav });
  await api('DELETE', `/api/address-books/${dav}`);
  assert.ok(db.prepare('SELECT 1 FROM address_books WHERE id = ?').get(dav));
  assert.ok(!(await api('GET', '/api/contacts')).some((x) => x.id === c.id));
  const books = await api('GET', '/api/address-books?all=1');
  assert.deepEqual(books.filter((b) => b.id === dav).map((b) => [b.hidden, b.contacts]), [[true, 1]]);
  await api('PATCH', `/api/address-books/${dav}`, { hidden: false });
  assert.ok((await api('GET', '/api/contacts')).some((x) => x.id === c.id));
  await api('DELETE', `/api/address-books/${local}`);
  assert.ok(!db.prepare('SELECT 1 FROM address_books WHERE id = ?').get(local));
  await assert.rejects(api('DELETE', `/api/address-books/${dav}`), /only address book/);
});

test('contacts move from a local address book: saved ones uploaded, the same person skipped, collected ones kept local', async () => {
  const local = db.prepare("INSERT INTO address_books (user_id, name, source, created_at) VALUES (?, 'Old contacts', 'local', ?)").run(uid, Date.now()).lastInsertRowid;
  const dav = db.prepare("SELECT id FROM address_books WHERE user_id = ? AND source = 'carddav'").get(uid).id;
  const saved = await api('POST', '/api/contacts', { displayName: 'Marko', emails: [{ value: 'marko@x.example' }], addressBookId: local });
  const twin = await api('POST', '/api/contacts', { displayName: 'Ana (old)', emails: [{ value: 'ANA@x.example' }], addressBookId: local });
  const { collectAddresses } = await import('../src/contacts/service.js');
  db.prepare('UPDATE address_books SET is_default = 0 WHERE user_id = ?').run(uid);
  db.prepare('UPDATE address_books SET is_default = 1 WHERE id = ?').run(local);
  collectAddresses(uid, [{ address: 'someone@y.example', name: 'Someone' }], Date.now(), true);
  const coll = db.prepare("SELECT id, address_book_id FROM contacts WHERE emails_json LIKE '%someone@y.example%'").get();
  db.prepare('UPDATE contacts SET address_book_id = ? WHERE id = ?').run(local, coll.id);

  const r = await api('POST', `/api/address-books/${local}/move-contacts`, { to: dav });
  assert.deepEqual(r, { moved: 1, skipped: 1, collected: 1 });
  const m = db.prepare('SELECT address_book_id, dirty FROM contacts WHERE id = ?').get(saved.id);
  assert.deepEqual([m.address_book_id, m.dirty], [dav, 1], 'uploaded with the next sync');
  const c = db.prepare('SELECT address_book_id, dirty FROM contacts WHERE id = ?').get(coll.id);
  assert.deepEqual([c.address_book_id, c.dirty], [dav, 0], 'collected address: kept for suggestions, not uploaded');
  assert.equal(db.prepare('SELECT address_book_id FROM contacts WHERE id = ?').get(twin.id).address_book_id, local, 'the same person (by email) stays');
  await assert.rejects(api('POST', `/api/address-books/${dav}/move-contacts`, { to: local }), /kept in Halcyon/);
  await api('DELETE', `/api/address-books/${local}`);
  assert.equal(db.prepare('SELECT is_default FROM address_books WHERE id = ?').get(dav).is_default, 1);
});
