// Safety and workflow features without IMAP (mock AI): undo of moves (also before the IMAP server saw them),
// no implicit permanent deletion, dismissing items from the brief, the live brief, background brief refresh,
// and dynamic AI views (topics, categories).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-ux-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';
process.env.HALCYON_DEMO = '1';

let app, base, cookie = '', db, afterIngest, account, inbox, trash, uid;

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
function addMessage(folder, { subject, from = 'someone@example.org', body = 'Hello', ageMin = 5, uidOnServer = null }) {
  seq++;
  const id = Number(db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, thread_id, subject, from_name, from_addr, to_json, cc_json,
    date, snippet, body_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, '[{"name":"Me","address":"me@example.org"}]', '[]', ?, ?, ?, ?)`)
    .run(uid, account.id, folder.id, uidOnServer, `ux${seq}@example.org`, `ux${seq}`, subject, from, Date.now() - ageMin * 60e3, body.slice(0, 100), body, Date.now()).lastInsertRowid);
  db.prepare('INSERT INTO messages_fts (rowid, subject, sender, recipients, body) VALUES (?, ?, ?, ?, ?)').run(id, subject, from, '', body);
  return id;
}
const msg = (id) => db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
const insight = (id) => db.prepare('SELECT * FROM ai_insights WHERE message_id = ?').get(id);
async function ingest(fields) { const id = addMessage(inbox, fields); await afterIngest(account, inbox, [id]); await waitFor(() => insight(id)); return id; }

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
  await api('POST', '/api/ai/providers', { type: 'mock', name: 'Mock' });
  // An unreachable IMAP server: queued operations stay pending, like a slow or offline sync.
  account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare("INSERT INTO accounts (user_id, email, imap_host, imap_port, sync_enabled, created_at) VALUES (?, 'me@example.org', '127.0.0.1', 1, 0, ?)").run(uid, Date.now()).lastInsertRowid);
  const folder = (name, special) => db.prepare('SELECT * FROM folders WHERE id = ?').get(db.prepare('INSERT INTO folders (account_id, path, name, special_use) VALUES (?, ?, ?, ?)').run(account.id, name, name, special).lastInsertRowid);
  inbox = folder('INBOX', '\\Inbox'); trash = folder('Trash', '\\Trash'); folder('Archive', '\\Archive');
});

after(async () => {
  const { syncManager } = await import('../src/mail/sync.js');
  await syncManager.stopAll();
  await app.close();
  setTimeout(() => process.exit(0), 100).unref();
});

test('delete can be undone, even before the IMAP server has seen the move', async () => {
  const id = addMessage(inbox, { subject: 'Keep me', uidOnServer: 101 });
  const r = await api('POST', '/api/messages/actions', { action: 'trash', ids: [id] });
  assert.equal(msg(id).folder_id, trash.id);
  assert.deepEqual(r.undo, [{ id, folderId: inbox.id }]);
  const op = db.prepare("SELECT * FROM pending_ops WHERE op = 'move'").get();
  assert.ok(op, 'move queued for the server');
  await api('POST', '/api/messages/actions', { action: 'restore', items: r.undo });
  assert.equal(msg(id).folder_id, inbox.id);
  assert.equal(msg(id).uid, 101, 'original server UID restored');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pending_ops WHERE op = 'move'").get().n, 0, 'queued move cancelled — nothing reaches the server');
});

test('"delete" on mail already in Trash never deletes permanently; only the explicit, confirmed action does', async () => {
  const id = addMessage(trash, { subject: 'Old', uidOnServer: 7 });
  await api('POST', '/api/messages/actions', { action: 'trash', ids: [id] });
  assert.ok(msg(id), 'still there');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pending_ops WHERE op = 'delete'").get().n, 0);
  await api('POST', '/api/messages/actions', { action: 'delete', ids: [id] });
  assert.equal(msg(id), undefined);
});

test('the live brief: dismissing, finishing tasks, expiry, and only current items', async () => {
  const urgent = await ingest({ subject: 'Contract deadline', from: 'boss@corp.example', body: 'URGENT: sign the contract today, deadline at 5pm.' });
  const question = await ingest({ subject: 'Quick question', from: 'ana@corp.example', body: 'Can you send me the slides?' });
  const t = await api('POST', '/api/tasks', { title: 'Prepare slides' });
  let b = await api('GET', '/api/ai/brief');
  assert.ok(b.live.attention.some((m) => m.id === urgent));
  assert.ok(b.live.tasks.some((x) => x.id === t.id));
  assert.ok([...b.live.attention, ...b.live.awaiting].some((m) => m.id === question));

  await api('POST', `/api/messages/${urgent}/dismiss`, {});
  await api('PATCH', `/api/tasks/${t.id}`, { done: true });
  b = await api('GET', '/api/ai/brief');
  assert.ok(!b.live.attention.some((m) => m.id === urgent), 'dismissed item gone');
  assert.ok(!b.live.tasks.some((x) => x.id === t.id), 'done task gone');
  const important = await api('GET', '/api/messages?view=important&threads=0');
  assert.ok(!important.items.some((m) => m.id === urgent), 'dismissed item also leaves Important');
  assert.ok(msg(urgent), 'the email itself is untouched');

  await api('POST', `/api/messages/${urgent}/dismiss`, { dismissed: false });
  b = await api('GET', '/api/ai/brief');
  assert.ok(b.live.attention.some((m) => m.id === urgent), 'undo brings it back');
});

test('the brief overview is re-written in the background after important new mail', async () => {
  await api('GET', '/api/ai/brief?refresh=1');
  const day = new Date().toISOString().slice(0, 10);
  db.prepare("UPDATE ai_jobs SET status = 'done' WHERE type = 'brief'").run();
  await ingest({ subject: 'Server down', from: 'ops@corp.example', body: 'URGENT: production is down, deadline now.' });
  const job = db.prepare("SELECT * FROM ai_jobs WHERE type = 'brief' AND ref_id = ?").get(day);
  assert.equal(job.status, 'queued');
  assert.ok(job.run_after > Date.now() + 60e3, 'debounced, not immediate');
});

test('dynamic AI views: topics with at least two messages and the categories present', async () => {
  const a = await ingest({ subject: 'Order 4471 confirmed', from: 'shop@store.example', body: 'Thanks for your order.' });
  await ingest({ subject: 'Order 4471 shipped', from: 'shop@store.example', body: 'Your order is on its way.' });
  const f = await api('GET', '/api/folders');
  const topic = f.topics.find((x) => x.name.toLowerCase() === 'order 4471');
  assert.ok(topic && topic.count === 2);
  const list = await api('GET', `/api/messages?view=topic&topic=${encodeURIComponent('order 4471')}&threads=0`);
  assert.ok(list.items.some((m) => m.id === a) && list.items.every((m) => m.ai.topic.toLowerCase() === 'order 4471'));
  assert.ok(Array.isArray(f.categories));
  const { normalizeTopic } = await import('../src/ai/tasks.js');
  assert.equal(normalizeTopic('order  4471', ['Order 4471']), 'Order 4471', 'spelling variants map onto the existing topic');
  assert.equal(normalizeTopic('null'), null);
});

test('"Sync now" asks for a full sync, and work arriving during a sync is not deferred to the next poll', async () => {
  const { AccountSync } = await import('../src/mail/sync.js');
  const w = new AccountSync(account.id);
  assert.equal(w.hasPendingWork, false);
  w.trigger();
  assert.equal(w.fullRequested, true, 'no folder = full sync of all folders');
  assert.equal(w.hasPendingWork, true);
  const w2 = new AccountSync(account.id);
  w2.trigger('INBOX');
  assert.ok(w2.dirtyFolders.has('INBOX') && !w2.fullRequested);
  const st = await api('GET', '/api/accounts/status');
  assert.equal(st[0].id, account.id);
  assert.ok('pendingOps' in st[0] && 'smtp' in st[0] && 'imap' in st[0]);
});

test('analysis considers how the user is addressed (sole, To with others, CC, mailing list)', async () => {
  const { addressingOf } = await import('../src/ai/tasks.js');
  const accs = [{ email: 'me@example.org', aliases_json: JSON.stringify([{ address: 'Igor@Alias.example' }]) }];
  const m = (to, cc = [], list = null) => ({ to_json: JSON.stringify(to.map((address) => ({ address }))), cc_json: JSON.stringify(cc.map((address) => ({ address }))), list_unsubscribe: list });
  assert.equal(addressingOf(m(['me@example.org']), accs).role, 'sole');
  assert.equal(addressingOf(m(['igor@alias.example', 'b@x.org']), accs).role, 'to', 'aliases count as the user');
  assert.match(addressingOf(m(['a@x.org'], ['me@example.org']), accs).text, /only in CC/);
  assert.equal(addressingOf(m(['list@lists.example'], [], '<mailto:unsub@lists.example>'), accs).role, 'none');

  // Mock analysis would say "urgent, 85": not being addressed caps it and removes "needs reply".
  const id = addMessage(inbox, { subject: 'Seminar announcement', body: 'URGENT deadline today — anyone interested?' });
  db.prepare("UPDATE messages SET to_json = '[{\"address\":\"all-staff@lists.example\"}]', list_unsubscribe = '<mailto:u@lists.example>' WHERE id = ?").run(id);
  await afterIngest(account, inbox, [id]);
  await waitFor(() => insight(id));
  assert.ok(insight(id).priority <= 55);
  assert.equal(insight(id).needs_reply, 0);
});

test('quoted history is recognised in many formats, without folding the user\'s own sentences', async () => {
  const { splitPlainQuote, QUOTE_HEAD } = await import('../src/util/quotes.js');
  const own = 'Thanks, will do.';
  const cases = [
    `${own}\n\nOn Mon, Oct 19, 2026 at 12:30 PM Ana Novak <ana@company.example>\nwrote:\n> old text`,
    `${own}\n\nV tor., 20. okt. 2026 ob 12:30 je Ana Novak <ana@company.example> napisal(a):\n> staro`,
    `${own}\n\nDne 20.10.2026 ob 12:30 je Ana Novak napisal:\n> staro`,
    `${own}\n\nFrom: Ana Novak <ana@company.example>\nSent: Monday, October 19, 2026 12:30\nTo: Me\nSubject: Re: Plan\n\nOld text`,
    `${own}\n\nOd: Ana Novak\nPoslano: ponedeljek, 19. oktober 2026 12:30\nZa: Igor\nZadeva: Načrt\n\nStaro besedilo`,
    `${own}\n\n-----Izvirno sporočilo-----\nOd: Ana`,
    `${own}\n\n________________________________\nFrom: Ana`,
  ];
  for (const c of cases) assert.equal(splitPlainQuote(c)?.own, own, c.split('\n')[2]);
  assert.equal(splitPlainQuote('On Monday I wrote: the report is ready.\nPlease check it.'), null, 'a normal sentence is not a quote');
  assert.equal(splitPlainQuote('On Mon, Ana wrote:\n> only a quote'), null, 'nothing to fold when there is no new text');
  assert.ok(QUOTE_HEAD.test('Od: Ana Novak Poslano: torek, 20. oktober 2026 12:30 Za: Igor Zadeva: Načrt …'));
  assert.ok(QUOTE_HEAD.test('On Mon, Oct 19, 2026 at 12:30 PM Ana Novak <ana@x.org> wrote: Can we meet?'));
});

test('older mail can be analysed (only missing or everything) and the bulk work can be stopped', async () => {
  const old = addMessage(inbox, { subject: 'Ancient', body: 'From long ago', ageMin: 400 * 1440 });
  const r = await api('POST', '/api/ai/reprocess', { what: 'analyze', days: 'all', mode: 'missing' });
  assert.ok(r.queued >= 1);
  const job = db.prepare("SELECT * FROM ai_jobs WHERE type = 'analyze' AND ref_id = ?").get(String(old));
  assert.ok(job && job.priority < 10, 'old mail has lower priority than new mail');
  const c = await api('POST', '/api/ai/cancel', { type: 'analyze' });
  assert.ok(c.cancelled >= 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_jobs WHERE type = 'analyze' AND status = 'queued'").get().n, 0);
  await waitFor(() => db.prepare("SELECT COUNT(*) AS n FROM ai_jobs WHERE status = 'running'").get().n === 0);
  const again = await api('POST', '/api/ai/reprocess', { what: 'analyze', days: 'all', mode: 'missing' });
  const analysed = db.prepare('SELECT COUNT(*) AS n FROM ai_insights').get().n;
  const total = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  assert.ok(again.queued <= total - analysed, '"missing" skips analysed mail');
  await api('POST', '/api/ai/cancel', { type: 'analyze' });
});
