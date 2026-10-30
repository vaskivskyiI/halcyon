// Settling something shows in the summaries, and removing "needs reply" takes the whole conversation out of the list.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r56-test-'));
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, uid, T, acc, inbox, n = 0;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return r.json();
}
function mail({ thread = null, subject = 'Budget', from = 'ana@x.example', mid = `<m${++n}@x>`, summary = 'Ana asks you to sign the form.', items = [], reply = 1, action = 0, ago = 1 }) {
  const id = db.prepare('INSERT INTO messages (user_id, account_id, folder_id, message_id, thread_id, subject, subject_key, from_addr, date, is_read, is_answered) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)')
    .run(uid, acc, inbox, mid, thread, subject, subject.toLowerCase(), from, Date.now() - ago * 36e5).lastInsertRowid;
  db.prepare("INSERT INTO ai_insights (message_id, summary, category, priority, needs_reply, needs_action, action_summary, action_items_json, model, created_at) VALUES (?, ?, 'work', 70, ?, ?, ?, ?, 'mock', ?)")
    .run(id, summary, reply, action, action ? 'Sign the form' : null, JSON.stringify(items), Date.now());
  return Number(id);
}
const insight = (id) => db.prepare('SELECT * FROM ai_insights WHERE message_id = ?').get(id);
const listed = async () => (await api('GET', '/api/messages?view=needsreply')).items.map((m) => m.id);

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  T = await import('../src/ai/tasks.js');
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  await api('POST', '/api/ai/providers', { type: 'mock', name: 'Mock' });
  acc = db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, 'me@example.org', 0, ?)").run(uid, Date.now()).lastInsertRowid;
  inbox = db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'Inbox', '\\Inbox')").run(acc).lastInsertRowid;
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('removing "needs reply" from the latest email clears the whole conversation', async () => {
  const a = mail({ thread: 't1', subject: 'Trip', ago: 5 }), b = mail({ thread: 't1', subject: 'Re: Trip', from: 'bo@x.example', ago: 3 }), c = mail({ thread: 't1', subject: 'Re: Trip', from: 'cy@x.example', ago: 1 });
  db.prepare('UPDATE ai_insights SET needs_reply_user = 1 WHERE message_id = ?').run(b);
  assert.ok((await listed()).includes(c));
  await api('POST', '/api/messages/needs-reply', { ids: [c], value: false, threads: true });
  const left = await listed();
  for (const id of [a, b, c]) assert.ok(!left.includes(id), `message ${id} left the list`);
});

test('an older repeat and a copy do not take the place of the email cleared, even without conversations', async () => {
  const old = mail({ subject: 'Invoice', ago: 30 }), last = mail({ subject: 'Invoice', mid: '<same@x>', ago: 2 }), copy = mail({ subject: 'Invoice', mid: '<same@x>', ago: 2 });
  const other = mail({ subject: 'Invoice', from: 'someone@x.example', ago: 2 });
  await api('POST', '/api/messages/needs-reply', { ids: [last], value: false });
  const left = await listed();
  for (const id of [old, last, copy]) assert.ok(!left.includes(id));
  assert.ok(left.includes(other), 'another sender is another matter');
});

test('an item done shows in the summary of the email, a copy follows, and reopening brings back the first summary', async () => {
  const first = 'Ana asks you to sign the form.';
  const id = mail({ mid: '<sum@x>', subject: 'Form', items: [{ text: 'Sign the form' }, { text: 'Pay the fee' }], action: 1, reply: 0 }), copy = mail({ mid: '<sum@x>', subject: 'Form', items: [{ text: 'Sign the form' }, { text: 'Pay the fee' }], action: 1, reply: 0 });
  await api('POST', `/api/messages/${id}/action-item`, { text: 'Sign the form', resolution: 'done' });
  await api('POST', `/api/messages/${id}/action-item`, { text: 'Pay the fee', resolution: 'skipped' });
  await T.settledSummaryJob(uid, id);
  const s = insight(id).summary;
  assert.match(s, /"Sign the form": done/);
  assert.match(s, /"Pay the fee": the user decided not to do it/);
  assert.equal(insight(id).summary_base, first);
  assert.equal(insight(copy).summary, s);
  await api('POST', `/api/messages/${id}/action-item`, { text: 'Sign the form', resolution: null });
  await api('POST', `/api/messages/${id}/action-item`, { text: 'Pay the fee', resolution: null });
  await T.settledSummaryJob(uid, id);
  assert.equal(insight(id).summary, first);
  assert.equal(insight(id).summary_base, null);
});

