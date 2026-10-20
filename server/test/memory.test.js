// AI memory and spaces (Work / Private), without an IMAP server: messages are inserted directly, the mock provider
// supplies analysis and bag-of-words embeddings. Covers chunked indexing, scoped mail / search / calendar / contacts,
// assistant retrieval that never crosses spaces, facts (learned, de-duplicated, user-provided), deletion, and
// isolation between users of one server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-mem-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';
process.env.HALCYON_DEMO = '1';

let app, base, db, afterIngest, buildContext, scope;
const jars = {};

async function api(user, method, url, body, { space = '' } = {}) {
  const headers = { cookie: jars[user] || '', ...(space ? { 'x-halcyon-space': encodeURIComponent(space) } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) };
  const r = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) jars[user] = sc.split(';')[0];
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') && !ct.includes('ndjson') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
const ndjson = (text) => text.trim().split('\n').map((l) => JSON.parse(l));

async function waitFor(fn, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const accounts = {}, folders = {};
let seq = 0;
function addMessage(acc, folder, { subject, from = 'someone@example.org', to = acc.email, body, ageHours = 1 }) {
  seq++;
  const id = Number(db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, message_id, thread_id, subject, from_name, from_addr, to_json, cc_json,
    date, snippet, body_text, created_at) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, '[]', ?, ?, ?, ?)`)
    .run(acc.user_id, acc.id, folder.id, `mem${seq}@example.org`, `mt${seq}`, subject, from, JSON.stringify([{ name: '', address: to }]),
      Date.now() - ageHours * 3600e3, body.slice(0, 100), body, Date.now()).lastInsertRowid);
  db.prepare('INSERT INTO messages_fts (rowid, subject, sender, recipients, body) VALUES (?, ?, ?, ?, ?)').run(id, subject, from, to, body);
  return id;
}
const memRows = (kind, ref) => db.prepare('SELECT COUNT(*) AS n FROM memory WHERE kind = ? AND ref_id = ?').get(kind, String(ref)).n;
const idle = () => waitFor(() => db.prepare("SELECT COUNT(*) AS n FROM ai_jobs WHERE status IN ('queued', 'running')").get().n === 0);

function makeAccount(userId, email) {
  const a = db.prepare("INSERT INTO accounts (user_id, email, imap_host, imap_port, sync_enabled, created_at) VALUES (?, ?, '127.0.0.1', 1, 0, ?)").run(userId, email, Date.now());
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(a.lastInsertRowid);
  const folder = (name, special) => db.prepare('SELECT * FROM folders WHERE id = ?').get(
    db.prepare('INSERT INTO folders (account_id, path, name, special_use) VALUES (?, ?, ?, ?)').run(acc.id, name, name, special).lastInsertRowid);
  folders[email] = { inbox: folder('INBOX', '\\Inbox'), sent: folder('Sent', '\\Sent') };
  return acc;
}

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  ({ afterIngest } = await import('../src/mail/pipeline.js'));
  ({ buildContext } = await import('../src/ai/assistant.js'));
  ({ scope } = await import('../src/spaces.js'));
  (await import('../src/ai/queue.js')).startQueue();

  await api('me', 'POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  const uid = db.prepare("SELECT id FROM users WHERE email = 'me@example.org'").get().id;
  await api('me', 'POST', '/api/ai/providers', { type: 'mock', name: 'Mock' });
  accounts.work = makeAccount(uid, 'me@work.example');
  accounts.home = makeAccount(uid, 'me@home.example');
  await api('me', 'PATCH', '/api/spaces/assign', { type: 'account', id: accounts.work.id, space: 'Work' });
  await api('me', 'PATCH', '/api/spaces/assign', { type: 'account', id: accounts.home.id, space: 'Private' });
  for (const k of ['work', 'home']) accounts[k] = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accounts[k].id);
});

after(async () => {
  await app.close();
  setTimeout(() => process.exit(0), 100).unref();
});

const ids = {};

test('emails are indexed in chunks; facts are learned once', async () => {
  const filler = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} about routine laboratory logistics and scheduling of instruments.`).join('\n\n');
  ids.long = addMessage(accounts.work, folders['me@work.example'].inbox, { subject: 'Quarterly lab report', body: `${filler}\n\nFinally: the secret codename for the satellite programme is Bluebird.` });
  ids.fact1 = addMessage(accounts.work, folders['me@work.example'].inbox, { subject: 'New colleague', body: 'Hello. Ana Novak is the new project manager for Helios. Welcome her.' });
  ids.fact2 = addMessage(accounts.work, folders['me@work.example'].inbox, { subject: 'Reminder', body: 'As said before. Ana Novak is the new project manager for Helios.' });
  ids.private = addMessage(accounts.home, folders['me@home.example'].inbox, { subject: 'Dentist appointment', body: 'Your dentist appointment about the satellite dish installation is on Monday.' });
  await afterIngest(accounts.work, folders['me@work.example'].inbox, [ids.long, ids.fact1, ids.fact2]);
  await afterIngest(accounts.home, folders['me@home.example'].inbox, [ids.private]);
  await waitFor(() => memRows('message', ids.private) && memRows('message', ids.fact2));
  await idle();

  assert.ok(memRows('message', ids.long) > 1, 'long email split into several chunks');
  const late = db.prepare("SELECT text FROM memory WHERE kind = 'message' AND ref_id = ? AND text LIKE '%Bluebird%'").get(String(ids.long));
  assert.match(late.text, /Subject: Quarterly lab report/, 'each chunk carries the email header');
  const facts = db.prepare("SELECT * FROM facts WHERE text LIKE '%Ana Novak%'").all();
  assert.equal(facts.length, 1, 'the same fact from two emails is kept once');
  assert.equal(facts[0].owner, `a:${accounts.work.id}`);
});

