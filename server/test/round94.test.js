// Search from "All inboxes" (the "Everywhere" choice was sent as inAccount=ll and found nothing), closest matches
// when no message has all the words, and matches by meaning: conversation summaries, a cut-off relative to the best
// match, and more candidates when operators filter them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r94-test-'));
process.env.HALCYON_LOG_LEVEL = 'error';
process.env.HALCYON_DEMO = '1';

let app, base, cookie = '', db, uid, ingestMessage, n = 0;
const accounts = [], folders = {};
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
async function arrive(account, folder, subject, body = 'About the harbour budget.', thread = '') {
  const raw = `Message-ID: <r94-${++n}@x>\r\n${thread ? `In-Reply-To: <${thread}>\r\nReferences: <${thread}>\r\n` : ''}From: <someone@example.com>\r\nTo: ${account.email}\r\nSubject: ${subject}\r\nDate: ${new Date(Date.now() - 600e3 + n * 1000).toUTCString()}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;
  return (await ingestMessage({ account, folder, uid: n, flags: [], raw: Buffer.from(raw) })).id;
}

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  ({ ingestMessage } = await import('../src/mail/store.js'));
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  for (const email of ['me@example.org', 'work@example.org']) {
    const a = db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare('INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, ?, 0, ?)').run(uid, email, Date.now()).lastInsertRowid);
    accounts.push(a);
    folders[email] = db.prepare('SELECT * FROM folders WHERE id = ?').get(db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'INBOX', '\\Inbox')").run(a.id).lastInsertRowid);
  }
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('a search in All inboxes finds mail of every mailbox, also when the page sends a non-id scope', async () => {
  const [me, work] = accounts;
  const a = await arrive(me, folders['me@example.org'], 'Lighthouse repair');
  const b = await arrive(work, folders['work@example.org'], 'Lighthouse paint');
  for (const extra of ['', '&inAccount=ll', '&inFolder=x', '&filter=focused']) {
    const r = await api('GET', `/api/messages?view=unified&q=lighthouse&semantic=0&threads=0${extra}`);
    assert.deepEqual(r.items.map((m) => m.id).sort(), [a, b].sort(), extra || 'plain');
  }
});

test('no message with all the words: the closest ones, marked as such', async () => {
  const [me] = accounts;
  const both = await arrive(me, folders['me@example.org'], 'Anchor and mooring fees');
  const one = await arrive(me, folders['me@example.org'], 'Anchor maintenance', 'Nothing else here.');
  const exact = await api('GET', '/api/messages?q=anchor%20mooring&semantic=0&threads=0');
  assert.deepEqual(exact.items.map((m) => m.id), [both]);
  assert.ok(!exact.relaxed);
  const loose = await api('GET', '/api/messages?q=anchor%20mooring%20zzqtypo&semantic=0&threads=0');
  assert.equal(loose.relaxed, true);
  assert.deepEqual(loose.items.map((m) => m.id), [both, one], 'the one with more of the words first');
  // An explicit OR, operators or a single word are taken as written.
  assert.ok(!(await api('GET', '/api/messages?q=zzqtypo&semantic=0')).relaxed);
  assert.equal((await api('GET', '/api/messages?q=zzqtypo&semantic=0')).items.length, 0);
});

test('matches by meaning: a conversation summary stands for its newest message; weak tail cut off', async () => {
  const { storeMemory } = await import('../src/ai/memory.js');
  const { messageHits, goodHits, hasOperators, parseQuery } = await import('../src/search.js');
  const [me] = accounts;
  const first = await arrive(me, folders['me@example.org'], 'Quarterly numbers', 'See attached.');
  const reply = await arrive(me, folders['me@example.org'], 'Re: Quarterly numbers', 'Thanks.', `r94-${n}@x`);
  const thread = db.prepare('SELECT thread_id AS t FROM messages WHERE id = ?').get(reply).t;
  assert.equal(db.prepare('SELECT thread_id AS t FROM messages WHERE id = ?').get(first).t, thread);
  const vec = (i) => Array.from({ length: 8 }, (_, j) => (j === i ? 1 : 0));
  storeMemory(uid, { kind: 'thread', ref: thread, owner: `a:${me.id}`, date: Date.now(), model: 'test', chunks: [{ text: 'Conversation summary: revenue forecast', vector: vec(0) }] });
  const hits = await messageHits(uid, { vector: vec(0), model: 'test' }, 10);
  assert.deepEqual(hits.map((h) => h.id), [reply]);
  assert.deepEqual(goodHits([{ score: 0.9 }, { score: 0.75 }, { score: 0.5 }, { score: 0.28 }]).map((h) => h.score), [0.9, 0.75]);
  assert.deepEqual(goodHits([{ score: 0.45 }, { score: 0.35 }, { score: 0.29 }]).map((h) => h.score), [0.45, 0.35]);
  assert.equal(hasOperators(parseQuery('budget harbour')), false);
  assert.equal(hasOperators(parseQuery('budget from:anna')), true);
  assert.equal(hasOperators(parseQuery('budget -spam')), true);
});

test('a word in the subject ranks above the same word only in the body, also when the word is everywhere', async () => {
  const [me] = accounts;
  const inSubject = await arrive(me, folders['me@example.org'], 'Seagull report', 'Seagull numbers for the season.');
  const newer = [];
  for (let i = 0; i < 4; i++) newer.push(await arrive(me, folders['me@example.org'], `Weekly update ${i}`, 'The seagull count went up.'));
  const r = await api('GET', '/api/messages?q=seagull&semantic=0&threads=0');
  assert.equal(r.items[0].id, inSubject, 'subject match first, though the others are newer');
  assert.equal(r.items.length, 5);
});
