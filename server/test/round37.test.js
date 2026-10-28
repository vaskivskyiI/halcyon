// Several actions in one email (or conversation), each settled on its own: the email leaves Action needed only when
// all its items are settled; reopening one item reopens the email and keeps the others settled.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r37-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, uid, account, inbox, archive, n = 0;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
const add = (folder, o) => Number(db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, thread_id, subject, from_name, from_addr, to_json, cc_json, date, body_text, is_read, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, '[]', '[]', ?, '', 1, ?)`).run(uid, account.id, folder.id, ++n, o.msgid || `r37-${n}@x`, o.thread || `t${n}`, o.subject, o.from || 'ana@x.example', Date.now() - 3600e3, Date.now()).lastInsertRowid);
const withItems = (id, items) => db.prepare(`INSERT INTO ai_insights (message_id, priority, needs_action, action_summary, action_items_json, category, created_at)
  VALUES (?, 80, 1, 'Sign and pay', ?, 'work', ?)`).run(id, JSON.stringify(items.map((text) => ({ text, due: null }))), Date.now());
const open = async () => (await api('GET', '/api/messages?view=needsaction&threads=0')).items.map((m) => m.id);
const item = (id, text, resolution) => api('POST', `/api/messages/${id}/action-item`, { text, resolution });

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  await api('PATCH', '/api/settings', { ai: { autoAnalyze: false, embeddings: false } });
  account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, 'me@example.org', 0, ?)").run(uid, Date.now()).lastInsertRowid);
  const folder = (p, s) => db.prepare('SELECT * FROM folders WHERE id = ?').get(db.prepare('INSERT INTO folders (account_id, path, name, special_use) VALUES (?, ?, ?, ?)').run(account.id, p, p, s).lastInsertRowid);
  inbox = folder('INBOX', '\\Inbox'); archive = folder('Archive', '\\Archive');
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('items are settled one by one; the email leaves Action needed when all are', async () => {
  const id = add(inbox, { subject: 'Contract', msgid: 'c@x' });
  const copy = add(archive, { subject: 'Contract', msgid: 'c@x' });
  withItems(id, ['Sign the contract', 'Pay the deposit']); withItems(copy, ['Sign the contract', 'Pay the deposit']);
  let r = await item(id, 'Sign the contract', 'done');
  assert.equal(r.insight.dismissed, false);
  assert.equal(r.insight.actionState['sign the contract'].resolution, 'done');
  assert.ok((await open()).includes(id), 'one item left: still open');
  r = await item(id, 'Pay the deposit', 'skipped');
  assert.equal(r.insight.dismissed, true);
  assert.equal(r.insight.resolution, 'done', 'some done, some not: done');
  assert.ok(!(await open()).includes(id));
  assert.ok(db.prepare('SELECT dismissed_at FROM ai_insights WHERE message_id = ?').get(copy).dismissed_at, 'the copy went along');
  r = await item(id, 'Pay the deposit', null);
  assert.equal(r.insight.dismissed, false);
  assert.deepEqual(Object.keys(r.insight.actionState), ['sign the contract']);
  assert.ok((await open()).includes(id));
});

test('all items not done → "not doing it"; settling the whole email, then reopening one item keeps the rest', async () => {
  const id = add(inbox, { subject: 'Survey' });
  withItems(id, ['Fill in the survey', 'Register for the event']);
  await item(id, 'Fill in the survey', 'skipped');
  const r = await item(id, 'Register for the event', 'skipped');
  assert.equal(r.insight.resolution, 'skipped');

  const id2 = add(inbox, { subject: 'Order' });
  withItems(id2, ['Approve the order', 'Book the courier', 'Send the address']);
  await api('POST', `/api/messages/${id2}/dismiss`, { resolution: 'done' });
  const r2 = await item(id2, 'Book the courier', null);
  assert.equal(r2.insight.dismissed, false);
  assert.deepEqual(Object.keys(r2.insight.actionState).sort(), ['approve the order', 'send the address']);
  // Undo of the whole email reopens all of its items.
  await api('POST', `/api/messages/${id2}/dismiss`, { resolution: 'done' });
  await api('POST', `/api/messages/${id2}/dismiss`, { dismissed: false });
  assert.equal(db.prepare('SELECT action_state_json FROM ai_insights WHERE message_id = ?').get(id2).action_state_json, null);
});

test('settling one email of a conversation leaves the conversation\'s other actions open', async () => {
  const a = add(inbox, { subject: 'Event', thread: 'ev' });
  const b = add(inbox, { subject: 'Re: Event', thread: 'ev', from: 'bob@x.example' });
  withItems(a, ['Book the room']); withItems(b, ['Order catering']);
  await item(a, 'Book the room', 'done');
  const o = await open();
  assert.ok(!o.includes(a) && o.includes(b));
});

test('a reminder repeating the request is settled with it; a different request of the same conversation shows up once the newer one is settled', async () => {
  const key = (id, k) => db.prepare('UPDATE messages SET subject_key = ?, date = date + ? WHERE id = ?').run(k, id * 1000, id);
  const first = add(inbox, { subject: 'Invoice 42', thread: 'inv' });
  const reminder = add(inbox, { subject: 'Re: Invoice 42', thread: 'inv' });
  key(first, 'invoice 42'); key(reminder, 'invoice 42');
  withItems(first, ['Pay invoice 42']); withItems(reminder, ['Pay invoice 42']);
  let o = await open();
  assert.ok(o.includes(reminder) && !o.includes(first), 'the reminder stands for both');
  await item(reminder, 'Pay invoice 42', 'done');
  o = await open();
  assert.ok(!o.includes(reminder) && !o.includes(first), 'the earlier copy of the request went along');
  await item(reminder, 'Pay invoice 42', null);
  assert.ok((await open()).includes(reminder));
  assert.equal(db.prepare('SELECT dismissed_at FROM ai_insights WHERE message_id = ?').get(first).dismissed_at, null);

  const a = add(inbox, { subject: 'Kickoff', thread: 'ko' });
  const b = add(inbox, { subject: 'Re: Kickoff', thread: 'ko' });
  key(a, 'kickoff'); key(b, 'kickoff');
  withItems(a, ['Confirm the time']); withItems(b, ['Read the agenda']);
  o = await open();
  assert.ok(o.includes(b) && !o.includes(a));
  await item(b, 'Read the agenda', 'done');
  o = await open();
  assert.ok(o.includes(a) && !o.includes(b), 'a different request is not settled with it and comes back into view');
});
