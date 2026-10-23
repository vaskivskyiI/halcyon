// Open items for small models: a second opinion must quote the sentence that asks the user; repeated / duplicate
// requests count once; reminders end with their event; the user's email closes what it answers (asked one by one).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r25-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, uid, account, inbox, sent, n = 0, analyzeMessage;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return r.json();
}
const add = (folder, o) => {
  const id = Number(db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, in_reply_to, thread_id, subject, subject_key, from_name, from_addr, to_json, cc_json, date, body_text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, '[]', ?, ?, ?)`).run(uid, account.id, folder.id, ++n, o.msgid || `r25-${n}@x`, o.inReplyTo || null, o.thread || `t${n}`, o.subject,
    o.subject.toLowerCase().replace(/^(re|fw|fwd):\s*/i, ''), o.from, JSON.stringify((o.to || ['me@example.org']).map((a) => ({ name: '', address: a }))), Date.now() - (o.ageH ?? 1) * 3600e3, o.body || 'Hello', Date.now()).lastInsertRowid);
  if (o.ai) db.prepare('INSERT INTO ai_insights (message_id, summary, priority, category, needs_reply, needs_action, action_summary, events_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, o.subject, o.ai.priority ?? 70, o.ai.category || 'work', o.ai.reply ? 1 : 0, o.ai.action ? 1 : 0, o.ai.action || null, '[]', Date.now());
  return id;
};
const view = async (v) => (await api('GET', `/api/messages?view=${v}&threads=0`)).items.map((m) => m.id);
const ins = (id) => db.prepare('SELECT * FROM ai_insights WHERE message_id = ?').get(id);

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  await api('PATCH', '/api/settings', { ai: { autoAnalyze: false } });
  await api('POST', '/api/ai/providers', { type: 'mock', name: 'Mock' });
  account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, 'me@example.org', 0, ?)").run(uid, Date.now()).lastInsertRowid);
  const folder = (p, s) => db.prepare('SELECT * FROM folders WHERE id = ?').get(db.prepare('INSERT INTO folders (account_id, path, name, special_use) VALUES (?, ?, ?, ?)').run(account.id, p, p, s).lastInsertRowid);
  inbox = folder('INBOX', '\\Inbox'); sent = folder('Sent', '\\Sent');
  ({ analyzeMessage } = await import('../src/ai/tasks.js'));
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('the second opinion needs a sentence from the email that asks the user', async () => {
  const { quoted, verifyOpen, notATask, isAutomated } = await import('../src/ai/verify.js');
  assert.ok(quoted('Could you send me the slides by Friday?', 'Hi, could you send me the slides by Friday? Thanks'));
  assert.ok(!quoted('Please sign the contract today', 'Hi, I will look at the invitation and get back to you.'), 'made-up quotes do not count');
  assert.ok(notATask('Add session to calendar by 23 Oct') && notATask('Attend the meeting on Monday') && !notATask('Pay invoice 77'));
  assert.ok(isAutomated({ from_addr: 'no-reply@shop.example' }) && isAutomated({ from_addr: 'f7-quantum-bounces@lists.example' }) && !isAutomated({ from_addr: 'ana@x.example' }));
  // The sender says she will answer later: the first analysis (mock: "?" anywhere) flags it; the check finds nothing.
  const m = { id: 0, subject: 'Re: Invitation', body_text: 'Thank you, I will review the invitation and respond shortly.\n\nOn Mon, Me wrote:\n> Will you come to the conference?' };
  const d = await verifyOpen(uid, m, { needs_reply: true, needs_action: true, action_summary: 'Reply' }, { ctx: '', conversation: '', message: 'From: Martina\n\nThank you, I will review the invitation and respond shortly.' });
  assert.deepEqual([d.needs_reply, d.needs_action], [false, false]);
  // A real question stays.
  const q = { id: 0, subject: 'Budget', body_text: 'Hi, can you approve the budget by Friday?' };
  const e = await verifyOpen(uid, q, { needs_reply: true, needs_action: true }, { ctx: '', conversation: '', message: 'From: Ana\n\nHi, can you approve the budget by Friday?' });
  assert.deepEqual([e.needs_reply, e.needs_action], [true, true]);
});

test('analysis: automated mail never needs a reply', async () => {
  const a = add(inbox, { subject: 'Your order', from: 'no-reply@shop.example', body: 'Is everything OK with your order? Rate us.' });
  await analyzeMessage(uid, a, { interactive: true });
  assert.equal(ins(a).needs_reply, 0);
});

test('only the newest of repeated or duplicate requests from a sender is open', async () => {
  const r1 = add(inbox, { subject: '1 moderator request waiting', from: 'list-bounces@lists.example', ai: { action: 'Approve the request' }, ageH: 48 });
  const r2 = add(inbox, { subject: '1 moderator request waiting', from: 'list-bounces@lists.example', ai: { action: 'Approve the request' }, ageH: 24 });
  const r3 = add(inbox, { subject: '1 moderator request waiting', from: 'list-bounces@lists.example', ai: { action: 'Approve the request' }, ageH: 2 });
  // The same email received twice (two accounts): counted once.
  const d1 = add(inbox, { subject: 'Year report', from: 'andrei@x.example', ai: { action: 'Review the report' }, ageH: 5 });
  const d2 = add(inbox, { subject: 'Year report', from: 'andrei@x.example', ai: { action: 'Review the report' }, ageH: 5 });
  db.prepare('UPDATE messages SET date = (SELECT date FROM messages WHERE id = ?) WHERE id = ?').run(d1, d2);
  // A request followed by "thanks" from the same person in the same conversation stays open.
  const q = add(inbox, { subject: 'Re: Plan', from: 'ana@x.example', ai: { reply: true }, ageH: 6 });
  add(inbox, { subject: 'Re: Plan', from: 'ana@x.example', ai: {}, ageH: 5 });
  const open = await view('needsaction');
  assert.ok(open.includes(r3) && !open.includes(r1) && !open.includes(r2));
  assert.equal([d1, d2].filter((x) => open.includes(x)).length, 1);
  assert.ok((await view('needsreply')).includes(q));
  // The list labels agree; marking the newest done does not bring the older ones back.
  const rows = (await api('GET', '/api/messages?view=unified&threads=0')).items;
  assert.equal(rows.find((m) => m.id === r1).ai.needsAction, false);
  assert.equal(rows.find((m) => m.id === r3).ai.needsAction, true);
  await api('POST', `/api/messages/${r3}/dismiss`, { resolution: 'done' });
  assert.ok(!(await view('needsaction')).some((x) => [r1, r2, r3].includes(x)));
});

test('the user\'s reply closes the requests it answers (checked one by one), also actions', async () => {
  const ask = add(inbox, { subject: 'Guidelines PDF', from: 'jasa@x.example', thread: 'g', msgid: 'g1@x', ai: { action: 'Send the PDF guidelines' }, ageH: 10 });
  const other = add(inbox, { subject: 'Lab access', from: 'jasa@x.example', thread: 'l', ai: { reply: true }, ageH: 9 });
  const mine = add(sent, { subject: 'Re: Guidelines PDF', from: 'me@example.org', to: ['jasa@x.example'], thread: 'g', inReplyTo: 'g1@x', body: 'Here are the guidelines pdf you asked for.', ageH: 1 });
  await analyzeMessage(uid, mine, { interactive: true });
  assert.equal(ins(ask).resolution, 'done'); assert.equal(ins(ask).resolved_by, mine);
  assert.equal(ins(other).dismissed_at, null, 'unrelated request stays open');
});