test('a conversation summary is written again with what is settled; settling asks for it', async () => {
  const a = mail({ thread: 't2', subject: 'Plan', mid: '<p1@x>', ago: 4, reply: 0, action: 1, items: [{ text: 'Book the room' }] }), b = mail({ thread: 't2', subject: 'Re: Plan', mid: '<p2@x>', ago: 2 });
  db.prepare("INSERT INTO thread_summaries (user_id, thread_id, summary, message_count, model, updated_at) VALUES (?, 't2', '- You still have to book the room', 2, 'mock', ?)").run(uid, Date.now());
  await api('POST', `/api/messages/${a}/dismiss`, { resolution: 'done' });
  await api('POST', '/api/messages/needs-reply', { ids: [b], value: false, threads: true });
  const job = db.prepare("SELECT * FROM ai_jobs WHERE type = 'thread' AND ref_id = 't2'").get();
  assert.equal(job.status, 'queued');
  await T.summarizeThreadJob(uid, 't2', job);
  const s = db.prepare("SELECT summary FROM thread_summaries WHERE thread_id = 't2'").get().summary;
  assert.match(s, /"Book the room": done/);
  assert.match(s, /no reply is needed/);
});

test('unchanged conversations are not summarised again', async () => {
  const before = db.prepare("SELECT summary FROM thread_summaries WHERE thread_id = 't2'").get().summary;
  const r = await T.summarizeThreadJob(uid, 't2');
  assert.equal(r.summary, before);
});

test('less important actions wait for the user: suggested, then taken on or ignored; re-analysis keeps the answer', async () => {
  const view = async (v) => (await api('GET', `/api/messages?view=${v}`)).items.map((m) => m.id);
  const low = mail({ thread: 'p1', subject: 'Permit', action: 1, reply: 0 }), note = mail({ thread: 'p2', subject: 'Bill due', action: 1, reply: 0 }), ad = mail({ thread: 'p3', subject: 'Sale', action: 1, reply: 0 });
  const big = mail({ thread: 'p4', subject: 'Contract', action: 1, reply: 0 }), bill = mail({ thread: 'p5', subject: 'Final notice', action: 1, reply: 0 });
  db.prepare('UPDATE ai_insights SET priority = 5 WHERE message_id = ?').run(low);
  db.prepare("UPDATE ai_insights SET category = 'notification', priority = 40 WHERE message_id = ?").run(note);
  db.prepare("UPDATE ai_insights SET category = 'promotion' WHERE message_id = ?").run(ad);
  db.prepare("UPDATE ai_insights SET category = 'notification', priority = 80 WHERE message_id = ?").run(bill);
  let open = await view('needsaction'), sugg = await view('suggested');
  assert.ok(open.includes(big) && open.includes(bill), 'what matters goes in by itself');
  for (const id of [low, note, ad]) { assert.ok(!open.includes(id)); assert.ok(sugg.includes(id)); }
  assert.ok(!sugg.includes(big));
  assert.equal((await api('GET', `/api/threads/p1`)).messages[0].insight.actionSuggested, true);
  const r = await api('POST', `/api/messages/${low}/action-suggestion`, { accept: true });
  assert.deepEqual([r.insight.needsAction, r.insight.actionSuggested], [true, false]);
  await api('POST', `/api/messages/${note}/action-suggestion`, { accept: false });
  open = await view('needsaction'); sugg = await view('suggested');
  assert.ok(open.includes(low) && !sugg.includes(low));
  assert.ok(!open.includes(note) && !sugg.includes(note), 'ignored: in neither');
  await api('POST', `/api/messages/${note}/action-suggestion`, { accept: null });
  assert.ok((await view('suggested')).includes(note), 'undo asks again');
  await T.analyzeMessage(uid, low, { force: true });
  assert.ok((await view('needsaction')).includes(low), 'the answer survives re-analysis');
});

test('mail that lists items without the flag is analysed again once', async () => {
  const id = mail({ subject: 'Old analysis', items: [{ text: 'Sign the form' }], reply: 0 });
  assert.ok(T.reanalyzeItems() >= 1);
  assert.equal(db.prepare("SELECT status FROM ai_jobs WHERE type = 'analyze' AND ref_id = ?").get(String(id))?.status != null, true);
  assert.equal(T.reanalyzeItems(), 0);
});
