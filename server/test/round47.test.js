// Older mail analysed by hand (one folder or archive; old mail quietly); things made from an email go to the
// calendar / list / address book of its space; failed changes and unreachable sends are tried again by themselves.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r47-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, uid;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
const account = (email, space, extra = '') => {
  const id = db.prepare(`INSERT INTO accounts (user_id, email, sync_enabled, space, created_at${extra ? ', kind' : ''}) VALUES (?, ?, 0, ?, ?${extra ? ', ?' : ''})`).run(uid, email, space, Date.now(), ...(extra ? [extra] : [])).lastInsertRowid;
  const folder = db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'INBOX', ?)").run(id, extra ? null : '\\Inbox').lastInsertRowid;
  return { id, folder };
};
let n = 0;
const mail = (a, days, from = 'ana@x.example') => db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, message_id, thread_id, subject, from_name, from_addr, to_json, date, created_at)
  VALUES (?, ?, ?, ?, ?, 'Hello', 'Ana Novak', ?, '[]', ?, ?)`).run(uid, a.id, a.folder, `r${++n}@x`, `t${n}`, from, Date.now() - days * 864e5, Date.now()).lastInsertRowid;

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('older mail of one folder or archive is analysed by hand; mail older than the open-items window quietly', async () => {
  const box = account('me@example.org', 'Work');
  const arch = account('Old', '', 'archive');
  const recent = mail(box, 3), old = mail(box, 400);
  mail(arch, 900); mail(arch, 1000);
  assert.deepEqual(await api('POST', '/api/ai/reprocess', { folderId: box.folder, days: 'all', mode: 'missing', count: true }), { count: 2 });
  assert.deepEqual(await api('POST', '/api/ai/reprocess', { folderId: box.folder, days: 30, count: true }), { count: 1 });
  assert.deepEqual(await api('POST', '/api/ai/reprocess', { accountId: arch.id, days: 'all', count: true }), { count: 2 }, 'archives too');
  await api('POST', '/api/ai/reprocess', { folderId: box.folder, days: 'all' });
  const job = (id) => db.prepare("SELECT options_json FROM ai_jobs WHERE type = 'analyze' AND ref_id = ?").get(String(id));
  assert.equal(job(recent).options_json, null);
  assert.deepEqual(JSON.parse(job(old).options_json), { quiet: true });
  await assert.rejects(api('POST', '/api/ai/reprocess', { folderId: 999999, count: true }), /404/);
});

test('an event, task or contact made from an email goes to its space; the sender is saved once', async () => {
  const work = account('me@work.example', 'Work');
  const cal = db.prepare("INSERT INTO calendars (user_id, account_id, name, color, source, url, created_at) VALUES (?, ?, 'Work cal', '#000', 'caldav', 'https://d/w/', ?)").run(uid, work.id, Date.now()).lastInsertRowid;
  const list = db.prepare("INSERT INTO task_lists (user_id, account_id, name, source, url, created_at) VALUES (?, ?, 'Work tasks', 'caldav', 'https://d/w/', ?)").run(uid, work.id, Date.now()).lastInsertRowid;
  const book = db.prepare("INSERT INTO address_books (user_id, account_id, name, source, url, created_at) VALUES (?, ?, 'Work people', 'carddav', 'https://d/p/', ?)").run(uid, work.id, Date.now()).lastInsertRowid;
  const m = mail(work, 1, 'marko@x.example');
  const t = await api('GET', `/api/messages/${m}/targets`);
  assert.deepEqual([t.space, t.calendarId, t.taskListId, t.bookId], ['Work', cal, list, book]);
  // Collected before (from mail): saved now as a real contact in the space's book — no duplicate.
  const { collectAddresses } = await import('../src/contacts/service.js');
  collectAddresses(uid, [{ address: 'marko@x.example', name: 'Marko' }], Date.now(), true, work.id);
  const r = await api('POST', `/api/messages/${m}/save-sender`, {});
  assert.equal(r.book, 'Work people');
  const rows = db.prepare("SELECT address_book_id, auto_collected, dirty FROM contacts WHERE emails_json LIKE '%marko@x.example%'").all();
  assert.deepEqual(rows, [{ address_book_id: book, auto_collected: 0, dirty: 1 }]);
  assert.equal((await api('POST', `/api/messages/${m}/save-sender`, {})).existed, true);
});

test('failed server changes and unreachable sends are tried again by themselves, with growing pauses', async () => {
  const { autoRetry, RETRY_STEPS } = await import('../src/mail/retry.js');
  const a = account('me@retry.example', '');
  const op = db.prepare("INSERT INTO pending_ops (account_id, op, payload_json, attempts, error, created_at) VALUES (?, 'flag', '{}', 5, 'NO server busy', ?)").run(a.id, Date.now()).lastInsertRowid;
  const unreached = db.prepare("INSERT INTO outbox (user_id, account_id, payload_json, status, attempts, error, send_at, created_at) VALUES (?, ?, '{\"subject\":\"Hi\"}', 'failed', 5, 'connect ECONNREFUSED 1.2.3.4:587', ?, ?)").run(uid, a.id, Date.now() - 864e5, Date.now()).lastInsertRowid;
  const maybeSent = db.prepare("INSERT INTO outbox (user_id, account_id, payload_json, status, attempts, error, send_at, created_at) VALUES (?, ?, '{\"subject\":\"Hm\"}', 'failed', 5, 'Timeout after DATA', ?, ?)").run(uid, a.id, Date.now() - 864e5, Date.now()).lastInsertRowid;

  let p = (await api('GET', '/api/status/problems')).problems;
  assert.match(p.find((x) => x.key === `op:${op}`).title, /trying again automatically/);
  assert.equal(p.find((x) => x.key === `op:${op}`).level, 'warn');
  assert.equal(p.find((x) => x.key === `outbox:${maybeSent}`).level, 'error', 'might have gone out: left to the user');

  const t0 = Date.now();
  await autoRetry(t0);
  const o1 = db.prepare('SELECT attempts, next_retry_at, auto_retries FROM pending_ops WHERE id = ?').get(op);
  assert.deepEqual([o1.attempts, o1.next_retry_at, o1.auto_retries], [5, t0 + RETRY_STEPS[0], 0], 'first: the pause is set');
  await autoRetry(t0 + RETRY_STEPS[0] + 1);
  const o2 = db.prepare('SELECT attempts, auto_retries, next_retry_at FROM pending_ops WHERE id = ?').get(op);
  assert.deepEqual([o2.attempts, o2.auto_retries], [4, 1], 'given one more try');
  assert.ok(o2.next_retry_at > t0 + RETRY_STEPS[0], 'and a longer pause before the next');
  assert.equal(db.prepare('SELECT status FROM outbox WHERE id = ?').get(unreached).status, 'queued', 'never reached the server: sent again');
  assert.equal(db.prepare('SELECT status FROM outbox WHERE id = ?').get(maybeSent).status, 'failed');
  // When the retry works, the change is gone — and so is the problem.
  db.prepare('DELETE FROM pending_ops WHERE id = ?').run(op);
  p = (await api('GET', '/api/status/problems')).problems;
  assert.ok(!p.some((x) => x.key === `op:${op}`));
  db.prepare('DELETE FROM outbox WHERE account_id = ?').run(a.id);
});
