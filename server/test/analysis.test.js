// Analysis quality features without IMAP (mock AI): event times in the user's time zone, expiring login codes,
// "please forward me the email with …" suggestions, learning from the user's corrections, two-phase search,
// chat progress/sources, and hiding the hidden reasoning of "thinking" models.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-analysis-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';
process.env.HALCYON_DEMO = '1';

let app, base, cookie = '', db, afterIngest, account, inbox, uid;

async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') && !ct.includes('ndjson') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
const waitFor = async (fn, ms = 15000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 50)); } };
let seq = 0;
function addMessage({ subject, from = 'someone@example.org', body, ageMin = 5, attachments = false }) {
  seq++;
  const id = Number(db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, message_id, thread_id, subject, from_name, from_addr, to_json, cc_json,
    date, snippet, body_text, has_attachments, created_at) VALUES (?, ?, ?, ?, ?, ?, '', ?, '[{"name":"","address":"me@example.org"}]', '[]', ?, ?, ?, ?, ?)`)
    .run(uid, account.id, inbox.id, `an${seq}@example.org`, `at${seq}`, subject, from, Date.now() - ageMin * 60e3, body.slice(0, 100), body, attachments ? 1 : 0, Date.now()).lastInsertRowid);
  db.prepare('INSERT INTO messages_fts (rowid, subject, sender, recipients, body) VALUES (?, ?, ?, ?, ?)').run(id, subject, from, 'me@example.org', body);
  return id;
}
const insight = (id) => db.prepare('SELECT * FROM ai_insights WHERE message_id = ?').get(id);
async function ingest(fields) { const id = addMessage(fields); await afterIngest(account, inbox, [id]); await waitFor(() => insight(id)); return id; }

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
  account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare("INSERT INTO accounts (user_id, email, imap_host, imap_port, sync_enabled, created_at) VALUES (?, 'me@example.org', '127.0.0.1', 1, 0, ?)").run(uid, Date.now()).lastInsertRowid);
  const folder = (name, special) => db.prepare('SELECT * FROM folders WHERE id = ?').get(db.prepare('INSERT INTO folders (account_id, path, name, special_use) VALUES (?, ?, ?, ?)').run(account.id, name, name, special).lastInsertRowid);
  inbox = folder('INBOX', '\\Inbox'); folder('Junk', '\\Junk');
});

after(async () => { await app.close(); setTimeout(() => process.exit(0), 100).unref(); });

test('event times are read as wall-clock time in the user\'s time zone (summer, winter, legacy UTC answers)', async () => {
  const { normalizeEvent, localToEpoch } = await import('../src/util/time.js');
  const tz = 'Europe/Ljubljana';
  assert.equal(normalizeEvent({ title: 'Lunch', date: '2026-10-21', start_time: '12:30' }, tz).start, '2026-10-21T10:30:00.000Z', 'CEST = UTC+2');
  assert.equal(normalizeEvent({ title: 'Lunch', date: '2026-12-01', start_time: '12:30', end_time: '13:15' }, tz).end, '2026-12-01T12:15:00.000Z', 'CET = UTC+1');
  // A model answering "12:30Z" for a meeting at 12:30 must not end up at 14:30.
  assert.equal(normalizeEvent({ title: 'x', start: '2026-10-21T12:30:00Z' }, tz).start, '2026-10-21T10:30:00.000Z');
  assert.equal(new Date(localToEpoch('2026-03-29', '03:30', tz)).toISOString(), '2026-03-29T01:30:00.000Z', 'after the spring-forward gap');
  const allDay = normalizeEvent({ title: 'Holiday', date: '2026-11-01' }, tz);
  assert.equal(allDay.all_day, true);
  assert.equal(normalizeEvent({ title: 'no date' }, tz), null);
});

test('login codes expire: they leave the priority views and "needs reply"', async () => {
  const fresh = await ingest({ subject: 'Your verification code', from: 'no-reply@bank.example', body: 'Your one-time login code is 482913. URGENT: it is valid for 10 minutes.' });
  const i1 = insight(fresh);
  assert.ok(i1.expires_at > Date.now(), 'expiry set from the code heuristic');
  assert.ok(i1.priority >= 80, 'still important while valid');
  const stale = await ingest({ subject: 'Sign-in code', from: 'no-reply@shop.example', body: 'Your sign-in code is 1234567. Urgent.', ageMin: 180 });
  assert.ok(insight(stale).priority <= 10, 'already expired when analysed');
  const { expireInsights } = await import('../src/ai/tasks.js');
  db.prepare('UPDATE ai_insights SET expires_at = ? WHERE message_id = ?').run(Date.now() - 1000, fresh);
  assert.equal(expireInsights(), 1);
  assert.ok(insight(fresh).priority <= 10);
  const important = await api('GET', '/api/messages?view=important&threads=0');
  assert.ok(!important.items.some((m) => m.id === fresh));
});

test('a request to forward an earlier email suggests matching emails', async () => {
  const docs = await ingest({ subject: 'Shipping documents for order 4471', from: 'logistics@carrier.example', body: 'Attached are the shipping documents (bill of lading, packing list).', ageMin: 3 * 24 * 60, attachments: true });
  await ingest({ subject: 'Lunch on Friday?', from: 'friend@example.org', body: 'Shall we have lunch?', ageMin: 2 * 24 * 60 });
  const req = await ingest({ subject: 'Prevzemni zapisnik', from: 'ana@company.example',
    body: 'Prosila bi da mi posredujete spodnji email, kjer ste dobili shipping documents, ker rabim da pripravim prevzemni zapisnik.' });
  const got = JSON.parse(insight(req).requests_json);
  assert.equal(got[0].candidates[0].id, docs);
  assert.equal(got[0].candidates[0].hasAttachments, true);
  const full = await api('GET', `/api/messages/${req}`);
  assert.equal(full.insight.requests[0].candidates[0].subject, 'Shipping documents for order 4471');
});

test('the AI learns from "important", "not important", category and spam corrections', async () => {
  const n1 = await ingest({ subject: 'Weekly digest', from: 'digest@news.example', body: 'URGENT deadline today: this week in science.' });
  assert.ok(insight(n1).priority >= 80);
  let r = await api('POST', `/api/messages/${n1}/feedback`, { kind: 'unimportant' });
  assert.ok(r.insight.priority <= 15, 'corrected immediately');
  const n2 = await ingest({ subject: 'Weekly digest #2', from: 'digest@news.example', body: 'URGENT deadline today: more science.' });
  assert.ok(insight(n2).priority <= 20, 'next mail from the sender follows the correction');

  const b1 = await ingest({ subject: 'Hi', from: 'boss@corp.example', body: 'Just a note.' });
  await api('POST', `/api/messages/${b1}/feedback`, { kind: 'important' });
  await api('POST', `/api/messages/${b1}/feedback`, { kind: 'category', value: 'finance' });
  const b2 = await ingest({ subject: 'Another note', from: 'boss@corp.example', body: 'FYI.' });
  assert.ok(insight(b2).priority >= 75);
  assert.equal(insight(b2).category, 'finance');
  // Two agreeing corrections for one company domain apply to colleagues too.
  const c1 = await ingest({ subject: 'x', from: 'cfo@corp.example', body: 'y' });
  await api('POST', `/api/messages/${c1}/feedback`, { kind: 'important' });
  const c2 = await ingest({ subject: 'z', from: 'intern@corp.example', body: 'w' });
  assert.ok(insight(c2).priority >= 75);
  const { preferenceExamples } = await import('../src/ai/learning.js');
  assert.match(preferenceExamples(uid, 'someone@news.example'), /digest@news\.example.*NOT important/);

  const s1 = addMessage({ subject: 'Cheap watches', from: 'spammer@junk.example', body: 'Buy now' });
  await afterIngest(account, inbox, [s1]);
  await api('POST', '/api/messages/actions', { ids: [s1], action: 'spam' });
  const s2 = addMessage({ subject: 'Cheap watches again', from: 'spammer@junk.example', body: 'Buy now' });
  await afterIngest(account, inbox, [s2]);
  await waitFor(() => db.prepare('SELECT f.special_use FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.id = ?').get(s2).special_use === '\\Junk');
  const prefs = await api('GET', '/api/ai/preferences');
  assert.ok(prefs.some((p) => p.fromAddr === 'spammer@junk.example' && p.kind === 'spam'));
  await api('DELETE', '/api/ai/preferences?from=spammer@junk.example');
  assert.ok(!(await api('GET', '/api/ai/preferences')).some((p) => p.fromAddr === 'spammer@junk.example'));
});

test('search: keyword results come without AI; meaning-based results come separately', async () => {
  await waitFor(() => db.prepare("SELECT COUNT(*) AS n FROM ai_jobs WHERE status IN ('queued','running')").get().n === 0);
  const kw = await api('GET', '/api/messages?q=shipping&semantic=0');
  assert.ok(kw.items.length >= 1);
  const ai = await api('GET', `/api/search/semantic?q=${encodeURIComponent('bill of lading packing list order')}&exclude=${kw.items.map((m) => m.id).join(',')}`);
  assert.ok(Array.isArray(ai.items));
  assert.ok(ai.items.every((m) => !kw.items.some((k) => k.id === m.id)), 'no duplicates of keyword results');
});

test('chat streams progress and lists every email it used as a source', async () => {
  const text = await api('POST', '/api/ai/ask', { question: 'What about the shipping documents?' });
  const lines = text.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.s === 'Searching your mail…'));
  const done = lines.at(-1);
  assert.ok(done.done);
  assert.ok(done.result.sources.length > 0, 'sources are returned even when the model cites nothing');
  assert.ok(done.result.sources.every((s) => s.id && s.subject !== undefined));
});

test('hidden reasoning of thinking models is not shown; Ollama is asked not to think', async () => {
  const { stripThink, thinkFilter } = await import('../src/ai/providers/http.js');
  assert.equal(stripThink('<think>plan…</think>\nHello'), 'Hello');
  let out = '';
  const f = thinkFilter((t) => (out += t));
  for (const t of ['<thi', 'nk>secret', ' plan</th', 'ink>', '\nHel', 'lo <b>x</b> <']) f(t);
  f.flush();
  assert.equal(out, 'Hello <b>x</b> <', 'a held-back tail is released at the end of the stream');

  const seen = [];
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => {
      const body = JSON.parse(b); seen.push(body);
      if ('think' in body) { res.statusCode = 400; return res.end(JSON.stringify({ error: '"m" does not support thinking' })); }
      res.end(JSON.stringify({ message: { content: 'OK' } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { makeProvider } = await import('../src/ai/providers/index.js');
  const p = makeProvider({ type: 'ollama', baseUrl: `http://127.0.0.1:${server.address().port}` });
  const r = await p.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.text, 'OK');
  assert.equal(seen[0].think, false, 'first asks without thinking');
  assert.ok(!('think' in seen[1]), 'retries without the flag for models that reject it');
  server.close();
});
