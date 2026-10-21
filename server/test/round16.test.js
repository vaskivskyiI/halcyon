// Requested actions settled as "done" or "not doing it" (kept and searchable), and a check that every api.<method>()
// the web app calls exists in its API client (an api.put() call without a put method broke the Google setup).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r16-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';
const webSrc = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../web/src');

let app, base, cookie = '', db, uid, account, inbox;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
let seq = 0;
const add = (subject, action) => {
  const id = Number(db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, thread_id, subject, from_addr, to_json, cc_json, date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'a@x.example', '[]', '[]', ?, ?)`).run(uid, account.id, inbox.id, ++seq, `r16-${seq}@x`, `t${seq}`, subject, Date.now() - seq * 60e3, Date.now()).lastInsertRowid);
  db.prepare('INSERT INTO ai_insights (message_id, priority, needs_action, action_summary, created_at) VALUES (?, 50, 1, ?, ?)').run(id, action, Date.now());
  db.prepare('INSERT INTO messages_fts (rowid, subject, sender, recipients, body) VALUES (?, ?, ?, ?, ?)').run(id, subject, 'a@x.example', '', '');
  return id;
};

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

test('a requested action can be done or deliberately not done; both leave Action needed and stay recorded', async () => {
  const pay = add('Invoice 77', 'Pay invoice 77'), survey = add('Survey', 'Fill in the survey'), sign = add('Contract', 'Sign the contract');
  await api('POST', `/api/messages/${pay}/dismiss`, { resolution: 'done' });
  await api('POST', `/api/messages/${survey}/dismiss`, { resolution: 'skipped' });
  const open = (await api('GET', '/api/messages?view=needsaction&threads=0')).items.map((m) => m.id);
  assert.deepEqual(open, [sign]);
  const ins = (id) => api('GET', `/api/messages/${id}`).then((m) => m.insight);
  assert.equal((await ins(pay)).resolution, 'done');
  const s = await ins(survey);
  assert.equal(s.resolution, 'skipped'); assert.ok(s.resolvedAt);
  assert.equal((await ins(sign)).resolution, null);
  // Found again later.
  const search = async (q) => (await api('GET', `/api/messages?q=${encodeURIComponent(q)}&semantic=0`)).items.map((m) => m.id);
  assert.deepEqual(await search('is:skipped'), [survey]);
  assert.deepEqual(await search('is:done'), [pay]);
  // Undo puts it back.
  await api('POST', `/api/messages/${survey}/dismiss`, { dismissed: false });
  assert.equal((await ins(survey)).resolution, null);
  assert.ok((await api('GET', '/api/messages?view=needsaction&threads=0')).items.some((m) => m.id === survey));
});

test('every api.<method>() the web app calls exists in its API client', () => {
  const client = fs.readFileSync(path.join(webSrc, 'api.js'), 'utf8');
  const block = client.slice(client.indexOf('export const api = {'), client.indexOf('};', client.indexOf('export const api = {')));
  const methods = new Set([...block.matchAll(/^\s+(\w+):/gm)].map((x) => x[1]));
  const used = new Map();
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(jsx?|mjs)$/.test(f.name)) for (const x of fs.readFileSync(p, 'utf8').matchAll(/\bapi\.(\w+)\(/g)) used.set(x[1], path.relative(webSrc, p));
    }
  };
  walk(webSrc);
  for (const [m, file] of used) assert.ok(methods.has(m), `api.${m}() is used in ${file} but not defined in api.js`);
  assert.ok(methods.has('put'));
});

test('every test file is run by an npm script (new tests are not left out of CI)', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)));
  const scripts = JSON.parse(fs.readFileSync(path.join(dir, '../package.json'), 'utf8')).scripts;
  const listed = `${scripts.test} ${scripts['test:servers']}`;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.test.js'))) assert.ok(listed.includes(`test/${f}`), `${f} is not in "test" or "test:servers"`);
});
