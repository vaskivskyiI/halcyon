// Drafts (saved locally and as a single copy in the IMAP Drafts folder), "needs reply" set by the user, quiet analysis
// of old mail, writing-style examples from sent mail, tasks with due dates in plain language. No IMAP server needed:
// IMAP operations stay queued in pending_ops and are inspected there.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r5-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';
process.env.HALCYON_DEMO = '1';

let app, base, cookie = '', db, afterIngest, account, inbox, sent, uid;

async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
const waitFor = async (fn, ms = 15000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 50)); } };
let seq = 0;
function addMessage(folder, { subject, from = 'ana@company.example', to = 'me@example.org', body = 'Hello', ageMin = 5 }) {
  seq++;
  const id = Number(db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, message_id, thread_id, subject, from_name, from_addr, to_json, cc_json,
    date, snippet, body_text, created_at) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, '[]', ?, ?, ?, ?)`)
    .run(uid, account.id, folder.id, `r5-${seq}@example.org`, `r5t${seq}`, subject, from, JSON.stringify([{ name: '', address: to }]), Date.now() - ageMin * 60e3, body.slice(0, 100), body, Date.now()).lastInsertRowid);
  db.prepare('INSERT INTO messages_fts (rowid, subject, sender, recipients, body) VALUES (?, ?, ?, ?, ?)').run(id, subject, from, to, body);
  return id;
}
const insight = (id) => db.prepare('SELECT * FROM ai_insights WHERE message_id = ?').get(id);
const ops = (op) => db.prepare('SELECT * FROM pending_ops WHERE op = ? ORDER BY id').all(op).map((o) => ({ ...o, p: JSON.parse(o.payload_json) }));

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  ({ afterIngest } = await import('../src/mail/pipeline.js'));
  (await import('../src/ai/queue.js')).startQueue();
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  await api('PATCH', '/api/settings', { calendar: { timezone: 'Europe/Ljubljana' } });
  await api('POST', '/api/ai/providers', { type: 'mock', name: 'Mock' });
  account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare("INSERT INTO accounts (user_id, email, imap_host, imap_port, smtp_host, sync_enabled, created_at) VALUES (?, 'me@example.org', '127.0.0.1', 1, '127.0.0.1', 0, ?)").run(uid, Date.now()).lastInsertRowid);
  const folder = (name, special) => db.prepare('SELECT * FROM folders WHERE id = ?').get(db.prepare('INSERT INTO folders (account_id, path, name, special_use) VALUES (?, ?, ?, ?)').run(account.id, name, name, special).lastInsertRowid);
  inbox = folder('INBOX', '\\Inbox'); sent = folder('Sent', '\\Sent'); folder('Drafts', '\\Drafts');
});

after(async () => {
  const { syncManager } = await import('../src/mail/sync.js');
  await syncManager.stopAll();
  await app.close();
  setTimeout(() => process.exit(0), 100).unref();
});

test('due dates in plain language (English and Slovenian, time zone and DST aware)', async () => {
  const { parseDue } = await import('../src/util/dates.js');
  const now = Date.parse('2026-10-20T08:00:00Z'); // Tuesday 10:00 in Ljubljana
  const p = (t) => { const r = parseDue(t, 'Europe/Ljubljana', now); return [r.title, r.due && new Date(r.due).toISOString()]; };
  assert.deepEqual(p('Call Ana tomorrow at 10'), ['Call Ana', '2026-10-21T08:00:00.000Z']);
  assert.deepEqual(p('Pošlji poročilo v torek ob 9'), ['Pošlji poročilo', '2026-10-27T08:00:00.000Z'], 'today is Tuesday → next week; CET after the DST change');
  assert.deepEqual(p('report by Friday'), ['report', '2026-10-23T07:00:00.000Z']);
  assert.deepEqual(p('Pay invoice 21.10.'), ['Pay invoice', '2026-10-21T07:00:00.000Z'], 'a date, not the time 21:10');
  assert.deepEqual(p('Dentist Oct 30 15:30'), ['Dentist', '2026-10-30T14:30:00.000Z']);
  assert.deepEqual(p('renew passport in 3 days'), ['renew passport', '2026-10-23T07:00:00.000Z']);
  assert.deepEqual(p('meeting at 3pm'), ['meeting', '2026-10-20T13:00:00.000Z']);
  assert.deepEqual(p('jutri zjutraj kliči banko'), ['kliči banko', '2026-10-21T07:00:00.000Z']);
  assert.deepEqual(p('oddaj poročilo konec tedna'), ['oddaj poročilo', '2026-10-23T15:00:00.000Z']);
  assert.deepEqual(p('Buy milk'), ['Buy milk', null]);
  assert.deepEqual(p('Order 4471 follow-up'), ['Order 4471 follow-up', null], 'numbers are not dates');

  const t = await api('POST', '/api/tasks', { text: 'Send the slides to Marko tomorrow at 14:00' });
  assert.equal(t.title, 'Send the slides to Marko');
  assert.ok(t.due > Date.now());
  const preview = await api('POST', '/api/tasks/parse', { text: 'Book flights next week' });
  assert.equal(preview.title, 'Book flights');
  assert.ok(preview.due);
});

test('drafts: saved, shown with the message they answer, one copy on the server, removed when deleted', async () => {
  const msg = addMessage(inbox, { subject: 'Question', body: 'Can you check the numbers?' });
  const payload = { accountId: account.id, to: [{ address: 'ana@company.example' }], subject: 'Re: Question', html: '<p>Draft text</p><div data-quote="1">old</div>', inReplyToId: msg };
  const { id } = await api('POST', '/api/drafts', payload);
  const m = await api('GET', `/api/messages/${msg}`);
  assert.equal(m.related.drafts[0].id, id);
  assert.match(m.related.drafts[0].snippet, /Draft text/);
  assert.doesNotMatch(m.related.drafts[0].snippet, /old/, 'snippet is the user\'s text, not the quote');
  const list = await api('GET', '/api/messages?view=unified&threads=0');
  assert.equal(list.items.find((x) => x.id === msg).hasDraft, true);

  await api('POST', `/api/drafts/${id}/save-to-server`, {});
  const first = db.prepare('SELECT server_msgid FROM drafts WHERE id = ?').get(id).server_msgid;
  assert.ok(first && ops('append').length === 1);
  await api('POST', '/api/drafts', { ...payload, id, html: '<p>Draft text v2</p>' });
  await api('POST', `/api/drafts/${id}/save-to-server`, {});
  const replaced = ops('deleteByMessageId');
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].p.messageId, first, 'only the previous copy of this draft is replaced');
  assert.equal(replaced[0].p.folder, 'Drafts');

  await api('DELETE', `/api/drafts/${id}`);
  assert.equal(ops('deleteByMessageId').length, 2);
  assert.equal((await api('GET', `/api/messages/${msg}`)).related.drafts.length, 0);
});

test('"needs reply" set by the user, for several messages, survives re-analysis', async () => {
  const a = addMessage(inbox, { subject: 'FYI', body: 'Just so you know?' });
  const b = addMessage(inbox, { subject: 'Note', body: 'No action.' });
  await afterIngest(account, inbox, [a, b]);
  await waitFor(() => insight(a) && insight(b));
  assert.equal(insight(a).needs_reply, 1, 'mock says a question needs a reply');
  await api('POST', '/api/messages/needs-reply', { ids: [a], value: false });
  await api('POST', '/api/messages/needs-reply', { ids: [b], value: true });
  assert.equal(insight(a).needs_reply, 0);
  assert.equal(insight(b).needs_reply, 1);
  await api('POST', '/api/ai/reprocess', { what: 'analyze', days: 1, mode: 'all' });
  await waitFor(() => db.prepare("SELECT COUNT(*) AS n FROM ai_jobs WHERE type = 'analyze' AND status IN ('queued','running')").get().n === 0);
  assert.equal(insight(a).needs_reply, 0, 'user decision kept after re-analysis');
  assert.equal(insight(b).needs_reply, 1);
  const c = addMessage(inbox, { subject: 'No analysis yet', body: 'x' });
  await api('POST', '/api/messages/needs-reply', { ids: [c], value: true });
  assert.equal(insight(c).needs_reply, 1);
});

test('old mail can be analysed quietly: no "needs reply", not in the brief or priority views', async () => {
  const old = addMessage(inbox, { subject: 'Old question', body: 'URGENT: can you answer?', ageMin: 200 * 1440 });
  await api('POST', '/api/ai/reprocess', { what: 'analyze', days: 'all', mode: 'missing', quiet: true });
  await waitFor(() => insight(old));
  assert.equal(insight(old).needs_reply, 0);
  assert.ok(insight(old).dismissed_at, 'treated as already handled');
  assert.ok(insight(old).summary, 'still analysed for memory and search');
});

test('drafting uses the user\'s own earlier emails to the same person as style examples', async () => {
  addMessage(sent, { subject: 'Re: Budget', from: 'me@example.org', to: 'boss@corp.example', body: 'Dear Mr. Kovač,\n\nplease find the budget attached.\n\nKind regards,\nIgor' });
  addMessage(sent, { subject: 'Re: lunch', from: 'me@example.org', to: 'friend@gmail.com', body: 'hey! sure, see ya at noon :)' });
  const { styleExamples } = await import('../src/ai/tasks.js');
  const ex = styleExamples(uid, ['boss@corp.example']);
  assert.match(ex, /Dear Mr\. Kovač/);
  assert.doesNotMatch(ex, /see ya/);
  assert.match(styleExamples(uid, ['cfo@corp.example']), /Kind regards/, 'same organisation when there is no mail to this person');
  assert.equal(styleExamples(uid, ['stranger@gmail.com']), '', 'never "same organisation" for public mail providers');
});