test('mail lists, folders and search are limited to the active space', async () => {
  const work = await api('me', 'GET', '/api/messages?view=unified&threads=0', undefined, { space: 'Work' });
  assert.ok(work.items.length >= 3 && work.items.every((m) => m.accountId === accounts.work.id));
  const all = await api('me', 'GET', '/api/messages?view=unified&threads=0');
  assert.ok(all.items.some((m) => m.accountId === accounts.home.id));
  const f = await api('me', 'GET', '/api/folders', undefined, { space: 'Private' });
  assert.deepEqual(f.accounts.map((a) => a.accountId), [accounts.home.id]);
  const s = await api('me', 'GET', '/api/messages?q=satellite', undefined, { space: 'Private' });
  assert.deepEqual(s.items.map((m) => m.id), [ids.private]);
  const both = await api('me', 'GET', '/api/messages?q=satellite');
  assert.ok(both.items.some((m) => m.id === ids.long) && both.items.some((m) => m.id === ids.private));
  const spaces = await api('me', 'GET', '/api/spaces');
  assert.deepEqual(spaces.spaces, ['Private', 'Work']);
});

test('assistant retrieval finds content deep inside long emails and never crosses spaces', async () => {
  const uid = accounts.work.user_id;
  const work = await buildContext(uid, 'What is the codename of the satellite programme?', scope(uid, 'Work'));
  assert.ok(work.sources.some((s) => s.id === ids.long));
  assert.match(work.text, /Bluebird/, 'the matching chunk (not just the start of the email) is used');
  assert.match(work.text, /Ana Novak is the new project manager/, 'learned facts are included');
  assert.doesNotMatch(work.text, /dentist/i);

  const priv = await buildContext(uid, 'What is the codename of the satellite programme?', scope(uid, 'Private'));
  assert.doesNotMatch(priv.text, /Bluebird|Ana Novak|lab report/);
  assert.ok(priv.sources.every((s) => s.id !== ids.long));

  // Chats remember their space; listing is per space.
  const done = ndjson(await api('me', 'POST', '/api/ai/ask', { question: 'Anything about the satellite?' }, { space: 'Private' })).at(-1);
  assert.equal(done.result.space, 'Private');
  const again = ndjson(await api('me', 'POST', '/api/ai/ask', { chatId: done.result.chatId, question: 'And the codename?' }, { space: 'Work' })).at(-1);
  assert.equal(again.result.space, 'Private', 'an existing chat keeps its space whatever the client sends');
  assert.equal((await api('me', 'GET', '/api/ai/chats', undefined, { space: 'Work' })).length, 0);
  assert.equal((await api('me', 'GET', '/api/ai/chats', undefined, { space: 'Private' })).length, 1);
});

test('"remember …" stores a user fact in the chat\'s space; memory can be reviewed and deleted', async () => {
  const done = ndjson(await api('me', 'POST', '/api/ai/ask', { question: 'Remember that my locker code is 4412.' }, { space: 'Private' })).at(-1);
  assert.match(done.result.answer, /remember/i);
  const fact = db.prepare("SELECT * FROM facts WHERE origin = 'user'").get();
  assert.equal(fact.text, 'my locker code is 4412');
  assert.equal(fact.owner, 's:Private');
  const uid = accounts.work.user_id;
  assert.match((await buildContext(uid, 'locker', scope(uid, 'Private'))).text, /4412/);
  assert.doesNotMatch((await buildContext(uid, 'locker', scope(uid, 'Work'))).text, /4412/);

  const work = await api('me', 'GET', '/api/ai/memory', undefined, { space: 'Work' });
  assert.ok(work.facts.some((f) => /Ana Novak/.test(f.text)) && !work.facts.some((f) => /4412/.test(f.text)));
  const allFacts = (await api('me', 'GET', '/api/ai/memory')).facts;
  assert.equal(allFacts.find((f) => /4412/.test(f.text)).space, 'Private');
  await api('me', 'DELETE', `/api/ai/memory/facts/${fact.id}`);
  assert.equal(memRows('fact', fact.id), 0);
  assert.doesNotMatch((await buildContext(uid, 'locker', scope(uid, 'Private'))).text, /4412/);
});

