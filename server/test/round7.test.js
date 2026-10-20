// Sidebar counts that match their lists, sorting, time-zone changes, tasks from mail (sender + context, editable due),
// prompt delivery with replied/forwarded flags, and retrying / dismissing failed server changes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startSmtp } from './helpers.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r7-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';
process.env.HALCYON_TLS_INSECURE = '1';

let app, base, cookie = '', db, account, inbox, uid, smtp;

async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
const waitFor = async (fn, ms = 10000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 50)); } };
let seq = 0;
function addMessage({ subject, from = 'ana@company.example', fromName = '', thread, read = 0, size = 1000, ageMin = 5 }) {
  seq++;
  return Number(db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, thread_id, subject, from_name, from_addr, to_json, cc_json,
    date, snippet, body_text, size, is_read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[{"address":"me@example.org"}]', '[]', ?, 'Hi', 'Hi', ?, ?, ?)`)
    .run(uid, account.id, inbox.id, 2000 + seq, `r7-${seq}@company.example`, thread || `r7t${seq}`, subject, fromName, from, Date.now() - ageMin * 60e3, size, read, Date.now()).lastInsertRowid);
}

before(async () => {
  smtp = await startSmtp(0);
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  await api('PATCH', '/api/settings', { calendar: { timezone: 'UTC' }, mail: { undoSendSeconds: 0 }, ai: { enabled: false } });
  account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare(`INSERT INTO accounts (user_id, email, imap_host, imap_port, smtp_host, smtp_port, smtp_secure, smtp_user, sync_enabled, created_at)
    VALUES (?, 'me@example.org', '127.0.0.1', 1, '127.0.0.1', ?, 0, 'me', 0, ?)`).run(uid, smtp.port, Date.now()).lastInsertRowid);
  const { encrypt } = await import('../src/util/crypto.js');
  db.prepare('UPDATE accounts SET smtp_pass_enc = ? WHERE id = ?').run(encrypt('secret'), account.id);
  inbox = db.prepare('SELECT * FROM folders WHERE id = ?').get(db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'INBOX', '\\Inbox')").run(account.id).lastInsertRowid);
  db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'Sent', 'Sent', '\\Sent')").run(account.id);
});

after(async () => { await app?.close(); smtp?.close?.(); setTimeout(() => process.exit(0), 50).unref(); });

test('sidebar counts are unread conversations, the same as the list shows', async () => {
  addMessage({ subject: 'Plan', thread: 'tA' }); addMessage({ subject: 'Re: Plan', thread: 'tA' });
  addMessage({ subject: 'Budget', thread: 'tB' });
  addMessage({ subject: 'Read one', thread: 'tC', read: 1 });
  const f = await api('GET', '/api/folders');
  assert.equal(f.counts.unified, 2, 'two unread conversations');
  assert.equal(f.accounts[0].folders.find((x) => x.id === inbox.id).unread, 2);
  const unreadList = await api('GET', '/api/messages?view=unified&filter=unread');
  assert.equal(unreadList.items.length, f.counts.unified);
});

test('the list sorts by sender, subject and size, and pages without repeats', async () => {
  addMessage({ subject: 'zeta', from: 'zed@x.example', fromName: 'Zed', size: 50 });
  addMessage({ subject: 'alpha', from: 'bob@x.example', fromName: 'Bob', size: 90000 });
  const bySubject = await api('GET', '/api/messages?view=unified&threads=0&sort=subject&dir=asc');
  assert.equal(bySubject.items[0].subject, 'alpha');
  const bySize = await api('GET', '/api/messages?view=unified&threads=0&sort=size');
  assert.equal(bySize.items[0].subject, 'alpha', 'largest first by default');
  const byFrom = await api('GET', '/api/messages?view=unified&threads=0&sort=from&dir=desc');
  assert.equal(byFrom.items[0].from.name, 'Zed');
  const p1 = await api('GET', '/api/messages?view=unified&threads=0&sort=subject&dir=asc&limit=3');
  const p2 = await api('GET', '/api/messages?view=unified&threads=0&sort=subject&dir=asc&limit=3&offset=3');
  assert.ok(p1.hasMore);
  assert.equal(new Set([...p1.items, ...p2.items].map((m) => m.id)).size, p1.items.length + p2.items.length);
});

test('changing the time zone keeps the wall-clock time of events the AI read from mail', async () => {
  const id = addMessage({ subject: 'Meeting Thursday at 8' });
  db.prepare("INSERT INTO ai_insights (message_id, events_json, created_at) VALUES (?, ?, ?)").run(id, JSON.stringify([{ title: 'Meeting', start: '2026-10-22T08:00:00.000Z', end: '2026-10-22T09:00:00.000Z', all_day: false }]), Date.now());
  await api('PATCH', '/api/settings', { calendar: { timezone: 'Europe/Ljubljana' } });
  const ev = JSON.parse(db.prepare('SELECT events_json FROM ai_insights WHERE message_id = ?').get(id).events_json)[0];
  assert.equal(ev.start, '2026-10-22T06:00:00.000Z', '08:00 in Ljubljana (CEST)');
  assert.equal(ev.end, '2026-10-22T07:00:00.000Z');
});

