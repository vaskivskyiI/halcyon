// Sending twice by accident sends once; drafts from the Drafts folder are edited in place (and replaced, not
// duplicated); the analysis sees the conversation with who wrote to whom, so it does not mix up who asked whom.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r23-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, uid, account, inbox, sent, drafts, n = 0;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
const add = (folder, o) => Number(db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, in_reply_to, thread_id, subject, from_name, from_addr, to_json, cc_json, date, body_text, is_draft, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, '[]', ?, ?, ?, ?)`).run(uid, account.id, folder.id, ++n, o.msgid || `r23-${n}@x`, o.inReplyTo || null, o.thread || `t${n}`, o.subject, o.from,
  JSON.stringify((o.to || ['me@example.org']).map((a) => ({ name: '', address: a }))), Date.now() - (o.ageH || 1) * 3600e3, o.body || 'Hello', o.draft ? 1 : 0, Date.now()).lastInsertRowid);

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  await api('PATCH', '/api/settings', { ai: { autoAnalyze: false }, mail: { undoSendSeconds: 600 } });
  account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare("INSERT INTO accounts (user_id, email, aliases_json, sync_enabled, created_at) VALUES (?, 'me@example.org', '[\"igor@alias.example\"]', 0, ?)").run(uid, Date.now()).lastInsertRowid);
  const folder = (p, s) => db.prepare('SELECT * FROM folders WHERE id = ?').get(db.prepare('INSERT INTO folders (account_id, path, name, special_use) VALUES (?, ?, ?, ?)').run(account.id, p, p, s).lastInsertRowid);
  inbox = folder('INBOX', '\\Inbox'); sent = folder('Sent', '\\Sent'); drafts = folder('Drafts', '\\Drafts');
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('a second click on Send (same compose window, or the very same message) does not send it twice', async () => {
  const msg = { accountId: account.id, to: [{ address: 'ana@x.example' }], subject: 'Twice?', html: '<p>Once</p>' };
  const a = await api('POST', '/api/send', { ...msg, sendKey: 'k1' });
  const b = await api('POST', '/api/send', { ...msg, sendKey: 'k1', html: '<p>Once (edited)</p>' });
  assert.equal(b.id, a.id);
  const c = await api('POST', '/api/send', { ...msg, subject: 'No key' });
  const d = await api('POST', '/api/send', { ...msg, subject: 'No key' });
  assert.equal(d.id, c.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status = 'queued'").get().n, 2);
  // A new message (other key) is sent, of course.
  const e = await api('POST', '/api/send', { ...msg, sendKey: 'k2' });
  assert.notEqual(e.id, a.id);
  // Undone, then sent again from the same window: sent again.
  await api('POST', `/api/outbox/${a.id}/cancel`);
  const f = await api('POST', '/api/send', { ...msg, sendKey: 'k1' });
  assert.notEqual(f.id, a.id);
});

test('a draft in the Drafts folder (e.g. from the phone) is edited in place: it becomes this draft and replaces its server copy', async () => {
  const q = add(inbox, { subject: 'Budget', from: 'ana@x.example', thread: 'b', msgid: 'budget-1@x' });
  const dm = add(drafts, { subject: 'Re: Budget', from: 'me@example.org', to: ['ana@x.example'], thread: 'b', msgid: 'phone-draft@x', inReplyTo: 'budget-1@x', draft: true, body: 'Draft from my phone' });
  const t = await api('GET', '/api/threads/b');
  assert.ok(t.messages.find((m) => m.id === dm).isDraft);
  const c = await api('GET', `/api/messages/${dm}/draft`);
  assert.equal(c.inReplyToId, q); assert.equal(c.serverMessageId, dm); assert.match(c.html, /Draft from my phone/);
  assert.equal((await api('GET', `/api/messages/${q}/draft`).catch((e) => e.message)).includes('404'), true, 'only drafts');
  // First edit: adopted (once — a second save of the same content updates the same draft).
  const s1 = await api('POST', '/api/drafts', { ...c, html: '<p>Edited here</p>', serverMessageId: dm });
  const s2 = await api('POST', '/api/drafts', { ...c, html: '<p>Edited again</p>', serverMessageId: dm });
  assert.equal(s2.id, s1.id);
  const row = db.prepare('SELECT * FROM drafts WHERE id = ?').get(s1.id);
  assert.equal(row.server_msgid, '<phone-draft@x>'); assert.equal(row.in_reply_to, q);
  // The conversation lists it in full, linked to its server copy (so it is shown once, as an editor).
  const rel = (await api('GET', '/api/threads/b')).related.drafts;
  assert.equal(rel.length, 1); assert.equal(rel[0].serverMsgid, '<phone-draft@x>'); assert.match(rel[0].html, /Edited again/);
  // Sent: the server copy — and only it — is removed from Drafts.
  await api('POST', '/api/send', { ...c, html: '<p>Final</p>', draftId: s1.id, sendKey: 'k-draft' });
  const ops = db.prepare("SELECT payload_json FROM pending_ops WHERE op = 'deleteByMessageId'").all().map((o) => JSON.parse(o.payload_json));
  assert.deepEqual(ops.map((o) => [o.folder, o.messageId]), [['Drafts', '<phone-draft@x>']]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE id = ?').get(dm).n, 0);
});

test('a conversation is unread while any copy of a message is (Inbox + All Mail / Archive), and reading marks every copy', async () => {
  const archive = db.prepare('SELECT * FROM folders WHERE id = ?').get(db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'Archive', 'Archive', '\\Archive')").run(account.id).lastInsertRowid);
  const a = add(archive, { subject: 'Copies', from: 'ana@x.example', thread: 'cp', msgid: 'copy@x', ageH: 3 });
  const b = add(inbox, { subject: 'Copies', from: 'ana@x.example', thread: 'cp', msgid: 'copy@x', ageH: 3 });
  db.prepare('UPDATE messages SET is_read = 1 WHERE id = ?').run(a);
  const t = await api('GET', '/api/threads/cp');
  assert.equal(t.messages.length, 1); assert.equal(t.messages[0].isRead, false);
  await api('POST', '/api/messages/actions', { ids: [t.messages[0].id], action: 'read' });
  assert.deepEqual(db.prepare('SELECT is_read FROM messages WHERE id IN (?, ?)').all(a, b).map((r) => r.is_read), [1, 1]);
});

test('the analysis sees the earlier conversation, labelled with who wrote to whom (also from an alias)', async () => {
  const { conversationContext } = await import('../src/ai/tasks.js');
  const { ownAddresses } = await import('../src/ai/open-items.js');
  const P = await import('../src/ai/prompts.js');
  const own = ownAddresses(uid);
  assert.ok(own.has('igor@alias.example'));
  add(sent, { subject: 'Slides', from: 'igor@alias.example', to: ['marko@x.example'], thread: 's', msgid: 's1@x', body: 'Marko, can you send me the slides by Friday?', ageH: 5 });
  const answer = add(inbox, { subject: 'Re: Slides', from: 'marko@x.example', thread: 's', msgid: 's2@x', inReplyTo: 's1@x', body: 'Yes, I will send them on Thursday.', ageH: 2 });
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(answer);
  const ctx = conversationContext(uid, m, own, 'Europe/Ljubljana');
  assert.match(ctx, /THE USER → marko@x\.example\nMarko, can you send me the slides/);
  const prompt = P.analyzePrompt({ ctx: '', message: P.messageForPrompt(m, 6000, 'Europe/Ljubljana', own), senderInfo: '', language: 'English', timezone: 'Europe/Ljubljana', conversation: ctx });
  const user = prompt.messages[0].content;
  assert.ok(user.indexOf('EARLIER IN THIS CONVERSATION') < user.indexOf('THE EMAIL TO ANALYSE'));
  assert.match(user, /Written: marko@x\.example → THE USER/);
  assert.match(prompt.system, /WHO ASKED WHOM/);
  // Only the reply is stored here: the history quoted inside it is used instead.
  const lone = add(inbox, { subject: 'Re: Visit', from: 'eva@x.example', thread: 'v', body: 'Sure, 10:00 is fine.\n\nOn Mon, 20 Oct 2026 at 09:00, Me <me@example.org> wrote:\n> Could we meet on Tuesday at 10:00?' });
  assert.match(conversationContext(uid, db.prepare('SELECT * FROM messages WHERE id = ?').get(lone), own, 'UTC'), /quoted inside THE EMAIL[\s\S]*Could we meet on Tuesday/);
  // Mail sent from an alias counts as the user's own (no "needs reply" on it).
  const { analyzeMessage } = await import('../src/ai/tasks.js');
  await api('POST', '/api/ai/providers', { type: 'mock', name: 'Mock' });
  const mine = db.prepare('SELECT id FROM messages WHERE message_id = ?').get('s1@x').id;
  await analyzeMessage(uid, mine, { interactive: true });
  assert.equal(db.prepare('SELECT needs_reply FROM ai_insights WHERE message_id = ?').get(mine).needs_reply, 0);
});
