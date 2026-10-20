// "No reply needed" for whole conversations, settings that answer at once, polled status queries that use indexes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r10-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, account, inbox, uid;

async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
const waitFor = async (fn, ms = 5000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 30)); } };
let seq = 0;
const add = (thread, needsReply) => {
  const id = Number(db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, thread_id, subject, from_addr, to_json, cc_json, date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'S', 'a@x.example', '[]', '[]', ?, ?)`).run(uid, account.id, inbox.id, ++seq, `r10-${seq}@x`, thread, Date.now() - seq * 60e3, Date.now()).lastInsertRowid);
  if (needsReply != null) db.prepare('INSERT INTO ai_insights (message_id, priority, needs_reply, created_at) VALUES (?, 50, ?, ?)').run(id, needsReply, Date.now());
  return id;
};
const nr = (id) => db.prepare('SELECT needs_reply FROM ai_insights WHERE message_id = ?').get(id)?.needs_reply;

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, 'me@example.org', 0, ?)").run(uid, Date.now()).lastInsertRowid);
  inbox = db.prepare('SELECT * FROM folders WHERE id = ?').get(db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'INBOX', '\\Inbox')").run(account.id).lastInsertRowid);
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('"no reply needed" on selected conversations clears every message in them', async () => {
  const a1 = add('ta', 1), a2 = add('ta', 1), b1 = add('tb', 1), c1 = add('tc', 1);
  const r = await api('POST', '/api/messages/needs-reply', { ids: [a2, b1], value: false, threads: true });
  assert.equal(r.count, 3);
  assert.deepEqual([nr(a1), nr(a2), nr(b1), nr(c1)], [0, 0, 0, 1], 'other conversations untouched');
  // Without conversation view: exactly the given messages.
  const d1 = add('td', 1), d2 = add('td', 1);
  await api('POST', '/api/messages/needs-reply', { ids: [d1], value: false });
  assert.deepEqual([nr(d1), nr(d2)], [0, 1]);
});

test('settings answer at once; the mailbox is only searched for unanalysed mail when that answer can change', async () => {
  await api('POST', '/api/ai/providers', { type: 'mock', name: 'Mock' });
  await api('PATCH', '/api/settings', { ai: { autoAnalyze: false } });
  const m = add('te', null);
  const jobs = () => db.prepare("SELECT COUNT(*) AS n FROM ai_jobs WHERE type = 'analyze' AND ref_id = ?").get(String(m)).n;
  await api('PATCH', '/api/settings', { ai: { threadSummaries: false } });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(jobs(), 0, 'unrelated switch: no search');
  await api('PATCH', '/api/settings', { ai: { autoAnalyze: true } });
  await waitFor(() => jobs() === 1);
});

test('status queries that are polled use indexes instead of reading the mailbox', () => {
  const plan = (sql, ...p) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...p).map((r) => r.detail).join(' | ');
  assert.match(plan('SELECT COUNT(*) FROM messages WHERE account_id = ? AND local_copy = 1 AND uid IS NULL AND created_at < ?', 1, 1), /idx_messages_local_copy/);
  assert.match(plan('SELECT kind, model, COUNT(*), COUNT(DISTINCT ref_id) FROM memory WHERE user_id = ? GROUP BY kind, model', 1), /COVERING INDEX idx_memory_stats/);
});
