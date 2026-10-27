// Attachments of messages being written are uploaded once (drafts refer to them, nothing left out); flags changed
// here are not overwritten by a sync that started before.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r32-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, uid, account;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, 'me@example.org', 0, ?)").run(uid, Date.now()).lastInsertRowid);
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('a large attachment is uploaded once, kept in the draft, downloadable and sent', async () => {
  const big = Buffer.alloc(3 * 1024 * 1024, 7);
  const up = await api('POST', '/api/uploads', { filename: 'scan.pdf', contentType: 'application/pdf', contentBase64: big.toString('base64') });
  assert.match(up.uploadId, /^[a-f0-9]{32}$/); assert.equal(up.size, big.length);
  const d = await api('POST', '/api/drafts', { accountId: account.id, to: [{ address: 'a@x.example' }], subject: 'Scan', html: '<p>x</p>', attachments: [{ uploadId: up.uploadId, filename: 'scan.pdf', contentType: 'application/pdf', size: up.size }] });
  const saved = (await api('GET', '/api/drafts')).find((x) => x.id === d.id);
  assert.equal(saved.attachments.length, 1, 'not left out of the draft');
  assert.ok(JSON.stringify(saved).length < 5000, 'the draft only refers to the file');
  const back = await api('GET', `/api/uploads/${up.uploadId}`);
  assert.equal(back.length, big.length);
  const { buildMime } = await import('../src/mail/send.js');
  const raw = await buildMime(account, { to: [{ address: 'a@x.example' }], subject: 'Scan', html: '<p>x</p>', attachments: [{ uploadId: up.uploadId, filename: 'scan.pdf' }] });
  assert.match(raw.toString('utf8', 0, 200000), /filename="?scan\.pdf/);
  // Someone else's id / a made-up id: not found.
  await assert.rejects(api('GET', '/api/uploads/00000000000000000000000000000000'), /404/);
});

test('uploads nothing refers to any more are cleaned up after two days; used ones stay', async () => {
  const { cleanUploads } = await import('../src/mail/uploads.js');
  const orphan = await api('POST', '/api/uploads', { filename: 'old.txt', contentBase64: Buffer.from('x').toString('base64') });
  const dir = path.join(dataDir, 'uploads', String(uid));
  const old = (Date.now() - 3 * 864e5) / 1000;
  for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), old, old);
  cleanUploads();
  assert.ok(!fs.existsSync(path.join(dir, `${orphan.uploadId}.bin`)), 'orphan removed');
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.bin')).length, 1, 'the draft\'s file stays');
});
