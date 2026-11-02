// How responsive the mail list and folder counts stay while the server does heavy background work (not part of the test
// suite). Needs a database made by bench-lists.mjs: DIR=<dir> N=250000 node test/bench-lists.mjs, then
// DIR=<dir> node test/bench-busy.mjs [ingest|vectors|ai|maintenance ...]. Each workload runs while a probe loads
// /api/messages and /api/folders every 50 ms; the times it saw and the longest event-loop stall are printed.
import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.DIR;
if (!dir || !fs.existsSync(path.join(dir, 'halcyon.db'))) { console.error('DIR must hold a database made by bench-lists.mjs'); process.exit(1); }
process.env.HALCYON_DATA_DIR = dir;
process.env.HALCYON_LOG_LEVEL = 'error';
const only = process.argv.slice(2);
const CHUNKS = Number(process.env.CHUNKS || 150000), INGEST = Number(process.env.INGEST || 1500), JOBS = Number(process.env.JOBS || 600);

const { buildServer } = await import('../src/index.js');
const app = await buildServer({ background: false });
await app.listen({ host: '127.0.0.1', port: 0 });
const base = `http://127.0.0.1:${app.server.address().port}`;
const { db } = await import('../src/db/index.js');
const { recentStalls } = await import('../src/util/activity.js');
let cookie = '';
const call = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return r.json();
};
await call('POST', '/api/auth/login', { email: 'u@example.org', password: 'password123' });

