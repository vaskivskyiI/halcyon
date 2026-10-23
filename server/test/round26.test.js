// Shared spaces: a business mailbox, a calendar, contacts and tasks used by two people with their own logins —
// synced and analysed once, and nothing of anyone's private mail visible to the other.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r26-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, db;
// One cookie jar per person.
const jar = { a: {}, b: {}, c: {} };
async function as(who, method, url, body) {
  const cookie = Object.entries(jar[who]).map(([k, v]) => `${k}=${v}`).join('; ');
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const c of r.headers.getSetCookie?.() || []) {
    const [kv, ...attrs] = c.split(';');
    const [k, v] = kv.split('=');
    if (attrs.some((a) => /expires=Thu, 01 Jan 1970/i.test(a)) || v === '') delete jar[who][k]; else jar[who][k] = v;
  }
  return { status: r.status, data: await r.json().catch(() => null) };
}
const ok = async (...a) => { const r = await as(...a); assert.ok(r.status < 300, `${a[1]} ${a[2]} → ${r.status} ${JSON.stringify(r.data)}`); return r.data; };
let A, B, biz, priv, inbox, privInbox, bizMsg, privMsg, sharedId;
const addMsg = (account, folder, o) => Number(db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, thread_id, subject, from_name, from_addr, to_json, cc_json, date, body_text, labels_json, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, '[]', ?, ?, ?, ?)`).run(account.user_id, account.id, folder.id, Math.floor(Math.random() * 1e9), o.msgid, o.thread, o.subject, o.from, JSON.stringify([{ address: account.email }]), Date.now() - 3600e3, o.body, o.labels || '[]', Date.now()).lastInsertRowid);

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  await ok('a', 'POST', '/api/auth/setup', { email: 'a@example.org', name: 'Ann', password: 'password123' });
  await ok('a', 'POST', '/api/admin/users', { email: 'b@example.org', name: 'Ben', password: 'password123' });
  await ok('a', 'POST', '/api/admin/users', { email: 'c@example.org', name: 'Cid', password: 'password123' });
  await ok('b', 'POST', '/api/auth/login', { email: 'b@example.org', password: 'password123' });
  await ok('c', 'POST', '/api/auth/login', { email: 'c@example.org', password: 'password123' });
  A = db.prepare("SELECT id FROM users WHERE email = 'a@example.org'").get().id;
  B = db.prepare("SELECT id FROM users WHERE email = 'b@example.org'").get().id;
  await ok('a', 'POST', '/api/ai/providers', { type: 'mock', name: 'Mock' });
  await ok('a', 'PATCH', '/api/settings', { ai: { autoAnalyze: false, aboutMe: 'Ann, private: planning a surprise party', summaryLanguage: 'English' } });
  const acc = (email) => db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare('INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, ?, 0, ?)').run(A, email, Date.now()).lastInsertRowid);
  biz = acc('studio@business.example'); priv = acc('ann@private.example');
  const folder = (a) => db.prepare('SELECT * FROM folders WHERE id = ?').get(db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'INBOX', '\\Inbox')").run(a.id).lastInsertRowid);
  inbox = folder(biz); privInbox = folder(priv);
  const label = db.prepare("INSERT INTO labels (user_id, name, color) VALUES (?, 'Clients', '#f00')").run(A, ).lastInsertRowid;
  bizMsg = addMsg(biz, inbox, { msgid: 'b1@x', thread: 'bt', subject: 'Quote for the wedding shoot', from: 'client@x.example', body: 'Could you send a quote?', labels: JSON.stringify([Number(label)]) });
  privMsg = addMsg(priv, privInbox, { msgid: 'p1@x', thread: 'pt', subject: 'Doctor appointment', from: 'clinic@x.example', body: 'Your private appointment is confirmed.' });
  db.prepare("INSERT INTO ai_insights (message_id, summary, priority, category, needs_reply, model, created_at) VALUES (?, 'Send the quote.', 70, 'work', 1, 'mock', ?)").run(bizMsg, Date.now());
  db.prepare("INSERT INTO thread_summaries (user_id, thread_id, summary, message_count, updated_at) VALUES (?, 'bt', '- quote asked', 1, ?)").run(A, Date.now());
  db.prepare("INSERT INTO tasks (user_id, title, source_message_id, created_at, updated_at) VALUES (?, 'Send quote', ?, ?, ?)").run(A, bizMsg, Date.now(), Date.now());
  db.prepare("INSERT INTO tasks (user_id, title, created_at, updated_at) VALUES (?, 'Buy a present', ?, ?)").run(A, Date.now(), Date.now());
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('a shared space gets the AI setup but nothing personal, and only members can enter it', async () => {
  sharedId = (await ok('a', 'POST', '/api/shared', { name: 'Studio' })).id;
  const s = JSON.parse(db.prepare('SELECT settings_json FROM users WHERE id = ?').get(sharedId).settings_json);
  assert.equal(s.ai.aboutMe || '', '', 'personal context not copied'); assert.equal(s.ai.summaryLanguage, 'English');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_providers WHERE user_id = ?').get(sharedId).n, 1);
  assert.equal((await as('a', 'POST', '/api/auth/login', { email: db.prepare('SELECT email FROM users WHERE id = ?').get(sharedId).email, password: '' })).status, 401, 'nobody signs in as the space');
  await ok('a', 'POST', `/api/shared/${sharedId}/members`, { email: 'b@example.org' });
  assert.equal((await as('c', 'POST', `/api/shared/${sharedId}/enter`)).status, 403);
  // A forged cookie does not help a non-member.
  jar.c.halcyon_as = String(sharedId);
  assert.equal((await as('c', 'GET', '/api/messages?view=unified')).status, 403);
  delete jar.c.halcyon_as;
  assert.equal((await as('b', 'POST', `/api/shared/${sharedId}/move-out`, { accountId: biz.id })).status, 403, 'members cannot take things out');
  assert.ok(!(await ok('a', 'GET', '/api/admin/users')).some((u) => u.id === sharedId), 'not listed as a user');
});

test('moving the business account in keeps its analysis, labels, summary and tasks; private mail stays private', async () => {
  const before = db.prepare('SELECT * FROM ai_insights WHERE message_id = ?').get(bizMsg);
  await ok('a', 'POST', `/api/shared/${sharedId}/move-in`, { accountId: biz.id });
  assert.deepEqual(db.prepare('SELECT * FROM ai_insights WHERE message_id = ?').get(bizMsg), before, 'not analysed again');
  assert.equal(db.prepare('SELECT user_id FROM messages WHERE id = ?').get(bizMsg).user_id, sharedId);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM thread_summaries WHERE user_id = ? AND thread_id = 'bt'").get(sharedId).n, 1);
  assert.deepEqual(db.prepare('SELECT title FROM tasks WHERE user_id = ?').all(sharedId).map((t) => t.title), ['Send quote']);
  const lbl = JSON.parse(db.prepare('SELECT labels_json FROM messages WHERE id = ?').get(bizMsg).labels_json);
  assert.equal(db.prepare('SELECT user_id, name FROM labels WHERE id = ?').get(lbl[0]).user_id, sharedId);
  // Ben works in the shared space: he sees the business mail with its analysis — and nothing of Ann's private mail.
  await ok('b', 'POST', `/api/shared/${sharedId}/enter`);
  const list = (await ok('b', 'GET', '/api/messages?view=unified&threads=0')).items;
  assert.deepEqual(list.map((m) => m.id), [bizMsg]);
  assert.equal(list[0].ai.summary, 'Send the quote.');
  assert.equal((await as('b', 'GET', `/api/messages/${privMsg}`)).status, 404);
  assert.equal((await ok('b', 'GET', '/api/messages?q=appointment')).items.length, 0);
  assert.deepEqual((await ok('b', 'GET', '/api/tasks')).map((t) => t.title), ['Send quote']);
  assert.deepEqual((await ok('b', 'GET', '/api/accounts')).map((a) => a.email), ['studio@business.example']);
  // Ann, in her own mail, sees only her private account; in the space, the business one.
  assert.deepEqual((await ok('a', 'GET', '/api/messages?view=unified&threads=0')).items.map((m) => m.id), [privMsg]);
  await ok('a', 'POST', `/api/shared/${sharedId}/enter`);
  assert.deepEqual((await ok('a', 'GET', '/api/messages?view=unified&threads=0')).items.map((m) => m.id), [bizMsg]);
  await ok('a', 'POST', '/api/shared/leave');
  // Ben's own mail is his own again after leaving the space.
  await ok('b', 'POST', '/api/shared/leave');
  assert.equal((await ok('b', 'GET', '/api/messages?view=unified&threads=0')).items.length, 0);
});

test('a calendar and an address book can be shared too; events and contacts go with them', async () => {
  const cal = db.prepare("INSERT INTO calendars (user_id, name, source, created_at) VALUES (?, 'Shoots', 'local', ?)").run(A, Date.now()).lastInsertRowid;
  db.prepare("INSERT INTO events (calendar_id, uid, title, start, end, created_at, updated_at) VALUES (?, 'e1', 'Wedding shoot', ?, ?, ?, ?)").run(cal, Date.now() + 864e5, Date.now() + 90e6, Date.now(), Date.now());
  const book = db.prepare("INSERT INTO address_books (user_id, name, source, created_at) VALUES (?, 'Clients', 'local', ?)").run(A, Date.now()).lastInsertRowid;
  db.prepare("INSERT INTO contacts (user_id, address_book_id, display_name, emails_json, created_at, updated_at) VALUES (?, ?, 'Bride', '[{\"value\":\"bride@x.example\"}]', ?, ?)").run(A, book, Date.now(), Date.now());
  await ok('a', 'POST', `/api/shared/${sharedId}/move-in`, { calendarId: Number(cal) });
  await ok('a', 'POST', `/api/shared/${sharedId}/move-in`, { addressBookId: Number(book) });
  await ok('b', 'POST', `/api/shared/${sharedId}/enter`);
  const cals = await ok('b', 'GET', '/api/calendars');
  assert.deepEqual(cals.map((c) => c.name), ['Shoots'], 'the empty starter calendar made way');
  assert.ok((await ok('b', 'GET', `/api/events?from=${Date.now()}&to=${Date.now() + 2 * 864e5}`)).some((e) => e.title === 'Wedding shoot'));
  assert.ok((await ok('b', 'GET', '/api/contacts')).some((c) => (c.displayName || c.display_name) === 'Bride'));
  // Ann keeps a default calendar of her own.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendars WHERE user_id = ? AND is_default = 1').get(A).n, 1);
  await ok('b', 'POST', '/api/shared/leave');
});

test('in the space: shared settings but own appearance; own assistant chats; account settings stay personal', async () => {
  await ok('b', 'POST', `/api/shared/${sharedId}/enter`);
  await ok('b', 'PATCH', '/api/settings', { ui: { theme: 'dark' }, mail: { undoSendSeconds: 5 } });
  assert.equal(JSON.parse(db.prepare('SELECT settings_json FROM users WHERE id = ?').get(B).settings_json).ui.theme, 'dark');
  assert.equal(JSON.parse(db.prepare('SELECT settings_json FROM users WHERE id = ?').get(sharedId).settings_json).mail.undoSendSeconds, 5);
  const me = await ok('b', 'GET', '/api/me');
  assert.equal(me.user.email, 'b@example.org'); assert.equal(me.acting.name, 'Studio'); assert.equal(me.settings.ui.theme, 'dark');
  assert.equal((await ok('b', 'GET', '/api/auth/status')).acting.id, sharedId);
  // Changing the password in the space changes Ben's own password, never gives the space one.
  await ok('b', 'POST', '/api/auth/password', { current: 'password123', password: 'password456' });
  assert.equal(db.prepare('SELECT password_hash FROM users WHERE id = ?').get(sharedId).password_hash, null);
  // Assistant chats in the space are per member.
  db.prepare("INSERT INTO chats (user_id, title, space, author_id, created_at, updated_at) VALUES (?, 'Ann asked', '', ?, ?, ?)").run(sharedId, A, Date.now(), Date.now());
  assert.equal((await ok('b', 'GET', '/api/ai/chats')).length, 0);
  await ok('b', 'POST', '/api/shared/leave');
});

test('a read-only session can look into the space but not change anything; the owner can take the account back', async () => {
  const ro = { a: jar.a };
  jar.ro = {};
  await ok('ro', 'POST', '/api/auth/login', { email: 'a@example.org', password: 'password123', readOnly: true });
  await ok('ro', 'POST', `/api/shared/${sharedId}/enter`);
  assert.equal((await ok('ro', 'GET', '/api/messages?view=unified&threads=0')).items.length, 1);
  assert.equal((await as('ro', 'POST', '/api/messages/actions', { ids: [bizMsg], action: 'trash' })).status, 403);
  assert.equal((await as('ro', 'POST', `/api/shared/${sharedId}/move-out`, { accountId: biz.id })).status, 403);
  assert.ok(ro.a);
  assert.match((await as('a', 'DELETE', `/api/shared/${sharedId}`)).data.error, /Move the account/);
  await ok('a', 'POST', `/api/shared/${sharedId}/move-out`, { accountId: biz.id });
  assert.equal(db.prepare('SELECT user_id FROM messages WHERE id = ?').get(bizMsg).user_id, A);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_insights WHERE message_id = ?').get(bizMsg).n, 1, 'analysis kept on the way back too');
});
