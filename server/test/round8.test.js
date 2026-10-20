// Conversation grouping across languages, new mail with a stale UIDNEXT, history that cannot stall, append to the
// server's own Sent folder, analyses that survive re-download, stated time zones, invitations, fast lists, tab counts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r8-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, account, inbox, uid, ingestMessage, AccountSync;

async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
let n = 0;
const raw = ({ subject, from = 'ana@company.example', to = 'me@example.org', id, inReplyTo, date = new Date(), extra = '' }) => Buffer.from(
  `Message-ID: <${id || `r8-${++n}@x`}>\r\nFrom: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: ${date.toUTCString()}\r\n${inReplyTo ? `In-Reply-To: <${inReplyTo}>\r\n` : ''}${extra}\r\nHello\r\n`);
const ingest = async (o, folder = inbox) => (await ingestMessage({ account, folder, uid: 5000 + ++n, flags: [], raw: raw(o) })).id;
const threadOf = (id) => db.prepare('SELECT thread_id FROM messages WHERE id = ?').get(id).thread_id;

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  ({ ingestMessage } = await import('../src/mail/store.js'));
  ({ AccountSync } = await import('../src/mail/sync.js'));
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  await api('PATCH', '/api/settings', { calendar: { timezone: 'Europe/Ljubljana' }, ai: { enabled: false } });
  account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, 'me@example.org', 0, ?)").run(uid, Date.now()).lastInsertRowid);
  inbox = db.prepare('SELECT * FROM folders WHERE id = ?').get(db.prepare("INSERT INTO folders (account_id, path, name, special_use, last_uid) VALUES (?, 'INBOX', 'INBOX', '\\Inbox', 100)").run(account.id).lastInsertRowid);
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('subject keys drop reply/forward prefixes in many languages but keep list tags', async () => {
  const { subjectKey, isReplySubject } = await import('../src/util/subject.js');
  for (const s of ['Re: Budget 2027', 'AW: Budget 2027', 'Odg.: Budget 2027', 'SV: RE: Fwd: Budget 2027', 'RE[2]: Budget 2027', 'Posl.: Budget 2027', '回复：Budget 2027', 'Budget 2027']) {
    assert.equal(subjectKey(s), 'budget 2027', s);
  }
  assert.equal(subjectKey('[list] Re: Topic'), '[list] topic');
  assert.equal(subjectKey('Re: [list] Topic'), '[list] topic');
  assert.notEqual(subjectKey('[PROJ-1] Status'), subjectKey('[PROJ-2] Status'));
  assert.equal(isReplySubject('Odg: x'), true); assert.equal(isReplySubject('Report: weekly'), false);
});

test('replies without reply headers join their conversation by subject and participants', async () => {
  const day = 864e5;
  const orig = await ingest({ subject: 'Budget 2027', from: 'ana@company.example', date: new Date(Date.now() - 3 * day) });
  const aw = await ingest({ subject: 'AW: Budget 2027', from: 'hans@company.example', to: 'me@example.org, ana@company.example', date: new Date(Date.now() - 2 * day) });
  const odg = await ingest({ subject: 'Odg: Budget 2027', from: 'ana@company.example', date: new Date(Date.now() - day) });
  assert.equal(threadOf(aw), threadOf(orig));
  assert.equal(threadOf(odg), threadOf(orig));
  // Same subject, nobody in common: a different conversation.
  const other = await ingest({ subject: 'Re: Budget 2027', from: 'someone@else.example' });
  assert.notEqual(threadOf(other), threadOf(orig));
  // Two separate originals with the same title stay apart.
  const r1 = await ingest({ subject: 'Weekly report', from: 'bot@company.example', date: new Date(Date.now() - 8 * day) });
  const r2 = await ingest({ subject: 'Weekly report', from: 'bot@company.example', date: new Date(Date.now() - day) });
  assert.notEqual(threadOf(r1), threadOf(r2));
});

