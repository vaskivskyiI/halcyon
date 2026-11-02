// Admin view of background work: what the server is doing right now (AI jobs, mail sync, scheduled work, slow
// requests, process load). Admins only; the AI queue can be paused and a stuck job cancelled.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r73-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, q, activity, db;
const jar = { a: {}, b: {} };
async function as(who, method, url, body) {
  const cookie = Object.entries(jar[who]).map(([k, v]) => `${k}=${v}`).join('; ');
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const c of r.headers.getSetCookie?.() || []) {
    const [kv] = c.split(';');
    const [k, v] = kv.split('=');
    jar[who][k] = v;
  }
  return { status: r.status, data: await r.json().catch(() => null) };
}
const ok = async (...a) => { const r = await as(...a); assert.ok(r.status < 300, `${a[1]} ${a[2]} → ${r.status} ${JSON.stringify(r.data)}`); return r.data; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  q = await import('../src/ai/queue.js');
  activity = await import('../src/util/activity.js');
  db = await import('../src/db/index.js');
  await ok('a', 'POST', '/api/auth/setup', { email: 'a@example.org', name: 'Ann', password: 'password123' });
  await ok('a', 'POST', '/api/admin/users', { email: 'b@example.org', name: 'Ben', password: 'password123' });
  await ok('b', 'POST', '/api/auth/login', { email: 'b@example.org', password: 'password123' });
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('only an administrator sees server activity or changes the queue', async () => {
  assert.equal((await as('b', 'GET', '/api/admin/activity')).status, 403);
  assert.equal((await as('b', 'POST', '/api/admin/activity/ai-queue', { paused: true })).status, 403);
  assert.equal((await as('b', 'POST', '/api/admin/activity/ai-jobs/1/cancel', {})).status, 403);
  jar.c = {};
  assert.equal((await as('c', 'GET', '/api/admin/activity')).status, 401);
  assert.equal(q.queuePaused(), false);
});

test('the snapshot has process load, AI, mail, background work and slow requests', async () => {
  const d = await ok('a', 'GET', '/api/admin/activity');
  for (const k of ['cpuPercent', 'cpuUserPercent', 'uptimeSec']) assert.equal(typeof d.process[k], 'number', k);
  for (const k of ['utilisation', 'delayMeanMs', 'delayP99Ms', 'delayMaxMs']) assert.equal(typeof d.process.eventLoop[k], 'number', k);
  assert.ok(d.process.memoryMb.rss > 0);
  assert.equal(d.ai.paused, false);
  for (const k of ['active', 'queued', 'counts', 'calls']) assert.ok(Array.isArray(d.ai[k]), k);
  for (const k of ['mail', 'dav', 'work', 'totals', 'slowWork', 'slowRequests', 'archives']) assert.ok(Array.isArray(d[k]), k);
});

test('running work, its totals and slow work are tracked', async () => {
  const end = activity.track('scheduled', 'Test job', { accountId: 7 });
  let d = await ok('a', 'GET', '/api/admin/activity');
  const w = d.work.find((x) => x.label === 'Test job');
  assert.ok(w && w.kind === 'scheduled' && w.meta.accountId === 7 && w.ms >= 0);
  end(); end();
  await activity.tracked('parse', 'Slow test', null, () => sleep(1050));
  d = await ok('a', 'GET', '/api/admin/activity');
  assert.ok(!d.work.some((x) => x.label === 'Test job'));
  assert.equal(d.totals.find((t) => t.label === 'Test job').runs, 1);
  assert.ok(d.slowWork.some((x) => x.label === 'Slow test' && x.ms >= 1000));
});

test('slow request recording keeps the route pattern', () => {
  activity.recordRequest({ method: 'GET', url: '/api/x/5?y=1', routeOptions: { url: '/api/x/:id' }, user: { id: 1 } }, 200, 900);
  activity.recordRequest({ method: 'GET', url: '/api/fast', routeOptions: { url: '/api/fast' } }, 200, 20);
  const s = activity.activitySnapshot().slowRequests;
  assert.equal(s[0].route, '/api/x/:id');
  assert.equal(s[0].ms, 900);
  assert.ok(!s.some((r) => r.route === '/api/fast'));
});

test('a running AI job shows its provider call; pausing holds new jobs; cancelling frees a stuck one', async () => {
  const uid = db.get("SELECT id FROM users WHERE email = 'a@example.org'").id;
  let release;
  q.registerHandler('test-stuck', async () => {
    const done = q.noteCall('ollama', 'test-model', 'background');
    await new Promise((r) => { release = r; });
    done();
  });
  q.registerHandler('test-quick', async () => {});

  await ok('a', 'POST', '/api/admin/activity/ai-queue', { paused: true });
  q.enqueue(uid, 'test-quick', 'q1', 10);
  await sleep(200);
  assert.equal(db.get("SELECT status FROM ai_jobs WHERE type = 'test-quick'").status, 'queued');
  let d = await ok('a', 'GET', '/api/admin/activity');
  assert.equal(d.ai.paused, true);
  assert.ok(d.ai.queued.some((j) => j.type === 'test-quick' && j.user === 'a@example.org' && j.due));

  q.enqueue(uid, 'test-stuck', 's1', 99);
  await ok('a', 'POST', '/api/admin/activity/ai-queue', { paused: false });
  await sleep(300);
  d = await ok('a', 'GET', '/api/admin/activity');
  const job = d.ai.active.find((j) => j.type === 'test-stuck');
  assert.ok(job, JSON.stringify(d.ai.active));
  assert.equal(job.refId, 's1');
  assert.equal(job.user, 'a@example.org');
  assert.deepEqual(job.calls.map((c) => `${c.provider}:${c.model}`), ['ollama:test-model']);
  assert.equal(db.get("SELECT status FROM ai_jobs WHERE type = 'test-quick'").status, 'done');

  const before = d.ai.running;
  await ok('a', 'POST', `/api/admin/activity/ai-jobs/${job.id}/cancel`, {});
  d = await ok('a', 'GET', '/api/admin/activity');
  assert.ok(!d.ai.active.some((j) => j.id === job.id));
  assert.equal(d.ai.running, before - 1);
  assert.equal(db.get('SELECT status, error FROM ai_jobs WHERE id = ?', job.id).status, 'failed');
  // The handler finishing later changes nothing.
  release();
  await sleep(100);
  assert.equal(db.get('SELECT status FROM ai_jobs WHERE id = ?', job.id).status, 'failed');
  assert.equal((await ok('a', 'GET', '/api/admin/activity')).ai.running, before - 1);
  assert.equal((await as('a', 'POST', `/api/admin/activity/ai-jobs/${job.id}/cancel`, {})).status, 404);
});
