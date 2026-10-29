// A server's virtual "Flagged" folder shows the account's flagged mail at once; tasks made from an email can repeat.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r49-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, uid, acc, inbox, flaggedBox;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
let n = 0;
const add = (folder, subject, flagged = 0) => db.prepare('INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, thread_id, subject, from_addr, to_json, date, is_read, is_flagged, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  .run(uid, acc, folder, ++n, `u${n}@x`, `t${n}`, subject, 'a@x.example', '[]', Date.now() - n * 1000, 1, flagged, Date.now()).lastInsertRowid;

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  acc = db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, 'me@example.org', 0, ?)").run(uid, Date.now()).lastInsertRowid;
  inbox = db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'INBOX', '\\Inbox')").run(acc).lastInsertRowid;
  flaggedBox = db.prepare("INSERT INTO folders (account_id, path, name, special_use, sync_enabled) VALUES (?, 'Flagged', 'Flagged', '\\Flagged', 0)").run(acc).lastInsertRowid;
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('the server\'s Flagged folder lists the account\'s flagged mail, including mail flagged just now', async () => {
  add(inbox, 'Already flagged', 1);
  const later = add(inbox, 'Flag me');
  add(inbox, 'Not flagged');
  const list = async () => (await api('GET', `/api/messages?view=folder&folderId=${flaggedBox}`)).items.map((m) => m.subject).sort();
  assert.deepEqual(await list(), ['Already flagged']);
  await api('POST', '/api/messages/actions', { ids: [later], action: 'flag' });
  assert.deepEqual(await list(), ['Already flagged', 'Flag me']);
});

test('a task made from an email can repeat (from its due date)', async () => {
  const id = add(inbox, 'Monthly report');
  const due = Date.now() + 864e5;
  const [t] = await api('POST', `/api/tasks/from-message/${id}`, { items: [{ title: 'Send the report', notes: '', due, rrule: 'FREQ=MONTHLY' }] });
  assert.equal(t.rrule, 'FREQ=MONTHLY');
  const [once] = await api('POST', `/api/tasks/from-message/${id}`, { items: [{ title: 'No date', notes: '', rrule: 'FREQ=MONTHLY' }] });
  assert.equal(once.rrule, null, 'no due date: nothing to repeat from');
});

test('a passing DAV failure is quiet during the first quick retries, then shown with the next try', async () => {
  const { davStatus, DAV_QUIET, DAV_RETRY } = await import('../src/scheduler.js');
  db.prepare("UPDATE accounts SET carddav_url = 'https://dav.example/' WHERE id = ?").run(acc);
  const problems = async () => (await api('GET', '/api/status/problems')).problems?.filter((p) => p.key === `dav:${acc}`) ?? [];
  davStatus.set(acc, { at: Date.now(), error: 'Contacts (CardDAV): 502 Bad Gateway', retry: 1, retryAt: Date.now() + DAV_RETRY[0] });
  assert.deepEqual(await problems(), [], 'not reported while quick retries run');
  davStatus.set(acc, { at: Date.now(), error: 'Contacts (CardDAV): 502 Bad Gateway', retry: DAV_QUIET + 1, retryAt: Date.now() + 60e3 });
  const [p] = await problems();
  assert.equal(p.level, 'warn');
  assert.match(p.text, /trying again at/);
  davStatus.set(acc, { at: Date.now(), error: 'Contacts (CardDAV): the server refused the username or password' });
  assert.equal((await problems())[0].level, 'error', 'a lasting problem is shown at once');
  davStatus.delete(acc);
});

test('automatic retries start quickly and then wait longer and longer', async () => {
  const { RETRY_STEPS } = await import('../src/mail/retry.js');
  assert.ok(RETRY_STEPS[0] <= 60e3 && RETRY_STEPS[1] <= 2 * 60e3, 'the first tries come within a minute or two');
  for (let i = 1; i < RETRY_STEPS.length; i++) assert.ok(RETRY_STEPS[i] > RETRY_STEPS[i - 1]);
});
