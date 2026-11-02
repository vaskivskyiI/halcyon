// Requests stay answered while the server works in the background: mail is parsed and the AI memory searched in worker
// threads, checkpoints run off the main connection, backfill and purge go in slices, and Server activity tells a slow
// handler from a busy server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r77-test-'));
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, db, cookie = '', account, inbox;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => null) };
}
const block = (ms) => { const end = performance.now() + ms; while (performance.now() < end) { /* busy */ } };
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  await api('POST', '/api/auth/setup', { email: 'u@example.org', name: 'U', password: 'password123' });
  const acc = db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (1, 'u@example.org', 0, 0)").run().lastInsertRowid;
  db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'INBOX', '\\Inbox')").run(acc);
  account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(acc);
  inbox = db.prepare('SELECT * FROM folders WHERE account_id = ?').get(acc);
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('new mail is parsed in a worker and stored with everything it had before', async () => {
  const { ingestMessage } = await import('../src/mail/store.js');
  const ics = ['BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:r77@x', 'DTSTART:20300101T100000Z', 'DTEND:20300101T110000Z', 'SUMMARY:Review', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const raw = Buffer.from(['From: Ana <ana@x.example>', 'Sender: Assistant <pa@x.example>', 'To: u@example.org', 'Cc: Bo <bo@y.example>', 'Subject: Plan',
    'Message-ID: <r77-1@x.example>', 'References: <r77-0@x.example>', 'Date: Mon, 1 Jan 2029 10:00:00 +0000', 'List-Unsubscribe: <mailto:unsub@x.example>',
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b"', '', '--b', 'Content-Type: text/html; charset=utf-8', '',
    '<p>Hello <b>there</b>, see the plan.</p>', '--b', 'Content-Type: text/calendar; method=REQUEST; name=invite.ics', 'Content-Disposition: attachment; filename=invite.ics', '', ics,
    '--b--', ''].join('\r\n'));
  const { id, isNew } = await ingestMessage({ account, folder: inbox, uid: 1, flags: ['\\Seen'], raw, internalDate: new Date() });
  assert.ok(isNew);
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  assert.equal(m.subject, 'Plan');
  assert.equal(m.message_id, 'r77-1@x.example');
  assert.deepEqual(JSON.parse(m.references_json), ['r77-0@x.example']);
  assert.equal(m.from_addr, 'ana@x.example');
  assert.deepEqual(JSON.parse(m.cc_json), [{ name: 'Bo', address: 'bo@y.example' }]);
  assert.match(m.body_text, /Hello there, see the plan/);
  assert.match(m.body_html, /<b>there<\/b>/);
  assert.match(m.calendar_ics, /SUMMARY:Review/);
  assert.equal(JSON.parse(m.sender_json).address, 'pa@x.example');
  assert.equal(m.is_read, 1);
  assert.equal(m.date, Date.UTC(2029, 0, 1, 10));
  assert.ok(db.prepare("SELECT 1 FROM messages_fts WHERE messages_fts MATCH 'plan' AND rowid = ?").get(id));
  // The same message again: found, not stored twice.
  assert.equal((await ingestMessage({ account, folder: inbox, uid: 1, flags: [], raw, internalDate: new Date() })).isNew, false);
  // Mail that cannot be parsed is still stored.
  const odd = await ingestMessage({ account, folder: inbox, uid: 2, flags: [], raw: Buffer.from('Subject: Odd\r\n\r\nplain body'), internalDate: new Date(2029, 1, 1) });
  assert.equal(db.prepare('SELECT subject FROM messages WHERE id = ?').get(odd.id).subject, 'Odd');
});

test('the AI memory index lives in a worker and follows what is stored and removed', async () => {
  const { storeMemory, removeMemory, searchMemory, memoryStats, invalidate } = await import('../src/ai/memory.js');
  const v = (...xs) => { const a = new Array(8).fill(0); xs.forEach((x, i) => { a[i] = x; }); return a; };
  storeMemory(1, { kind: 'fact', ref: 'f1', owner: 'a:1', model: 'm', chunks: [{ text: 'one', vector: v(1, 0) }] });
  const p = searchMemory(1, v(1, 0.1), 'm', { k: 5 });
  assert.ok(p instanceof Promise);
  assert.deepEqual((await p).map((h) => h.ref), ['f1']);
  // Added after the index was loaded: the worker is told.
  storeMemory(1, { kind: 'fact', ref: 'f2', owner: 'a:2', model: 'm', chunks: [{ text: 'two', vector: v(0.9, 0.2) }] });
  assert.deepEqual((await searchMemory(1, v(1, 0), 'm', { k: 5 })).map((h) => h.ref).sort(), ['f1', 'f2']);
  assert.deepEqual((await searchMemory(1, v(1, 0), 'm', { owners: new Set(['a:2']) })).map((h) => h.ref), ['f2']);
  // Replaced and removed items are gone from the index too.
  storeMemory(1, { kind: 'fact', ref: 'f1', owner: 'a:1', model: 'm', chunks: [{ text: 'one, now elsewhere', vector: v(0, 1) }] });
  removeMemory(1, 'fact', ['f2']);
  assert.deepEqual((await searchMemory(1, v(1, 0), 'm', { k: 5 })).map((h) => h.ref), []);
  assert.deepEqual((await searchMemory(1, v(0, 1), 'm', { k: 5 })).map((h) => h.ref), ['f1']);
  assert.equal((await memoryStats(1)).loaded.chunks, 1);
  // Dropped and reloaded from the database by the worker's own connection.
  invalidate(1);
  assert.equal((await memoryStats(1)).loaded, null);
  assert.deepEqual((await searchMemory(1, v(0, 1), 'm', { k: 5 })).map((h) => h.ref), ['f1']);
  assert.equal((await api('GET', '/api/ai/status')).data.memory.loaded.chunks, 1);
});

test('checkpoints are not left to the connection that answers requests; scans run in a worker', async () => {
  const { readAll } = await import('../src/db/index.js');
  assert.equal(db.pragma('wal_autocheckpoint', { simple: true }), 0);
  assert.deepEqual(await readAll('SELECT subject FROM messages WHERE subject = ?', 'Plan'), [{ subject: 'Plan' }]);
  await assert.rejects(readAll("DELETE FROM messages WHERE subject = 'Plan'"));
  assert.ok(db.prepare("SELECT 1 FROM messages WHERE subject = 'Plan'").get());
});

test('backfill queues in batches and the memory purge goes in slices, without holding the server', async () => {
  const { backfillAnalysis, purgeMemory } = await import('../src/mail/pipeline.js');
  await api('POST', '/api/ai/providers', { type: 'mock', name: 'Mock' });
  await api('PATCH', '/api/settings', { ai: { enabled: true, autoAnalyze: true, embeddings: true } });
  const { pauseQueue } = await import('../src/ai/queue.js');
  pauseQueue(true);
  const ins = db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, thread_id, subject, from_addr, to_json, cc_json, date, is_read, created_at)
    VALUES (1, ?, ?, ?, ?, ?, 'Old', 'a@x.example', '[]', '[]', ?, 1, 0)`);
  db.transaction(() => { for (let i = 0; i < 1200; i++) ins.run(account.id, inbox.id, 1000 + i, `bf${i}@x`, `t${i}`, Date.now() - i * 60e3); })();
  db.prepare("DELETE FROM ai_jobs").run();
  const p = backfillAnalysis(1);
  assert.ok(p instanceof Promise);
  await p;
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM ai_jobs WHERE type = 'analyze' AND status = 'queued'").get().n >= 1200);
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM ai_jobs WHERE type = 'embed' AND status = 'queued'").get().n >= 1200);
  db.prepare("DELETE FROM ai_jobs").run();
  pauseQueue(false);

  // Memory of 9000 messages that are gone and of one that is still there.
  db.prepare('DELETE FROM memory').run();
  const mem = db.prepare("INSERT INTO memory (user_id, kind, ref_id, chunk, owner, text, model, dim, vector, created_at) VALUES (1, 'message', ?, 0, 'a:1', 't', 'm', 1, ?, 0)");
  const live = db.prepare("SELECT id FROM messages WHERE subject = 'Plan'").get().id;
  db.transaction(() => { for (let i = 0; i < 9000; i++) mem.run(String(900000 + i), Buffer.alloc(4)); mem.run(String(live), Buffer.alloc(4)); })();
  assert.equal(await purgeMemory(), 9000);
  assert.deepEqual(db.prepare('SELECT ref_id FROM memory').all(), [{ ref_id: String(live) }]);
});

test('Server activity tells a slow handler from a busy server and shows the worker threads', async () => {
  const { requestStart, recordRequest, activitySnapshot } = await import('../src/util/activity.js');
  // Busy elsewhere while the request was in flight.
  const r1 = { method: 'GET', url: '/api/folders', routeOptions: { url: '/api/folders' } };
  requestStart(r1);
  const t1 = performance.now();
  await tick(20);
  block(700);
  await tick(30);
  recordRequest(r1, 200, performance.now() - t1);
  // Slow by itself: its own synchronous work.
  const r2 = { method: 'GET', url: '/api/messages', routeOptions: { url: '/api/messages' } };
  await tick(30);
  requestStart(r2);
  const t2 = performance.now();
  block(700);
  r2.ownMs = performance.now() - t2;
  await tick(30);
  recordRequest(r2, 200, performance.now() - t2);
  const [own, busy] = activitySnapshot().slowRequests;
  assert.equal(busy.route, '/api/folders');
  assert.ok(busy.busyMs >= 600, `busy ${busy.busyMs}`);
  assert.ok(busy.ownMs < 50);
  assert.equal(own.route, '/api/messages');
  assert.ok(own.ownMs >= 650, `own ${own.ownMs}`);
  assert.ok(own.busyMs < 100, `busy ${own.busyMs}`);

  // Handlers are timed on real requests; the admin view lists the worker pools and recent stalls.
  const res = await api('GET', '/api/admin/activity');
  assert.equal(res.status, 200);
  const names = res.data.workers.map((w) => w.name);
  for (const n of ['Mail parsing', 'AI memory search', 'Database scans']) assert.ok(names.includes(n), n);
  const parsing = res.data.workers.find((w) => w.name === 'Mail parsing');
  assert.ok(parsing.calls >= 3 && parsing.failed === 0 && parsing.restarts === 0, JSON.stringify(parsing));
  assert.ok(res.data.process.stalls.maxMs >= 650);
});
