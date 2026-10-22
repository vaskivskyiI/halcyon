// Open items you can trust: replies are recognised from the conversation (from any client) and, by the AI, across
// conversations; AI guesses about low-priority or old mail do not linger; corrections teach the AI per sender.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r22-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, uid, account, inbox, sent, n = 0;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
const add = (folder, o) => {
  const id = Number(db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, in_reply_to, thread_id, subject, from_name, from_addr, to_json, cc_json, date, body_text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, '[]', ?, ?, ?)`).run(uid, account.id, folder.id, ++n, o.msgid || `r22-${n}@x`, o.inReplyTo || null, o.thread || `t${n}`, o.subject, o.from,
    JSON.stringify((o.to || ['me@example.org']).map((a) => ({ name: '', address: a }))), Date.now() - (o.ageH || 1) * 3600e3, o.body || 'Hello', Date.now()).lastInsertRowid);
  if (o.ai) db.prepare('INSERT INTO ai_insights (message_id, summary, priority, category, needs_reply, needs_action, action_summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, o.subject, o.ai.priority ?? 60, o.ai.category || 'work', o.ai.reply ? 1 : 0, o.ai.action ? 1 : 0, o.ai.action || null, Date.now());
  return id;
};
const view = async (v) => (await api('GET', `/api/messages?view=${v}&threads=0`)).items.map((m) => m.id);

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  await api('PATCH', '/api/settings', { ai: { autoAnalyze: false } });
  account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, 'me@example.org', 0, ?)").run(uid, Date.now()).lastInsertRowid);
  const folder = (p, s) => db.prepare('SELECT * FROM folders WHERE id = ?').get(db.prepare('INSERT INTO folders (account_id, path, name, special_use) VALUES (?, ?, ?, ?)').run(account.id, p, p, s).lastInsertRowid);
  inbox = folder('INBOX', '\\Inbox'); sent = folder('Sent', '\\Sent');
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('only recent AI guesses about mail that matters count as open; the user\'s own marks always do', async () => {
  const real = add(inbox, { subject: 'Question about the budget', from: 'ana@x.example', ai: { reply: true } });
  const news = add(inbox, { subject: 'Register for our webinar', from: 'news@shop.example', ai: { reply: true, action: 'Register for the webinar', category: 'newsletter', priority: 70 } });
  const low = add(inbox, { subject: 'FYI', from: 'bob@x.example', ai: { reply: true, priority: 20 } });
  const old = add(inbox, { subject: 'Old request', from: 'bob@x.example', ai: { reply: true, action: 'Review the draft' }, ageH: 24 * 20 });
  const act = add(inbox, { subject: 'Invoice 77', from: 'billing@vendor.example', ai: { action: 'Pay invoice 77', priority: 65 } });
  assert.deepEqual(await view('needsreply'), [real]);
  assert.deepEqual(await view('needsaction'), [act]);
  const f = await api('GET', '/api/folders');
  assert.equal(f.counts.needsreply, 1); assert.equal(f.counts.needsaction, 1);
  const row = (await api('GET', '/api/messages?view=unified&threads=0')).items;
  assert.equal(row.find((m) => m.id === news).ai.needsReply, false, 'no "reply needed" label on a newsletter');
  assert.equal(row.find((m) => m.id === old).ai.needsAction, false, 'nor on an old guess');
  // What the user marks counts regardless of priority.
  await api('POST', '/api/messages/needs-reply', { ids: [low], value: true });
  assert.deepEqual((await view('needsreply')).sort(), [real, low].sort());
  // The window is a setting.
  await api('PATCH', '/api/settings', { ai: { openItemsDays: 30 } });
  assert.ok((await view('needsaction')).includes(old));
  await api('PATCH', '/api/settings', { ai: { openItemsDays: 14 } });
});

test('a reply in the conversation clears "needs reply" — also from another mail app, and for earlier messages', async () => {
  const q1 = add(inbox, { subject: 'Plan', from: 'ana@x.example', thread: 'plan', msgid: 'plan-1@x', ai: { reply: true }, ageH: 5 });
  const q2 = add(inbox, { subject: 'Re: Plan', from: 'ana@x.example', thread: 'plan', msgid: 'plan-2@x', ai: { reply: true }, ageH: 4 });
  assert.ok((await view('needsreply')).includes(q1));
  // Sent from the phone: arrives by sync in Sent, without any \Answered flag on Ana's mail.
  const r = add(sent, { subject: 'Re: Plan', from: 'me@example.org', to: ['ana@x.example'], thread: 'plan', inReplyTo: 'plan-2@x', ageH: 3 });
  const { afterIngest } = await import('../src/mail/pipeline.js');
  await afterIngest(account, sent, [r]);
  const open = await view('needsreply');
  assert.ok(!open.includes(q1) && !open.includes(q2), 'both earlier questions answered');
  const ins = (await api('GET', `/api/messages/${q2}`)).insight;
  assert.equal(ins.resolution, 'replied'); assert.equal(ins.resolvedBy, r);
  assert.equal(db.prepare('SELECT is_answered FROM messages WHERE id = ?').get(q2).is_answered, 1, 'the message replied to is flagged answered');
  // Wrong? "Still needs a reply" puts it back.
  await api('POST', '/api/messages/needs-reply', { ids: [q1], value: true });
  assert.ok((await view('needsreply')).includes(q1));
});

test('the AI recognises an answer sent as a new email (other subject, more people) and it can be undone', async () => {
  await api('POST', '/api/ai/providers', { type: 'mock', name: 'Mock' });
  const ask = add(inbox, { subject: 'Signed contract', from: 'marko@x.example', thread: 'c1', ai: { reply: true, action: 'Send the signed contract' }, ageH: 30 });
  const other = add(inbox, { subject: 'Lunch on Friday', from: 'marko@x.example', thread: 'c2', ai: { reply: true }, ageH: 29 });
  // A new conversation, another subject, an extra recipient — but it delivers the signed contract.
  const mine = add(sent, { subject: 'Documents for the project', from: 'me@example.org', to: ['marko@x.example', 'eva@x.example'], thread: 'c3',
    body: 'Hi Marko and Eva, attached is the signed contract as promised.', ageH: 2 });
  const { analyzeMessage } = await import('../src/ai/tasks.js');
  await analyzeMessage(uid, mine, { interactive: true });
  const insAsk = (await api('GET', `/api/messages/${ask}`)).insight;
  assert.equal(insAsk.resolution, 'replied'); assert.equal(insAsk.resolvedBy, mine);
  assert.equal((await api('GET', `/api/messages/${other}`)).insight.resolution, null, 'the unrelated request stays open');
  assert.ok(!(await view('needsaction')).includes(ask));
  await api('POST', `/api/messages/${ask}/dismiss`, { dismissed: false });
  assert.ok((await view('needsaction')).includes(ask), 'undone: open again');
});

test('"no reply needed" and "not an action" twice from a sender teach the AI for that sender', async () => {
  const { senderPreference, applyPreference } = await import('../src/ai/learning.js');
  const a = add(inbox, { subject: 'Status 1', from: 'reports@x.example', ai: { reply: true, action: 'Check status' } });
  const b = add(inbox, { subject: 'Status 2', from: 'reports@x.example', ai: { reply: true, action: 'Check status' } });
  await api('POST', '/api/messages/needs-reply', { ids: [a], value: false });
  assert.equal(senderPreference(uid, 'reports@x.example').reply, null, 'one correction may be about one email');
  await api('POST', '/api/messages/needs-reply', { ids: [b], value: false });
  await api('POST', `/api/messages/${a}/dismiss`, { resolution: 'wrong' });
  await api('POST', `/api/messages/${b}/dismiss`, { resolution: 'wrong' });
  const pref = senderPreference(uid, 'reports@x.example');
  assert.deepEqual([pref.reply, pref.action], ['noreply', 'noaction']);
  const d = applyPreference({ needs_reply: true, needs_action: true, action_summary: 'Check status', priority: 50 }, pref);
  assert.deepEqual([d.needs_reply, d.needs_action], [false, false]);
  assert.equal(senderPreference(uid, 'ana@x.example').reply, null, 'other senders unaffected');
});
