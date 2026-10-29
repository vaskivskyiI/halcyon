// Contacts tidied up with the user's say (merge / save suggestions), the Senders cleanup, and times proposed in an
// email checked against the calendar.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r51-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, uid, acc, inbox;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
let n = 0;
const mail = (from, name, read = 0, unsub = null) => db.prepare('INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, thread_id, subject, from_addr, from_name, to_json, date, is_read, list_unsubscribe, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  .run(uid, acc, inbox, ++n, `u${n}@x`, `t${n}`, `Mail ${n}`, from, name, '[]', Date.now() - n * 60e3, read, unsub, Date.now()).lastInsertRowid;

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  await api('PATCH', '/api/settings', { ai: { enabled: false } });
  acc = db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, 'me@example.org', 0, ?)").run(uid, Date.now()).lastInsertRowid;
  inbox = db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'INBOX', '\\Inbox')").run(acc).lastInsertRowid;
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('duplicates and people worth saving are suggested; accepted ones are done, rejected ones stay away', async () => {
  const mk = (displayName, email) => api('POST', '/api/contacts', { displayName, emails: [{ type: 'work', value: email }] });
  const a = await mk('Saša Žagar', 'sasa@firma.si');
  const b = await mk('Zagar Sasa', 'sasa.zagar@gmail.com');
  const c = await mk('Ana Novak', 'ana@example.com');
  const d = await mk('Ana N.', 'ana@example.com');
  const col = await mk('Bojan Kos', 'bojan@kos.si');
  db.prepare('UPDATE contacts SET auto_collected = 1, contact_count = 4 WHERE id = ?').run(col.id);

  const s = await api('POST', '/api/contacts/suggestions/scan');
  const merges = s.filter((x) => x.kind === 'merge').map((x) => x.ids.sort((p, q) => p - q));
  assert.deepEqual(merges.sort(), [[a.id, b.id], [c.id, d.id]].sort(), 'same name (accents, order aside) and same address');
  const add = s.find((x) => x.kind === 'add');
  assert.equal(add.email, 'bojan@kos.si');
  assert.match(add.reason, /wrote to them 4 times/);

  const sameName = s.find((x) => x.kind === 'merge' && x.ids.includes(a.id));
  const sameMail = s.find((x) => x.kind === 'merge' && x.ids.includes(c.id));
  await api('POST', `/api/contacts/suggestions/${sameMail.id}`, { accept: true, keepId: c.id });
  const kept = db.prepare('SELECT * FROM contacts WHERE id = ?').get(c.id);
  assert.ok(kept && !db.prepare('SELECT 1 FROM contacts WHERE id = ?').get(d.id), 'merged into the chosen one');
  await api('POST', `/api/contacts/suggestions/${sameName.id}`, { accept: false });
  await api('POST', `/api/contacts/suggestions/${add.id}`, { accept: true });
  assert.equal(db.prepare('SELECT auto_collected FROM contacts WHERE id = ?').get(col.id).auto_collected, 0, 'saved');
  assert.deepEqual(await api('POST', '/api/contacts/suggestions/scan'), [], 'a rejected suggestion does not come back');
});

test('Senders: who sends most and how much is read; their inbox mail archived in one go', async () => {
  for (let i = 0; i < 4; i++) mail('news@shop.example', 'Shop', 0, '<https://shop.example/u>');
  mail('boss@firma.si', 'Boss', 1); mail('boss@firma.si', 'Boss', 1);
  const list = await api('GET', '/api/senders');
  const shop = list.find((x) => x.address === 'news@shop.example');
  assert.deepEqual([shop.total, shop.readRate, shop.inbox, !!shop.unsubscribeId], [4, 0, 4, true]);
  assert.equal(list.find((x) => x.address === 'boss@firma.si').readRate, 100);
  db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'Archive', 'Archive', '\\Archive')").run(acc);
  assert.equal((await api('POST', '/api/senders/action', { address: 'news@shop.example', action: 'archive' })).count, 4);
  assert.equal((await api('GET', '/api/senders')).find((x) => x.address === 'news@shop.example').inbox, 0);
});

test('times proposed in an email are checked against the calendar', async () => {
  const cal = db.prepare('SELECT id FROM calendars WHERE user_id = ?').get(uid).id;
  const t = Date.UTC(2031, 0, 7, 9, 0);
  db.prepare("INSERT INTO events (calendar_id, uid, title, start, \"end\") VALUES (?, 'b1', 'Dentist', ?, ?)").run(cal, t, t + 3600e3);
  const [busy, free] = await api('POST', '/api/calendar/check', { ranges: [{ start: t + 30 * 60e3, end: t + 90 * 60e3 }, { start: t + 2 * 3600e3, end: t + 3 * 3600e3 }] });
  assert.equal(busy.free, false);
  assert.equal(busy.conflicts[0].title, 'Dentist');
  assert.equal(free.free, true);
});
