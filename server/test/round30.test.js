// The user's own categories: described in words (the AI sorts new and past mail into them) or a saved search;
// hand-made changes win.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r30-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, uid, studio, priv, inbox, privInbox, n = 0;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
const add = (acc, folder, subject, body) => {
  const id = Number(db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, thread_id, subject, from_name, from_addr, to_json, cc_json, date, body_text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '', 'client@x.example', '[]', '[]', ?, ?, ?)`).run(uid, acc.id, folder.id, ++n, `r30-${n}@x`, `t${n}`, subject, Date.now() - n * 3600e3, body, Date.now()).lastInsertRowid);
  db.prepare('INSERT INTO messages_fts (rowid, subject, sender, recipients, body) VALUES (?, ?, ?, ?, ?)').run(id, subject, 'client@x.example', '', body);
  return id;
};
const view = async (id) => (await api('GET', `/api/messages?view=mycat&customId=${id}&threads=0`)).items.map((m) => m.id).sort((a, b) => a - b);

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  await api('PATCH', '/api/settings', { ai: { autoAnalyze: false, embeddings: false } });
  await api('POST', '/api/ai/providers', { type: 'mock', name: 'Mock' });
  const acc = (email) => db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare('INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, ?, 0, ?)').run(uid, email, Date.now()).lastInsertRowid);
  studio = acc('info@studio.example'); priv = acc('me@home.example');
  const folder = (a) => db.prepare('SELECT * FROM folders WHERE id = ?').get(db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'INBOX', '\\Inbox')").run(a.id).lastInsertRowid);
  inbox = folder(studio); privInbox = folder(priv);
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

let giftId, v1, v2, other, privGift;
test('a described category: past mail is sorted into it by the AI, only in the chosen account', async () => {
  v1 = add(studio, inbox, 'Gift vouchers for Christmas', 'Hello, do you sell gift vouchers for a family shoot?');
  v2 = add(studio, inbox, 'Question', 'I received one of your gift vouchers, how do I book?');
  other = add(studio, inbox, 'Wedding in June', 'We would like to book a wedding shoot.');
  privGift = add(priv, privInbox, 'Gift vouchers sale', 'Shop: gift vouchers 20% off.');
  giftId = (await api('POST', '/api/custom-categories', { name: 'Gift vouchers', description: 'buying, redeeming or asking about gift vouchers', accountId: studio.id })).id;
  const { scanCategory } = await import('../src/ai/custom.js');
  await scanCategory(uid, giftId);
  assert.deepEqual(await view(giftId), [v1, v2].sort((a, b) => a - b));
  const cat = (await api('GET', '/api/folders')).custom.find((c) => c.id === giftId);
  assert.equal(cat.count, 2); assert.equal(cat.unread, 2);
});

test('new mail is sorted during its analysis; hand-made changes win and stay', async () => {
  const { analyzeMessage } = await import('../src/ai/tasks.js');
  const v3 = add(studio, inbox, 'Voucher', 'Can I extend my gift vouchers until summer?');
  await analyzeMessage(uid, v3, { interactive: true });
  assert.ok((await view(giftId)).includes(v3));
  // Taken out by hand: not added again by the next analysis.
  await api('POST', `/api/custom-categories/${giftId}/tag`, { ids: [v3], value: false });
  await analyzeMessage(uid, v3, { interactive: true });
  assert.ok(!(await view(giftId)).includes(v3));
  // Added by hand.
  await api('POST', `/api/custom-categories/${giftId}/tag`, { ids: [other], value: true });
  assert.ok((await view(giftId)).includes(other));
});

test('a saved-search category, and editing / deleting', async () => {
  const w = (await api('POST', '/api/custom-categories', { name: 'Weddings', query: 'wedding' })).id;
  assert.deepEqual(await view(w), [other]);
  await assert.rejects(api('POST', '/api/custom-categories', { name: 'Empty' }), /Describe what belongs/);
  await api('PATCH', `/api/custom-categories/${w}`, { name: 'Weddings', query: 'wedding OR june' });
  await api('DELETE', `/api/custom-categories/${w}`);
  assert.ok(!(await api('GET', '/api/custom-categories')).some((c) => c.id === w));
});