const pct = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);
async function measure(label, work) {
  let done = false;
  const times = { messages: [], folders: [] };
  const probe = (async () => {
    while (!done) {
      for (const [k, url] of [['messages', '/api/messages?view=unified'], ['folders', '/api/folders']]) {
        const t = performance.now(); await call('GET', url); times[k].push(performance.now() - t);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  })();
  const t0 = performance.now();
  await work();
  const ms = performance.now() - t0;
  done = true; await probe;
  const s = recentStalls(ms + 5);
  console.log(`${label.padEnd(22)} ${String(Math.round(ms)).padStart(7)} ms work | stalls ${s.count}, max ${s.maxMs} ms, total ${s.totalMs} ms`);
  for (const [k, a] of Object.entries(times)) console.log(`   ${k.padEnd(9)} n=${String(a.length).padStart(4)}  p50 ${Math.round(pct(a, 0.5))}  p95 ${Math.round(pct(a, 0.95))}  max ${Math.round(Math.max(0, ...a))} ms`);
}
const want = (w) => !only.length || only.includes(w);

await measure('idle', () => new Promise((r) => setTimeout(r, 2000)));

const account = db.prepare('SELECT * FROM accounts WHERE user_id = 1 LIMIT 1').get();
const inbox = db.prepare("SELECT * FROM folders WHERE account_id = ? AND special_use = '\\Inbox'").get(account.id);

if (want('ingest')) {
  // Mail only: AI work on the new mail is the 'ai' workload.
  await call('PATCH', '/api/settings', { ai: { enabled: false } });
  const { ingestMessage, deleteMessages, recountFolder } = await import('../src/mail/store.js');
  // The mail of earlier runs goes first, so each run starts from the mailbox bench-lists.mjs made.
  const old = () => db.prepare("SELECT id FROM messages WHERE subject LIKE 'Bench newsletter %'").all().map((r) => r.id);
  deleteMessages(old());
  const { afterIngest } = await import('../src/mail/pipeline.js');
  const html = `<html><head><style>p{color:#333}</style></head><body>${'<div><p>Paragraph of a long newsletter with <b>bold</b>, <a href="https://x.example/a?b=c">links</a> and <img src="https://x.example/i.png"> images.</p></div>'.repeat(400)}</body></html>`;
  const raw = (i) => Buffer.from([`From: Sender ${i % 50} <s${i % 50}@news.example>`, 'To: u@example.org', `Subject: Bench newsletter ${i}`,
    `Message-ID: <bench-${Date.now()}-${i}@news.example>`, `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="b"', '', '--b', 'Content-Type: text/plain; charset=utf-8', '', 'Plain part '.repeat(800),
    '--b', 'Content-Type: text/html; charset=utf-8', '', html, '--b--', ''].join('\r\n'));
  const uid0 = (db.prepare('SELECT MAX(uid) AS u FROM messages WHERE folder_id = ?').get(inbox.id).u || 0) + 1;
  await measure(`ingest ${INGEST}`, async () => {
    for (let i = 0; i < INGEST; i += 25) {
      const ids = [];
      for (let j = i; j < Math.min(INGEST, i + 25); j++) ids.push((await ingestMessage({ account, folder: inbox, uid: uid0 + j, flags: [], raw: raw(j), internalDate: new Date() })).id);
      await afterIngest(account, inbox, ids, { initial: true });
    }
  });
  deleteMessages(old());
  recountFolder(inbox.id);
}

if (want('vectors')) {
  const { searchMemory, invalidate } = await import('../src/ai/memory.js');
  const dim = 768, model = 'bench:embed';
  const have = db.prepare('SELECT COUNT(*) AS n FROM memory WHERE user_id = 1 AND model = ?').get(model).n;
  if (have < CHUNKS) {
    const ins = db.prepare("INSERT INTO memory (user_id, kind, ref_id, chunk, owner, text, date, model, dim, vector, created_at) VALUES (1, 'message', ?, 0, 'a:1', 'chunk text', 0, ?, ?, ?, 0)");
    const v = new Float32Array(dim);
    db.transaction(() => {
      for (let i = have; i < CHUNKS; i++) {
        let n = 0;
        for (let j = 0; j < dim; j++) { v[j] = Math.random() - 0.5; n += v[j] * v[j]; }
        for (let j = 0; j < dim; j++) v[j] /= Math.sqrt(n);
        ins.run(String(i + 1), model, dim, Buffer.from(v.buffer.slice(0)));
      }
    })();
  }
  const q = Array.from({ length: dim }, () => Math.random() - 0.5);
  invalidate(1);
  await measure(`vector load+search ${CHUNKS}`, async () => { await searchMemory(1, q, model, { k: 20 }); });
  await measure('vector search x30', async () => {
    for (let i = 0; i < 30; i++) { await searchMemory(1, q, model, { k: 300, minScore: 0 }); await new Promise((r) => setTimeout(r, 20)); }
  });
}

if (want('ai')) {
  const { startQueue, enqueue } = await import('../src/ai/queue.js');
  await import('../src/ai/tasks.js');
  if (!db.prepare("SELECT 1 FROM ai_providers WHERE user_id = 1 AND type = 'mock'").get()) await call('POST', '/api/ai/providers', { type: 'mock', name: 'Mock' });
  await call('PATCH', '/api/settings', { ai: { enabled: true, autoAnalyze: false, embeddings: false } });
  db.prepare("UPDATE ai_jobs SET status = 'done' WHERE status != 'done'").run();
  const ids = db.prepare('SELECT id FROM messages WHERE folder_id = ? ORDER BY date DESC LIMIT ?').all(inbox.id, JOBS).map((r) => r.id);
  db.prepare(`DELETE FROM ai_insights WHERE message_id IN (${ids.join(',')})`).run();
  db.prepare(`DELETE FROM ai_jobs WHERE type = 'analyze' AND ref_id IN (${ids.map((i) => `'${i}'`).join(',')})`).run();
  startQueue();
  await measure(`ai analyze ${JOBS}`, async () => {
    for (const id of ids) enqueue(1, 'analyze', id, 50);
    const left = db.prepare("SELECT COUNT(*) AS n FROM ai_jobs WHERE type = 'analyze' AND status IN ('queued', 'running')");
    while (left.get().n) await new Promise((r) => setTimeout(r, 100));
  });
}

if (want('maintenance')) {
  const { purgeMemory, backfillAnalysis } = await import('../src/mail/pipeline.js');
  await measure('purge memory', async () => { await purgeMemory(); });
  await call('PATCH', '/api/settings', { ai: { enabled: true, autoAnalyze: true, embeddings: true, analyzeDays: 3650 } });
  await measure('backfill', async () => { await backfillAnalysis(1); });
  db.prepare("DELETE FROM ai_jobs WHERE status = 'queued'").run();
}

await app.close();
process.exit(0);
