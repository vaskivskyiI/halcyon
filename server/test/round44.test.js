// The AI writes with the whole relationship in mind: earlier conversations with the person, what is still open,
// passages of past mail found by meaning, facts and (when time is discussed) the calendar — within the space of the
// account; a draft can be checked against that; the assistant knows the history of people a question names.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r44-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, uid, work, home;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
let seq = 0;
function add(acc, folder, { thread, subject, from, to, body, days = 0 }) {
  seq++;
  return Number(db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, message_id, thread_id, subject, from_name, from_addr, to_json, cc_json, date, body_text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, '[]', ?, ?, ?)`).run(uid, acc.id, folder, `c${seq}@x`, thread, subject, from, JSON.stringify([{ address: to }]), Date.now() - days * 864e5, body, Date.now()).lastInsertRowid);
}

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  await api('POST', '/api/ai/providers', { type: 'mock', name: 'Mock' });
  const acc = (email, space) => {
    const id = db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, space, created_at) VALUES (?, ?, 0, ?, ?)").run(uid, email, space, Date.now()).lastInsertRowid;
    const f = (name, special) => db.prepare('INSERT INTO folders (account_id, path, name, special_use) VALUES (?, ?, ?, ?)').run(id, name, name, special).lastInsertRowid;
    return { id, email, inbox: f('INBOX', '\\Inbox'), sent: f('Sent', '\\Sent') };
  };
  work = acc('me@example.org', 'Work');
  home = acc('me@home.example', 'Private');
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('writing context: history, open items, passages by meaning, facts and calendar — within the space', async () => {
  const { writingContext, historyWith } = await import('../src/ai/context.js');
  const { memoryJob } = await import('../src/ai/tasks.js');
  const ana = 'ana@partner.example';
  // An earlier conversation: Ana asked for the budget, the user promised it by Friday.
  const a1 = add(work, work.inbox, { thread: 'b1', subject: 'Budget 2027', from: ana, to: work.email, body: 'Could you send me the budget for 2027?', days: 40 });
  const a2 = add(work, work.sent, { thread: 'b1', subject: 'Re: Budget 2027', from: work.email, to: ana, body: 'I will send the budget spreadsheet by Friday, with the travel costs split out.', days: 39 });
  db.prepare("INSERT INTO thread_summaries (user_id, thread_id, summary, message_count, updated_at) VALUES (?, 'b1', 'The user promised the 2027 budget spreadsheet by Friday.', 2, ?)").run(uid, Date.now());
  // Still open: Ana's request to sign the contract (another conversation).
  const a3 = add(work, work.inbox, { thread: 'c1', subject: 'Contract', from: ana, to: work.email, body: 'Please sign the contract.', days: 2 });
  db.prepare("INSERT INTO ai_insights (message_id, priority, category, needs_action, action_summary, created_at) VALUES (?, 80, 'work', 1, 'Sign the contract', ?)").run(a3, Date.now());
  // The conversation being answered now.
  const cur = add(work, work.inbox, { thread: 'w1', subject: 'Workshop', from: ana, to: work.email, body: 'Can we meet tomorrow about the workshop and the budget?', days: 0 });
  // The same person in the Private space: not used for a Work reply.
  add(home, home.inbox, { thread: 'p1', subject: 'Birthday party', from: ana, to: home.email, body: 'Party on Saturday!', days: 5 });
  db.prepare("INSERT INTO facts (user_id, owner, text, origin, created_at) VALUES (?, 's:', 'Ana is the finance lead at Partner Ltd', 'user', ?)").run(uid, Date.now());
  for (const id of [a1, a2, a3, cur]) await memoryJob(uid, String(id), { type: 'embed', id: 0 });

  const ctx = await writingContext(uid, { people: [ana], threadId: 'w1', accountId: work.id, query: 'meet tomorrow about the workshop and the budget spreadsheet' });
  assert.match(ctx, /HISTORY WITH THEM/);
  assert.match(ctx, /Budget 2027/);
  assert.match(ctx, /promised the 2027 budget spreadsheet by Friday/);
  assert.match(ctx, /STILL OPEN[\s\S]*Sign the contract/);
  assert.match(ctx, /RELEVANT PASSAGES[\s\S]*travel costs split out/, 'the user\'s own earlier words, found by meaning');
  assert.match(ctx, /finance lead/);
  assert.match(ctx, /Free 30-minute slots/, 'meeting talk brings the calendar');
  assert.doesNotMatch(ctx, /Workshop \(/, 'the conversation being answered is given in full elsewhere');
  assert.doesNotMatch(ctx, /Birthday/, 'mail of another space stays out');
  // Without a space (all spaces) the history covers both.
  assert.match(historyWith(uid, [ana]), /Birthday party/);
  const { scope } = await import('../src/spaces.js');
  assert.doesNotMatch(historyWith(uid, [ana], { sc: scope(uid, 'Work') }), /Birthday/);

  // A reply drafted with an instruction gets that background; a draft is checked against it.
  const d = await api('POST', '/api/ai/draft-reply', { messageId: cur, intent: 'say yes, 10:00' });
  assert.match(d.text, /BACKGROUND/);
  const c = await api('POST', '/api/ai/check-draft', { messageId: cur, text: 'Sure, and could you send me the budget first?' });
  assert.match(c.issues[0].problem, /Budget 2027|Contract/);
  // A new email to her: the same background.
  const r = await api('POST', '/api/ai/check-draft', { to: [ana], accountId: work.id, subject: 'Budget', text: 'Hi Ana, here is the budget you asked for.' });
  assert.ok(r.issues.length >= 1);
  // Nothing to compare with: no remarks.
  const none = await api('POST', '/api/ai/check-draft', { to: ['nobody@else.example'], text: 'Hello there, nice to meet you.' });
  assert.deepEqual(none.issues, []);
  await assert.rejects(api('POST', '/api/ai/check-draft', { messageId: 999999, text: 'x'.repeat(30) }), /404/);
});

test('the assistant knows the whole history with a person the question names', async () => {
  db.prepare("INSERT OR REPLACE INTO contact_profiles (user_id, email, name, profile_json, msg_count) VALUES (?, 'ana@partner.example', 'Ana Novak', ?, 5)").run(uid, JSON.stringify({ who: 'Finance lead' }));
  const { buildContext } = await import('../src/ai/assistant.js');
  const r = await buildContext(uid, 'what did I promise Ana Novak?', null);
  assert.match(r.text, /HISTORY WITH THE PEOPLE ASKED ABOUT[\s\S]*promised the 2027 budget/);
});
