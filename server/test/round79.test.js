// A file attached while shared mail is shown among one's own is uploaded as the person, but may be sent from the
// shared space's account (or the other way round): sending still finds it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r79-test-'));
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, db, cookie = '';
async function api(method, url, body, headers = {}) {
  const r = await fetch(base + url, { method, headers: { cookie, ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => null) };
}

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  await api('POST', '/api/auth/setup', { email: 'u@example.org', name: 'U', password: 'password123' });
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('an attachment uploaded as the person is sent from the shared space account, and the other way round', async () => {
  const { createShared } = await import('../src/shared.js');
  const { buildMime } = await import('../src/mail/send.js');
  const space = createShared(1, 'Team');
  const sid = space.id ?? db.prepare("SELECT id FROM users WHERE kind = 'shared'").get().id;
  const shared = db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, 'team@example.org', 0, 0)").run(sid).lastInsertRowid;
  const own = db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (1, 'u@example.org', 0, 0)").run().lastInsertRowid;
  const file = { filename: 'Paper.docx', contentType: 'application/octet-stream', contentBase64: Buffer.from('docx bytes').toString('base64') };
  const mine = (await api('POST', '/api/uploads', file)).data;
  const asSpace = (await api('POST', '/api/uploads', file, { 'x-halcyon-as': String(sid) })).data;
  for (const [accountId, up] of [[shared, mine], [own, asSpace]]) {
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    const raw = (await buildMime(account, { to: ['x@example.org'], subject: 'S', text: 't', attachments: [{ uploadId: up.uploadId, filename: 'Paper.docx' }] })).toString();
    assert.match(raw, /Paper\.docx/);
  }
  assert.equal((await api('GET', `/api/uploads/${mine.uploadId}`, null, { 'x-halcyon-as': String(sid) })).status, 200, 'the preview opens too');
  // Someone outside the space does not reach it.
  const other = db.prepare("INSERT INTO users (email, name, created_at) VALUES ('o@example.org', 'O', 0)").run().lastInsertRowid;
  const { readUpload } = await import('../src/mail/uploads.js');
  assert.equal(readUpload(other, mine.uploadId), null);
});
