// Always in Focused: conversations the user started or replied to, and senders on the Focused list — learned from the
// people the user writes to, tuned by the user (taken out stays out).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r82-test-'));
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, db, cookie = '', acc, inbox, sent, n = 0;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => null) };
}
const add = ({ folder = inbox, thread = null, from = 'a@x.example', to = [], answered = 0, priority = 10, category = 'newsletter' }) => {
  n++;
  const id = Number(db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, thread_id, subject, from_addr, to_json, cc_json, date, is_read, is_answered, created_at)
    VALUES (1, ?, ?, ?, ?, ?, 'S', ?, ?, '[]', ?, 0, ?, 0)`).run(acc, folder, n, `m${n}@x`, thread, from, JSON.stringify(to.map((address) => ({ address }))), Date.now() - 1000 + n, answered).lastInsertRowid);
  if (folder === inbox) db.prepare('INSERT INTO ai_insights (message_id, summary, category, priority) VALUES (?, ?, ?, ?)').run(id, 's', category, priority);
  return id;
};
const focused = async () => (await api('GET', '/api/messages?view=unified&filter=focused&threads=0')).data.items.map((m) => m.id);

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  await api('POST', '/api/auth/setup', { email: 'u@example.org', name: 'U', password: 'password123' });
  acc = db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (1, 'u@example.org', 0, 0)").run().lastInsertRowid;
  inbox = db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'INBOX', '\\Inbox')").run(acc).lastInsertRowid;
  sent = db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'Sent', 'Sent', '\\Sent')").run(acc).lastInsertRowid;
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('conversations the user started or replied to are in Focused', async () => {
  const noise = add({ thread: 'n1' });
  add({ folder: sent, thread: 't-mine', from: 'u@example.org', to: ['b@y.example'] });
  const reply = add({ thread: 't-mine', from: 'b@y.example' });
  const answered = add({ thread: 't-answered', answered: 1 });
  const f = await focused();
  assert.ok(f.includes(reply), 'a reply in a conversation I started');
  assert.ok(f.includes(answered), 'a message I answered (elsewhere too)');
  assert.ok(!f.includes(noise));
});

test('senders on the Focused list: learned from whom I write to, added, taken out for good', async () => {
  for (let i = 0; i < 2; i++) add({ folder: sent, from: 'u@example.org', to: ['friend@z.example', 'noreply@shop.example'] });
  add({ folder: sent, from: 'u@example.org', to: ['once@z.example'] });
  const list = (await api('GET', '/api/focus-senders')).data;
  const auto = list.filter((r) => r.auto).map((r) => r.address);
  assert.ok(auto.includes('friend@z.example') && auto.includes('b@y.example') === false, 'written to twice: learned');
  assert.ok(!auto.includes('noreply@shop.example') && !auto.includes('once@z.example') && !auto.includes('u@example.org'));

  const fromFriend = add({ from: 'Friend@Z.example' });
  const fromDomain = add({ from: 'boss@corp.example' });
  assert.ok((await focused()).includes(fromFriend), 'learned sender (any case) in Focused');
  assert.ok(!(await focused()).includes(fromDomain));
  assert.equal((await api('POST', '/api/focus-senders', { address: '@Corp.example' })).status, 200);
  assert.ok((await focused()).includes(fromDomain), 'a whole domain added by the user');
  assert.equal((await api('POST', '/api/focus-senders', { address: 'not an address' })).status, 400);

  await api('POST', '/api/focus-senders', { address: 'friend@z.example', focused: false });
  assert.ok(!(await focused()).includes(fromFriend), 'taken out');
  (await import('../src/focus.js')).learnFocusSenders(1);
  const again = (await api('GET', '/api/focus-senders')).data.find((r) => r.address === 'friend@z.example');
  assert.equal(again.focused, false, 'learning again does not bring it back');
  add({ from: 'boss@corp.example' });
  assert.equal((await api('GET', '/api/senders')).data.find((x) => x.address === 'boss@corp.example')?.focused, true, 'the Senders page shows it');
  assert.equal((await api('DELETE', '/api/focus-senders?address=%40corp.example')).data.removed, 1);
  assert.ok(!(await focused()).includes(fromDomain));
});
