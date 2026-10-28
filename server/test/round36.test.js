// "Done" / "Not doing it" settles every copy of the email and the conversation's other open items (the brief and
// Action needed drop them all; undo brings back exactly those); recent conversations with a person.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r36-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, uid, account, inbox, archive, sent, trash, n = 0;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
const add = (folder, o) => Number(db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, thread_id, subject, from_name, from_addr, to_json, cc_json, date, body_text, is_read, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, '[]', ?, '', 1, ?)`).run(uid, account.id, folder.id, ++n, o.msgid || `r36-${n}@x`, o.thread || `t${n}`, o.subject, o.from,
  JSON.stringify((o.to || ['me@example.org']).map((a) => ({ name: '', address: a }))), Date.now() - (o.ageH || 1) * 3600e3, Date.now()).lastInsertRowid);
const action = (id, summary = 'Sign the contract') => db.prepare(`INSERT INTO ai_insights (message_id, priority, needs_action, action_summary, category, summary, created_at)
  VALUES (?, 80, 1, ?, 'work', ?, ?)`).run(id, summary, summary, Date.now());
const actionView = async () => (await api('GET', '/api/messages?view=needsaction&threads=0')).items.map((m) => m.id);
const briefActions = async () => {
  const { briefLive } = await import('../src/ai/tasks.js');
  const l = briefLive(uid);
  return [...l.actions, ...l.attention].map((m) => m.id);
};

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
  inbox = folder('INBOX', '\\Inbox'); archive = folder('Archive', '\\Archive'); sent = folder('Sent', '\\Sent'); trash = folder('Trash', '\\Trash');
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('"Not doing it" removes the item from Action needed and the brief, for every copy and the conversation', async () => {
  const a = add(inbox, { subject: 'Contract', from: 'ana@x.example', thread: 'c', msgid: 'contract@x', ageH: 5 });
  const copy = add(archive, { subject: 'Contract', from: 'ana@x.example', thread: 'c', msgid: 'contract@x', ageH: 5 });
  const later = add(inbox, { subject: 'Re: Contract', from: 'ana@x.example', thread: 'c', ageH: 2 });
  const other = add(inbox, { subject: 'Invoice', from: 'bob@x.example', thread: 'i', ageH: 3 });
  for (const id of [a, copy, later, other]) action(id);
  assert.deepEqual((await actionView()).sort(), [a, later, other].sort());
  assert.ok((await briefActions()).includes(a));

  await api('POST', `/api/messages/${a}/dismiss`, { resolution: 'skipped', thread: true });
  assert.deepEqual(await actionView(), [other], 'the copy and the rest of the conversation went with it');
  assert.deepEqual(await briefActions(), [other]);
  assert.equal(db.prepare('SELECT resolution FROM ai_insights WHERE message_id = ?').get(copy).resolution, 'skipped');

  await api('POST', `/api/messages/${a}/dismiss`, { dismissed: false, thread: true });
  assert.deepEqual((await actionView()).sort(), [a, later, other].sort(), 'undo brings back exactly what it settled');
});

test('without `thread` only the email and its copies are settled', async () => {
  const x = add(inbox, { subject: 'Form', from: 'cid@x.example', thread: 'f', msgid: 'form@x', ageH: 4 });
  const y = add(inbox, { subject: 'Re: Form', from: 'cid@x.example', thread: 'f', ageH: 1 });
  action(x); action(y);
  await api('POST', `/api/messages/${x}/dismiss`, { resolution: 'done' });
  const open = await actionView();
  assert.ok(!open.includes(x) && open.includes(y));
});

test('recent conversations with a person: from and to them, newest first, not this one, not Trash, not myself', async () => {
  const t1 = add(inbox, { subject: 'Shoot dates', from: 'dana@x.example', thread: 'p1', ageH: 30 });
  add(inbox, { subject: 'Re: Shoot dates', from: 'dana@x.example', thread: 'p1', ageH: 20 });
  const mine = add(sent, { subject: 'Gift card', from: 'me@example.org', to: ['dana@x.example'], thread: 'p2', ageH: 10 });
  add(trash, { subject: 'Old', from: 'dana@x.example', thread: 'p3', ageH: 5 });
  const cur = add(inbox, { subject: 'Now', from: 'dana@x.example', thread: 'p4', ageH: 1 });
  const r = await api('GET', `/api/messages/${cur}/recent-with`);
  assert.equal(r.person.address, 'dana@x.example');
  const list = r.threads;
  assert.deepEqual(list.map((t) => t.subject), ['Gift card', 'Re: Shoot dates']);
  assert.equal(list[1].count, 2);
  assert.equal(list[0].id, mine);
  assert.ok(![t1, cur].includes(list[0].id));
  // My own email: the person is its recipient.
  const r2 = await api('GET', `/api/messages/${mine}/recent-with`);
  assert.equal(r2.person.address, 'dana@x.example');
  assert.deepEqual(r2.threads.map((t) => t.subject), ['Now', 'Re: Shoot dates']);
});

test('a shared space\'s message opened by link: the 404 says whose it is (members only)', async () => {
  const sp = await api('POST', '/api/shared', { name: 'Studio' });
  const acc = db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, 'studio@example.org', 0, ?)").run(sp.id, Date.now()).lastInsertRowid;
  const f = db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'INBOX', '\Inbox')").run(acc).lastInsertRowid;
  const id = Number(db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, thread_id, subject, from_addr, to_json, date, created_at)
    VALUES (?, ?, ?, 1, 'studio-1@x', 's1', 'Booking', 'client@x.example', '[]', ?, ?)`).run(sp.id, acc, f, Date.now(), Date.now()).lastInsertRowid);
  const r = await fetch(`${base}/api/messages/${id}`, { headers: { cookie } });
  assert.equal(r.status, 404);
  assert.equal((await r.json()).owner, sp.id);
  const ok = await fetch(`${base}/api/messages/${id}`, { headers: { cookie, 'x-halcyon-as': String(sp.id) } });
  assert.equal((await ok.json()).subject, 'Booking');
  // Someone else's message: no hint.
  const other = Number(db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, thread_id, subject, from_addr, to_json, date, created_at)
    VALUES (9999, ?, ?, 2, 'x-1@x', 'x1', 'Private', 'a@x.example', '[]', ?, ?)`).run(acc, f, Date.now(), Date.now()).lastInsertRowid);
  const no = await fetch(`${base}/api/messages/${other}`, { headers: { cookie } });
  assert.deepEqual(await no.json(), { error: 'Not found' });
});
