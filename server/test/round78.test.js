// List-Unsubscribe is stored from new mail (mailparser files it under 'list', so it was always empty before), mail
// stored earlier gets it filled in once from the originals, and the unsubscribe button works from the stored value.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r78-test-'));
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, db, cookie = '', account, inbox;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => null) };
}
const mail = (n, extra = []) => Buffer.from([`From: News <news@shop.example>`, 'To: u@example.org', `Subject: Deals ${n}`, `Message-ID: <r78-${n}@shop.example>`,
  'Date: Mon, 1 Jan 2029 10:00:00 +0000', ...extra, 'Content-Type: text/plain', '', 'Big sale.', ''].join('\r\n'));

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  await api('POST', '/api/auth/setup', { email: 'u@example.org', name: 'U', password: 'password123' });
  const acc = db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (1, 'u@example.org', 0, 0)").run().lastInsertRowid;
  db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'INBOX', '\Inbox')").run(acc);
  account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(acc);
  inbox = db.prepare('SELECT * FROM folders WHERE account_id = ?').get(acc);
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('new mail keeps its List-Unsubscribe header and the unsubscribe button uses it', async () => {
  const { ingestMessage } = await import('../src/mail/store.js');
  const { id } = await ingestMessage({ account, folder: inbox, uid: 1, flags: [], internalDate: new Date(),
    raw: mail(1, ['List-Id: Deals <deals.shop.example>', 'List-Unsubscribe: <https://shop.example/u?x=1>,', ' <mailto:unsub@shop.example?subject=stop>']) });
  const m = db.prepare('SELECT list_unsubscribe FROM messages WHERE id = ?').get(id);
  assert.equal(m.list_unsubscribe, '<https://shop.example/u?x=1>, <mailto:unsub@shop.example?subject=stop>');
  assert.equal((await api('GET', `/api/messages/${id}`)).data.listUnsubscribe, m.list_unsubscribe);
  // No one-click header: the mailto address is used (https without one-click needs the browser).
  const r = await api('POST', `/api/messages/${id}/unsubscribe`);
  assert.deepEqual(r.data, { ok: true, method: 'mailto' });
  const out = db.prepare('SELECT payload_json FROM outbox ORDER BY id DESC').get();
  assert.deepEqual([JSON.parse(out.payload_json).to, JSON.parse(out.payload_json).subject], [['unsub@shop.example'], 'stop']);
  // Plain mail has none, and no button.
  const plain = await ingestMessage({ account, folder: inbox, uid: 2, flags: [], internalDate: new Date(), raw: mail(2) });
  assert.equal(db.prepare('SELECT list_unsubscribe FROM messages WHERE id = ?').get(plain.id).list_unsubscribe, null);
  assert.equal((await api('POST', `/api/messages/${plain.id}/unsubscribe`)).status, 400);
});

test('a list Sender is not shown as acting for the From address', async () => {
  const { ingestMessage } = await import('../src/mail/store.js');
  const { id } = await ingestMessage({ account, folder: inbox, uid: 3, flags: [], internalDate: new Date(),
    raw: mail(3, ['Sender: Deals <deals@lists.shop.example>', 'List-Id: <deals.shop.example>']) });
  assert.ok(!db.prepare('SELECT sender_json FROM messages WHERE id = ?').get(id).sender_json);
});

test('mail stored before the fix gets List-Unsubscribe filled in once, from the original', async () => {
  const { ingestMessage } = await import('../src/mail/store.js');
  const { backfillUnsubscribe } = await import('../src/mail/pipeline.js');
  const old = await ingestMessage({ account, folder: inbox, uid: 4, flags: [], internalDate: new Date(), raw: mail(4, ['List-Unsubscribe: <mailto:old@shop.example>']) });
  const gone = await ingestMessage({ account, folder: inbox, uid: 5, flags: [], internalDate: new Date(), raw: mail(5, ['List-Unsubscribe: <mailto:gone@shop.example>']) });
  db.prepare('UPDATE messages SET list_unsubscribe = NULL').run();
  db.prepare('UPDATE messages SET raw_path = ? WHERE id = ?').run(path.join(os.tmpdir(), 'halcyon-r78-missing.eml'), gone.id);
  assert.equal(await backfillUnsubscribe(), 2); // uid 1 and uid 4; uid 5's original is gone
  const value = (id) => db.prepare('SELECT list_unsubscribe FROM messages WHERE id = ?').get(id).list_unsubscribe;
  assert.equal(value(old.id), '<mailto:old@shop.example>');
  assert.equal(value(gone.id), null);
  assert.match(value(1), /unsub@shop\.example/);
  // Done once: a later run does not read the originals again.
  db.prepare('UPDATE messages SET list_unsubscribe = NULL WHERE id = ?').run(old.id);
  assert.equal(await backfillUnsubscribe(), 0);
  assert.equal(value(old.id), null);
});