test('the one-time pass regroups mail stored before subject grouping', async () => {
  const { regroupConversations } = await import('../src/mail/store.js');
  const a = await ingest({ subject: 'Offsite plan', from: 'ana@company.example', date: new Date(Date.now() - 864e5) });
  const b = await ingest({ subject: 'Sv: Offsite plan', from: 'ana@company.example' });
  // Simulate old data: separate threads, no subject key.
  db.prepare("UPDATE messages SET thread_id = 'old-' || id, subject_key = NULL WHERE id IN (?, ?)").run(a, b);
  db.prepare("DELETE FROM app_state WHERE key = 'regroup:v1'").run();
  await regroupConversations();
  assert.equal(threadOf(a), threadOf(b));
  assert.ok(db.prepare("SELECT value FROM app_state WHERE key = 'regroup:v1'").get());
});

test('new mail is found even when the selected Inbox reports a stale UIDNEXT', async () => {
  const w = new AccountSync(account.id);
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(inbox.id);
  const msgs = [101, 102];
  w.client = {
    usable: true, enabled: new Set(),
    mailbox: { exists: 2, uidNext: 101, uidValidity: 1 }, // value from SELECT, before the new mail arrived
    async getMailboxLock() { return { release() {} }; },
    async search(c) { if (c.uid) return msgs; if (c.all) return msgs; return []; },
    async *fetch(uids, q) { for (const u of Array.isArray(uids) ? uids : msgs) yield q.source ? { uid: u, flags: new Set(), source: raw({ subject: `New ${u}`, id: `new-${u}@x` }) } : { uid: u, flags: new Set() }; },
  };
  db.prepare('UPDATE folders SET uidvalidity = ? WHERE id = ?').run('1', inbox.id);
  await w.syncFolder({ ...folder, uidvalidity: '1' });
  assert.ok(db.prepare("SELECT 1 FROM messages WHERE message_id = 'new-102@x'").get(), 'UID 102 downloaded');
  assert.equal(db.prepare('SELECT last_uid FROM folders WHERE id = ?').get(inbox.id).last_uid, 102);
});

test('a folder that cannot be opened stops "downloading older mail" after three tries', async () => {
  const f = db.prepare('SELECT * FROM folders WHERE id = ?').get(db.prepare("INSERT INTO folders (account_id, path, name, sync_enabled, last_synced_at, history_done) VALUES (?, 'Broken', 'Broken', 1, ?, 0)").run(account.id, Date.now()).lastInsertRowid);
  db.prepare('UPDATE folders SET history_done = 1 WHERE id != ?').run(f.id);
  const w = new AccountSync(account.id);
  w.client = { usable: true, async getMailboxLock() { const e = new Error('Command failed'); e.responseText = 'Mailbox is broken'; throw e; } };
  for (let i = 0; i < 3; i++) await w.backfillHistory();
  assert.equal(db.prepare('SELECT history_done FROM folders WHERE id = ?').get(f.id).history_done, 1);
  assert.equal(w.historyPending, false);
});

test('a sent copy for a folder the server lacks goes to the server\'s own Sent folder', async () => {
  const w = new AccountSync(account.id);
  const calls = [];
  w.syncFolderList = async () => {};
  w.client = {
    async append(folder) { calls.push(folder); if (folder === 'Sent') { const e = new Error('Command failed'); e.responseStatus = 'NO'; throw e; } },
    async list() { return [{ path: 'INBOX' }, { path: 'INBOX.Sent Items', specialUse: '\\Sent' }]; },
    async mailboxCreate() { calls.push('create'); },
  };
  await w.applyOp('append', { folder: 'Sent', raw: '' });
  assert.deepEqual(calls, ['Sent', 'INBOX.Sent Items']);
  // A folder that exists but refuses the message: a real failure, reported.
  w.client.list = async () => [{ path: 'Sent', specialUse: '\\Sent' }];
  await assert.rejects(() => w.applyOp('append', { folder: 'Sent', raw: '' }));
});