test('calendars and contacts follow the space of their account; new items go to the active space', async () => {
  const uid = accounts.work.user_id;
  // Contacts collected from mail sent with the work account land in a Work address book.
  const sentId = addMessage(accounts.work, folders['me@work.example'].sent, { subject: 'Budget', from: 'me@work.example', to: 'boss@work.example', body: 'Here is the budget.' });
  await afterIngest(accounts.work, folders['me@work.example'].sent, [sentId]);
  const workContacts = await api('me', 'GET', '/api/contacts', undefined, { space: 'Work' });
  assert.ok(workContacts.some((c) => c.emails.some((e) => e.value === 'boss@work.example')));
  const privContacts = await api('me', 'GET', '/api/contacts', undefined, { space: 'Private' });
  assert.ok(!privContacts.some((c) => c.emails.some((e) => e.value === 'boss@work.example')));
  assert.equal((await api('me', 'GET', '/api/contacts/autocomplete?q=boss', undefined, { space: 'Private' })).length, 0);

  // A calendar created while in Private belongs to Private; its events stay out of Work.
  const cal = await api('me', 'POST', '/api/calendars', { name: 'Family' }, { space: 'Private' });
  assert.equal(cal.space, 'Private');
  const start = Date.now() + 864e5;
  await api('me', 'POST', '/api/events', { calendarId: cal.id, title: 'Grandma birthday dinner', start, end: start + 7200e3 });
  const range = `/api/events?from=${start - 864e5}&to=${start + 864e5}`;
  assert.ok((await api('me', 'GET', range, undefined, { space: 'Private' })).some((e) => e.title === 'Grandma birthday dinner'));
  assert.ok(!(await api('me', 'GET', range, undefined, { space: 'Work' })).some((e) => e.title === 'Grandma birthday dinner'));
  assert.ok(!(await api('me', 'GET', '/api/calendars', undefined, { space: 'Work' })).some((c) => c.id === cal.id));
  // The shared default calendar is visible in both spaces.
  assert.ok((await api('me', 'GET', '/api/calendars', undefined, { space: 'Work' })).some((c) => c.isDefault));

  await idle();
  assert.match((await buildContext(uid, 'birthday dinner', scope(uid, 'Private'))).text, /Grandma birthday dinner/);
  assert.doesNotMatch((await buildContext(uid, 'birthday dinner', scope(uid, 'Work'))).text, /Grandma/);
});

test('deleting mail or an account removes what the AI memory learned from it', async () => {
  const { deleteMessages } = await import('../src/mail/store.js');
  deleteMessages([ids.private]);
  assert.equal(memRows('message', ids.private), 0);
  await api('me', 'DELETE', `/api/accounts/${accounts.work.id}`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory WHERE owner = ?').get(`a:${accounts.work.id}`).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM facts WHERE owner = ?').get(`a:${accounts.work.id}`).n, 0);
  assert.equal(memRows('message', ids.long), 0);
});

test('users of one server never see each other\'s memory', async () => {
  await api('me', 'POST', '/api/admin/users', { email: 'eve@example.org', name: 'Eve', password: 'password123' });
  await api('eve', 'POST', '/api/auth/login', { email: 'eve@example.org', password: 'password123' });
  const eve = db.prepare("SELECT id FROM users WHERE email = 'eve@example.org'").get().id;
  await api('eve', 'POST', '/api/ai/providers', { type: 'mock', name: 'Mock' });
  const acc = makeAccount(eve, 'eve@example.org');
  const id = addMessage(acc, folders['eve@example.org'].inbox, { subject: 'Eve notes', body: 'Grandma birthday dinner plans and the locker.' });
  await afterIngest(acc, folders['eve@example.org'].inbox, [id]);
  await waitFor(() => memRows('message', id));
  const ctx = await buildContext(eve, 'Grandma birthday dinner', null);
  assert.doesNotMatch(ctx.text, /Family|Grandma birthday dinner ·/, 'no events of the other user');
  assert.ok(ctx.sources.every((s) => s.id === id));
  const found = await api('eve', 'GET', '/api/messages?q=birthday');
  assert.deepEqual(found.items.map((m) => m.id), [id]);
  assert.equal((await api('eve', 'GET', '/api/ai/memory')).facts.length, 0);
});