test('tasks from an email name the sender, carry the context, and take an edited due date', async () => {
  const id = addMessage({ subject: 'Contract', from: 'ana@company.example', fromName: 'Ana Novak' });
  db.prepare("INSERT INTO ai_insights (message_id, summary, action_items_json, created_at) VALUES (?, 'Ana needs the signed contract.', ?, ?)")
    .run(id, JSON.stringify([{ text: 'Send the signed contract', due: '2026-10-23' }]), Date.now());
  const p = await api('GET', `/api/tasks/from-message/${id}`);
  assert.equal(p.items[0].title, 'Send the signed contract (Ana Novak)');
  assert.match(p.items[0].notes, /From: Ana Novak <ana@company\.example>/);
  assert.match(p.items[0].notes, /Subject: Contract/);
  assert.match(p.items[0].notes, /signed contract/);
  assert.equal(new Date(p.items[0].due).toISOString(), '2026-10-23T15:00:00.000Z', 'due date read in the user\'s zone (17:00 Ljubljana)');
  const due = Date.parse('2026-11-02T08:00:00Z');
  const [t] = await api('POST', `/api/tasks/from-message/${id}`, { items: [{ ...p.items[0], due, notes: 'My note' }] });
  assert.equal(t.due, due); assert.equal(t.notes, 'My note'); assert.equal(t.sourceMessageId, id);
  const moved = await api('PATCH', `/api/tasks/${t.id}`, { due: null });
  assert.equal(moved.due, null);
  // Without AI action items: a follow-up with the sender.
  const id2 = addMessage({ subject: 'Lunch?', from: 'marko@x.example', fromName: 'Marko' });
  assert.equal((await api('GET', `/api/tasks/from-message/${id2}`)).items[0].title, 'Follow up: Lunch? (Marko)');
});

test('sending goes out promptly and marks the original as replied / forwarded', async () => {
  const orig = addMessage({ subject: 'Question', from: 'ana@company.example' });
  await api('POST', '/api/send', { accountId: account.id, to: ['ana@company.example'], subject: 'Re: Question', html: '<p>Yes</p>', inReplyToId: orig });
  // No scheduler runs in this test server: delivery is started by the send itself.
  await waitFor(() => db.prepare('SELECT is_answered FROM messages WHERE id = ?').get(orig).is_answered === 1);
  await api('POST', '/api/send', { accountId: account.id, to: ['bob@x.example'], subject: 'Fwd: Question', html: '<p>FYI</p>', forwardOfId: orig });
  await waitFor(() => db.prepare('SELECT is_forwarded FROM messages WHERE id = ?').get(orig).is_forwarded === 1);
  const item = (await api('GET', '/api/messages?view=unified&threads=0')).items.find((m) => m.id === orig);
  assert.equal(item.isAnswered, true); assert.equal(item.isForwarded, true);
  const op = db.prepare("SELECT payload_json FROM pending_ops WHERE op = 'flags' ORDER BY id DESC").get();
  assert.ok(JSON.parse(op.payload_json).add.includes('$Forwarded'));
});

test('a failed server change can be retried or dismissed', async () => {
  const id = Number(db.prepare("INSERT INTO pending_ops (account_id, op, payload_json, attempts, error, created_at) VALUES (?, 'append', '{}', 5, 'NO [TRYCREATE] Mailbox does not exist (Sent)', ?)").run(account.id, Date.now()).lastInsertRowid);
  const st = (await api('GET', '/api/accounts/status'))[0];
  assert.ok(st.failedOps.some((o) => o.id === id && /TRYCREATE/.test(o.error)));
  await api('POST', `/api/accounts/${account.id}/ops/${id}/retry`, {});
  assert.equal(db.prepare('SELECT attempts FROM pending_ops WHERE id = ?').get(id).attempts, 0);
  db.prepare('UPDATE pending_ops SET attempts = 5 WHERE id = ?').run(id);
  await api('DELETE', `/api/accounts/${account.id}/ops/${id}`);
  assert.equal(db.prepare('SELECT id FROM pending_ops WHERE id = ?').get(id), undefined);
});

test('saving a sent copy to a folder the server does not have creates it and retries once', async () => {
  const { AccountSync } = await import('../src/mail/sync.js');
  const w = new AccountSync(account.id);
  const calls = [];
  let created = false;
  w.syncFolderList = async () => calls.push('list');
  w.client = {
    async append(folder) {
      calls.push(`append ${folder}`);
      if (!created) { const e = new Error('Command failed'); e.responseText = 'Mailbox does not exist'; e.response = { attributes: [{ section: [{ value: 'TRYCREATE' }] }] }; throw e; }
    },
    async mailboxCreate(p) { calls.push(`create ${p}`); created = true; },
  };
  await w.applyOp('append', { folder: 'Sent', raw: Buffer.from('x').toString('base64') });
  assert.deepEqual(calls, ['append Sent', 'create Sent', 'append Sent', 'list']);
  // Other failures are not retried and keep the server's reason.
  w.client.append = async () => { const e = new Error('Command failed'); e.responseText = 'Quota exceeded'; throw e; };
  await assert.rejects(() => w.applyOp('append', { folder: 'Sent', raw: '' }), (e) => e.responseText === 'Quota exceeded');
});