test('an analysis survives the message being removed by sync and downloaded again', async () => {
  const { deleteMessages } = await import('../src/mail/store.js');
  const id = await ingest({ subject: 'Contract', id: 'keep-me@x' });
  db.prepare("INSERT INTO ai_insights (message_id, summary, priority, created_at) VALUES (?, 'Contract to sign', 80, ?)").run(id, Date.now());
  deleteMessages([id], { keepAnalysis: true });
  const again = await ingest({ subject: 'Contract', id: 'keep-me@x' });
  const ins = db.prepare('SELECT summary, priority FROM ai_insights WHERE message_id = ?').get(again);
  assert.deepEqual({ ...ins }, { summary: 'Contract to sign', priority: 80 });
  assert.equal(db.prepare('SELECT ai_status FROM messages WHERE id = ?').get(again).ai_status, 'done');
  // Deleted by the user: nothing is kept.
  deleteMessages([again]);
  const third = await ingest({ subject: 'Contract', id: 'keep-me@x' });
  assert.equal(db.prepare('SELECT 1 FROM ai_insights WHERE message_id = ?').get(third), undefined);
});

test('times are read in the zone the email states, or the user\'s zone', async () => {
  const { normalizeEvent, zoneOf } = await import('../src/util/time.js');
  const tz = 'Europe/Ljubljana';
  assert.equal(normalizeEvent({ date: '2026-10-22', start_time: '08:00' }, tz).start, '2026-10-22T06:00:00.000Z');
  assert.equal(normalizeEvent({ date: '2026-10-22', start_time: '08:00', tz: 'UTC' }, tz).start, '2026-10-22T08:00:00.000Z');
  assert.equal(normalizeEvent({ date: '2026-10-22', start_time: '09:00', tz: 'EST' }, tz).start, '2026-10-22T13:00:00.000Z', 'EST in October is New York daylight time');
  assert.equal(normalizeEvent({ date: '2026-10-22', start_time: '08:00', tz: 'GMT+1' }, tz).start, '2026-10-22T07:00:00.000Z');
  assert.equal(normalizeEvent({ date: '2026-10-22', start_time: '08:00', tz: 'nonsense' }, tz).start, '2026-10-22T06:00:00.000Z');
  assert.equal(zoneOf('CET'), 'Europe/Paris');
});

test('an invitation\'s own times are used for the event, floating times in the user\'s zone', async () => {
  const { extractEvent } = await import('../src/ai/tasks.js');
  const ics = (dt) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:inv-${dt}\r\nSUMMARY:Review\r\nDTSTART${dt}\r\nDTEND${dt.replace('T0800', 'T0900')}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
  const mk = (dt) => db.prepare("INSERT INTO messages (user_id, account_id, folder_id, message_id, thread_id, subject, from_addr, date, calendar_ics, created_at) VALUES (?, ?, ?, ?, 't', 'Invite', 'a@x', ?, ?, ?)")
    .run(uid, account.id, inbox.id, `inv${dt}@x`, Date.now(), ics(dt), Date.now()).lastInsertRowid;
  const utc = await extractEvent(uid, mk(':20261022T080000Z'));
  assert.equal(new Date(utc.start).toISOString(), '2026-10-22T08:00:00.000Z');
  const floating = await extractEvent(uid, mk(':20261022T080000'));
  assert.equal(new Date(floating.start).toISOString(), '2026-10-22T06:00:00.000Z', '08:00 Ljubljana');
});

test('the fast conversation list returns the same as the full query, and tabs have unread counts', async () => {
  const threaded = await api('GET', '/api/messages?view=unified&limit=5');
  const reference = await api('GET', '/api/messages?view=unified&limit=200&sort=date&dir=asc'); // old query path
  const newestFirst = [...reference.items].sort((a, b) => b.date - a.date).slice(0, 5);
  assert.deepEqual(threaded.items.map((m) => m.id), newestFirst.map((m) => m.id));
  for (const m of threaded.items) assert.equal(m.threadCount, newestFirst.find((x) => x.id === m.id).threadCount);
  // Paging: no conversation twice.
  const p2 = await api('GET', `/api/messages?view=unified&limit=5&before=${threaded.items.at(-1).date}`);
  const threadsSeen = [...threaded.items, ...p2.items].map((m) => m.threadId);
  assert.equal(new Set(threadsSeen).size, threadsSeen.length);
  const tc = await api('GET', '/api/messages/tab-counts?view=unified');
  const f = await api('GET', '/api/folders');
  assert.equal(tc.all, f.counts.unified);
  assert.ok(tc.focused + tc.other >= tc.all - 0);
});
