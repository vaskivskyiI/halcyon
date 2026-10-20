// Sent replies visible in their thread at once, "action needed" (no reply), topic/category search, and an
// assistant that knows the current date (past events / old mail are not presented as current).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startSmtp } from './helpers.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r6-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';
process.env.HALCYON_DEMO = '1';
process.env.HALCYON_TLS_INSECURE = '1';

let app, base, cookie = '', db, afterIngest, account, inbox, sent, uid, smtp;

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
function addMessage(folder, { subject, from = 'ana@company.example', body = 'Hello', ageMin = 5, messageId }) {
  seq++;
  const id = Number(db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, thread_id, subject, from_name, from_addr, to_json, cc_json,
    date, snippet, body_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, '[{"address":"me@example.org"}]', '[]', ?, ?, ?, ?)`)
    .run(uid, account.id, folder.id, 1000 + seq, messageId || `r6-${seq}@company.example`, `r6t${seq}`, subject, from, Date.now() - ageMin * 60e3, body.slice(0, 100), body, Date.now()).lastInsertRowid);
  db.prepare('INSERT INTO messages_fts (rowid, subject, sender, recipients, body) VALUES (?, ?, ?, ?, ?)').run(id, subject, from, '', body);
  return id;
}
const insight = (id) => db.prepare('SELECT * FROM ai_insights WHERE message_id = ?').get(id);
async function ingest(fields) { const id = addMessage(inbox, fields); await afterIngest(account, inbox, [id]); await waitFor(() => insight(id)); return id; }

before(async () => {
  smtp = await startSmtp(0);
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  ({ afterIngest } = await import('../src/mail/pipeline.js'));
  (await import('../src/ai/queue.js')).startQueue();
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  await api('PATCH', '/api/settings', { calendar: { timezone: 'Europe/Ljubljana' }, mail: { undoSendSeconds: 0 } });
  await api('POST', '/api/ai/providers', { type: 'mock', name: 'Mock' });
  account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare(`INSERT INTO accounts (user_id, email, imap_host, imap_port, smtp_host, smtp_port, smtp_secure, smtp_user, sync_enabled, created_at)
    VALUES (?, 'me@example.org', '127.0.0.1', 1, '127.0.0.1', ?, 0, 'me', 0, ?)`).run(uid, smtp.port, Date.now()).lastInsertRowid);
  const { encrypt } = await import('../src/util/crypto.js');
  db.prepare('UPDATE accounts SET smtp_pass_enc = ? WHERE id = ?').run(encrypt('secret'), account.id);
  account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(account.id);
  const folder = (name, special) => db.prepare('SELECT * FROM folders WHERE id = ?').get(db.prepare('INSERT INTO folders (account_id, path, name, special_use) VALUES (?, ?, ?, ?)').run(account.id, name, name, special).lastInsertRowid);
  inbox = folder('INBOX', '\\Inbox'); sent = folder('Poslano', null); // a server without SPECIAL-USE, localised name
});

after(async () => {
  const { syncManager } = await import('../src/mail/sync.js');
  await syncManager.stopAll();
  await app.close();
  smtp.server.close();
  setTimeout(() => process.exit(0), 100).unref();
});

test('a sent reply appears in its conversation right away; the later server copy is not a duplicate', async () => {
  const orig = addMessage(inbox, { subject: 'Plan', body: 'Can we meet?', messageId: 'plan-1@company.example' });
  await api('POST', '/api/send', { accountId: account.id, to: [{ address: 'ana@company.example' }], subject: 'Re: Plan', html: '<p>Yes, Tuesday.</p>', inReplyToId: orig });
  const { processOutbox } = await import('../src/mail/send.js');
  await processOutbox();
  assert.deepEqual(db.prepare('SELECT status, error FROM outbox').all().map((o) => `${o.status} ${o.error || ''}`.trim()), ['sent']);
  assert.equal(smtp.delivered.length, 1);
  const copy = db.prepare('SELECT * FROM messages WHERE folder_id = ?').get(sent.id);
  assert.ok(copy, 'stored in the Sent folder found by name ("Poslano")');
  const thread = await api('GET', `/api/threads/${db.prepare('SELECT thread_id FROM messages WHERE id = ?').get(orig).thread_id}`);
  assert.deepEqual(thread.messages.map((m) => m.subject), ['Plan', 'Re: Plan']);
  assert.ok(db.prepare("SELECT 1 AS x FROM pending_ops WHERE op = 'append'").get(), 'also appended to the server');
  // The server copy arrives with a UID: it is matched by Message-ID.
  const { ingestMessage } = await import('../src/mail/store.js');
  const r = await ingestMessage({ account, folder: sent, uid: 77, flags: ['\\Seen'], raw: smtp.delivered[0].raw });
  assert.equal(r.isNew, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE folder_id = ?').get(sent.id).n, 1);
  assert.equal(db.prepare('SELECT uid FROM messages WHERE id = ?').get(copy.id).uid, 77);
});

test('"action needed" without a reply: flagged, listed, searchable, done when dismissed', async () => {
  const id = await ingest({ subject: 'Invoice 2026-0412', body: 'Please pay the attached invoice by 30 October. No need to reply.' });
  assert.equal(insight(id).needs_action, 1);
  assert.match(insight(id).action_summary, /pay/i);
  const view = await api('GET', '/api/messages?view=needsaction&threads=0');
  assert.ok(view.items.some((m) => m.id === id && m.ai.needsAction && m.ai.actionSummary));
  assert.ok((await api('GET', '/api/folders')).counts.needsaction >= 1);
  const found = await api('GET', `/api/messages?q=${encodeURIComponent('is:action')}&semantic=0`);
  assert.ok(found.items.some((m) => m.id === id));
  const brief = await api('GET', '/api/ai/brief');
  assert.ok(brief.live.actions.some((m) => m.id === id) || brief.live.attention.some((m) => m.id === id));
  await api('POST', `/api/messages/${id}/dismiss`, {});
  assert.ok(!(await api('GET', '/api/messages?view=needsaction&threads=0')).items.some((m) => m.id === id));
});

test('search by topic and category operators', async () => {
  const a = await ingest({ subject: 'Order 4471 confirmed', from: 'shop@store.example', body: 'Thanks.' });
  const t = await api('GET', `/api/messages?q=${encodeURIComponent('topic:"order 4471"')}&semantic=0`);
  assert.deepEqual(t.items.map((m) => m.id), [a]);
  const c = await api('GET', `/api/messages?q=${encodeURIComponent('category:work topic:"order 4471"')}&semantic=0`);
  assert.deepEqual(c.items.map((m) => m.id), [a]);
  const none = await api('GET', `/api/messages?q=${encodeURIComponent('-topic:"order 4471" Order')}&semantic=0`);
  assert.ok(!none.items.some((m) => m.id === a));
});

test('the assistant knows "now": old mail and past events are not presented as current', async () => {
  const { buildContext } = await import('../src/ai/assistant.js');
  const { userContext } = await import('../src/ai/prompts.js');
  const { createEvent } = await import('../src/calendar/repo.js');
  const s = (await import('../src/settings.js')).getSettings(uid);
  assert.match(userContext({ name: 'Me' }, s, []), /Now: \w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(Europe\/Ljubljana\)/);

  // Two months old: not auto-analysed (outside the analysis window) but indexed for search and the assistant.
  const old = addMessage(inbox, { subject: 'Urgent reply needed: project review', body: 'URGENT, please reply about the project review?', ageMin: 60 * 1440 });
  await afterIngest(account, inbox, [old]);
  const recent = await ingest({ subject: 'Urgent: project review slides', body: 'URGENT — can you send the project review slides?', ageMin: 30 });
  createEvent(uid, { title: 'Project review meeting', start: Date.now() - 7 * 864e5, end: Date.now() - 7 * 864e5 + 3600e3 });
  await waitFor(() => db.prepare("SELECT COUNT(*) AS n FROM ai_jobs WHERE status = 'running' OR (status = 'queued' AND run_after <= ?)").get(Date.now()).n === 0);

  const ctx = await buildContext(uid, 'What do I need to do today about the project review?', null);
  assert.match(ctx.text, /OPEN ITEMS RIGHT NOW/);
  assert.ok(ctx.text.includes(`[#${recent}]`));
  assert.ok(!ctx.text.includes(`[#${old}] `), 'two-month-old mail is not treated as current');
  assert.doesNotMatch(ctx.text, /\[PAST[^\]]*\] Calendar event: Project review meeting/, 'past events are left out for "what to do" questions');

  const hist = await buildContext(uid, 'When was the project review meeting last week?', null);
  assert.match(hist.text, /\[PAST, 7 days ago\] Calendar event: Project review meeting/);
  assert.match(hist.text, /\(\d+ days? ago\)|\(earlier today\)/, 'emails carry how long ago they were sent');
});
