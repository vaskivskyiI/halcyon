// New mail is visible at once, in Other while the AI has not read it; the activity panel says what runs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r64-test-'));
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, uid, acc, inbox;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return r.json();
}
let n = 0;
const mail = (subject) => Number(db.prepare('INSERT INTO messages (user_id, account_id, folder_id, message_id, thread_id, subject, subject_key, from_addr, date, is_read) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)')
  .run(uid, acc, inbox, `<${++n}@x>`, `t${n}`, subject, subject, 'a@x.example', Date.now()).lastInsertRowid);
const job = (id, status) => db.prepare("INSERT INTO ai_jobs (user_id, type, ref_id, priority, status, run_after, created_at, updated_at) VALUES (?, 'analyze', ?, 50, ?, 9999999999999, ?, ?)").run(uid, String(id), status, Date.now(), Date.now());
const tab = async (filter) => (await api('GET', `/api/messages?view=unified&filter=${filter}`)).items.map((m) => m.id);

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  acc = db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, 'a@x.example', 0, ?)").run(uid, Date.now()).lastInsertRowid;
  inbox = db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'Inbox', '\\Inbox')").run(acc).lastInsertRowid;
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('mail waiting for the AI is in Other, in no gap; afterwards it goes where the analysis says', async () => {
  const id = mail('Fresh');
  job(id, 'queued');
  assert.ok((await tab('other')).includes(id));
  assert.ok(!(await tab('focused')).includes(id));
  const counts = await api('GET', '/api/messages/tab-counts?view=unified');
  assert.deepEqual([counts.other, counts.focused, counts.all], [1, 0, 1]);
  db.prepare("INSERT INTO ai_insights (message_id, summary, category, priority, model, created_at) VALUES (?, 's', 'work', 80, 'm', ?)").run(id, Date.now());
  db.prepare("UPDATE ai_jobs SET status = 'done'").run();
  assert.ok((await tab('focused')).includes(id));
  assert.ok(!(await tab('other')).includes(id));
});

test('mail the AI will not read stays in Focused', async () => {
  const id = mail('No AI for this');
  assert.ok((await tab('focused')).includes(id));
  const failed = mail('Analysis failed');
  job(failed, 'failed');
  assert.ok((await tab('focused')).includes(failed));
});

test('the activity list shows running and waiting work and leaves archives out of mail accounts', async () => {
  db.prepare('UPDATE accounts SET sync_enabled = 1 WHERE id = ?').run(acc);
  db.prepare("INSERT INTO accounts (user_id, email, kind, sync_enabled, created_at) VALUES (?, '', 'archive', 0, ?)").run(uid, Date.now());
  const id = mail('Being read');
  job(id, 'running');
  job(mail('Next'), 'queued');
  const a = await api('GET', '/api/activity');
  assert.deepEqual(a.mail.map((x) => x.email), ['a@x.example']);
  assert.equal(a.ai.running[0].subject, 'Being read');
  assert.deepEqual(a.ai.queued.map((q) => [q.label, q.n]), [['Analysing email', 1]]);
  db.prepare('UPDATE accounts SET sync_enabled = 0 WHERE id = ?').run(acc);
});
