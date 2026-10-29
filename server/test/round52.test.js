// Senders the user habitually leaves unread are learned as not important (and the user can say otherwise), and
// duplicate contacts are found across Latin and Cyrillic spellings.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r52-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, uid, acc, inbox, habits;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
let n = 0;
const mail = (from, read = 0, daysAgo = 2, answered = 0) => db.prepare('INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, thread_id, subject, from_addr, from_name, to_json, date, is_read, is_answered, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  .run(uid, acc, inbox, ++n, `h${n}@x`, `t${n}`, `Mail ${n}`, from, 'X', '[]', Date.now() - daysAgo * 864e5 - n * 60e3, read, answered, Date.now()).lastInsertRowid;

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  habits = await import('../src/ai/habits.js');
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  await api('PATCH', '/api/settings', { ai: { enabled: false } });
  acc = db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, 'me@example.org', 0, ?)").run(uid, Date.now()).lastInsertRowid;
  inbox = db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'INBOX', '\\Inbox')").run(acc).lastInsertRowid;
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('a sender whose mail stays unread is learned as not important; reading again, a contact or the user undo it', async () => {
  for (let i = 0; i < 6; i++) mail('promo@shop.example');
  for (let i = 0; i < 6; i++) mail('few@club.example', i < 2 ? 1 : 0); // a third read: not "rarely"
  for (let i = 0; i < 6; i++) mail('boss@firma.si', 0, 2, i === 0 ? 1 : 0); // answered once
  for (let i = 0; i < 6; i++) mail('fresh@news.example', 0, 0); // still today: not judged yet
  habits.forgetHabits(uid);
  assert.deepEqual([...habits.rareSenders(uid).keys()], ['promo@shop.example']);

  const d = habits.applyHabit(uid, { priority: 80, needs_reply: true, suggested_replies: ['Sure'] }, { from_addr: 'Promo@shop.example' }, { importance: null }, null);
  assert.deepEqual([d.priority, d.needs_reply, d.suggested_replies], [20, false, []]);
  const told = habits.applyHabit(uid, { priority: 80 }, { from_addr: 'promo@shop.example' }, { importance: 'important' }, null);
  assert.equal(told.priority, 80, 'the user\'s own "important" wins');

  const row = (await api('GET', '/api/senders')).find((x) => x.address === 'promo@shop.example');
  assert.deepEqual([row.learned, row.kept], [true, false]);
  assert.equal((await api('POST', '/api/senders/habit', { address: 'promo@shop.example', keep: true })).learned, false);
  assert.equal((await api('GET', '/api/senders')).find((x) => x.address === 'promo@shop.example').kept, true);
  assert.equal((await api('POST', '/api/senders/habit', { address: 'promo@shop.example', keep: false })).learned, true, 'learns again');

  // Opening their newest mail again: among the last 10, more than 1 in 10 read.
  db.prepare("UPDATE messages SET is_read = 1 WHERE id IN (SELECT id FROM messages WHERE from_addr = 'promo@shop.example' ORDER BY date DESC LIMIT 1)").run();
  habits.forgetHabits(uid);
  assert.equal(habits.rarelyRead(uid, 'promo@shop.example'), false);

  // People in the contacts are never demoted.
  for (let i = 0; i < 6; i++) mail('aunt@family.example');
  habits.forgetHabits(uid);
  assert.equal(habits.rarelyRead(uid, 'aunt@family.example'), true);
  await api('POST', '/api/contacts', { displayName: 'Aunt', emails: [{ type: 'home', value: 'aunt@family.example' }] });
  habits.forgetHabits(uid);
  assert.equal(habits.rarelyRead(uid, 'aunt@family.example'), false);
});

test('duplicates are found across Latin and Cyrillic spellings', async () => {
  const { sounds } = await import('../src/contacts/review.js');
  const same = (a, b) => assert.equal(sounds(a), sounds(b), `${a} / ${b}`);
  same('Ігор Васківський', 'Ihor Vaskivskyi');
  same('Igor Vaskivskij', 'Ihor Vaskivskyi');
  same('Шуштар', 'Šuštar');
  same('Юлія Харченко', 'Yuliia Kharchenko');
  same('Julija Harčenko', 'Yuliia Kharchenko');
  same('Олена Коваль', 'Olena Koval');
  assert.notEqual(sounds('Ana Novak'), sounds('Ana Kovač'));

  const mk = (displayName, email) => api('POST', '/api/contacts', { displayName, emails: [{ type: 'work', value: email }] });
  const a = await mk('Олена Коваль', 'olena@ukr.example');
  const b = await mk('Olena Koval', 'olena.koval@firma.si');
  await mk('Olena Kovač', 'kovac@firma.si');
  const s = await api('POST', '/api/contacts/suggestions/scan');
  const m = s.filter((x) => x.kind === 'merge');
  assert.equal(m.length, 1);
  assert.deepEqual(m[0].ids.sort((p, q) => p - q), [a.id, b.id]);
  assert.equal(m[0].reason, 'Same name in Latin and Cyrillic');
});
