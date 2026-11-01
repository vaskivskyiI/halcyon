// The daily brief's points: each says which emails, events and tasks it is about; a point can be set aside (and stays
// out of the next rewrite) or settled; Home shows the brief; with Inkwell, Home shows its recent pages.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r70-test-'));
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, uid, account, inbox, n = 0;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
const add = (subject, from) => Number(db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, thread_id, subject, from_name, from_addr, to_json, cc_json, date, body_text, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, '[]', '[]', ?, 'Hello', ?)`).run(uid, account, inbox, ++n, `r70-${n}@x`, `t${n}`, subject, from, Date.now() - 3600e3, Date.now()).lastInsertRowid);

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
  account = Number(db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, 'me@example.org', 0, ?)").run(uid, Date.now()).lastInsertRowid);
  inbox = Number(db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'INBOX', '\\Inbox')").run(account).lastInsertRowid);
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('brief points name their emails and tasks, and can be set aside or settled', async () => {
  const budget = add('Budget', 'ana@x.example');
  const trip = add('Trip', 'bob@x.example');
  await api('POST', '/api/tasks', { title: 'Book rooms' });
  const b = await api('GET', '/api/ai/brief?refresh=1');
  assert.match(b.items.overview, /2 recent emails/);
  const p = b.items.headsUp.find((x) => x.text === 'About Budget');
  assert.deepEqual(p.emails.map((m) => [m.id, m.from, m.subject, m.handled]), [[budget, 'ana@x.example', 'Budget', false]]);
  assert.equal(p.task, 'Answer ana@x.example');
  assert.equal(b.items.fyi[0].tasks[0].title, 'Book rooms');
  assert.match(b.content, new RegExp(`About Budget \\[open\\]\\(msg:${budget}\\)`), 'Markdown for assistants keeps the links');

  // Ignore: gone now, and the rewrite is told to leave it out.
  await api('POST', '/api/ai/brief/ignore', { day: b.key, key: p.key });
  assert.ok(!(await api('GET', '/api/ai/brief')).items.headsUp.some((x) => x.key === p.key));
  const again = await api('GET', '/api/ai/brief?refresh=1');
  assert.deepEqual(again.items.headsUp.map((x) => x.text), ['About Trip']);
  await api('POST', '/api/ai/brief/ignore', { day: b.key, key: p.key, ignored: false });
  assert.ok((await api('GET', '/api/ai/brief')).items.headsUp.length === 1, 'back, though the rewrite left it out');

  // Settled emails show as handled.
  db.prepare("INSERT INTO ai_insights (message_id, summary) VALUES (?, 'x')").run(trip);
  await api('POST', `/api/messages/${trip}/dismiss`, {});
  assert.equal((await api('GET', '/api/ai/brief')).items.headsUp[0].emails[0].handled, true);
});

test('Home has the brief and the open items; ids from elsewhere never resolve', async () => {
  const today = await api('GET', '/api/ai/today');
  assert.ok(today.brief.items.headsUp.length > 0);
  assert.ok(Array.isArray(today.actions) && Array.isArray(today.awaiting));
  const { briefOut } = await import('../src/ai/tasks.js');
  const other = Number(db.prepare("INSERT INTO users (email, name, password_hash, created_at) VALUES ('x@y.example', 'X', 'x', 0)").run().lastInsertRowid);
  const out = briefOut(other, { content_json: JSON.stringify({ overview: 'o', headsUp: [{ text: 't', emails: [1, 2] }], fyi: [] }), ignored_json: '[]' });
  assert.deepEqual(out.items.headsUp[0].emails, []);
  assert.equal(briefOut(uid, { content_json: '# Old brief\n- text', ignored_json: '[]' }).items, null, 'an older Markdown brief is shown as it is');
});

test('Home with Inkwell: recent pages come from Inkwell; without it, nothing', async () => {
  assert.deepEqual(await api('GET', '/api/integrations/inkwell/home'), { url: null, recent: [] });
  const ink = (await import('node:http')).createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer ink_test') { res.statusCode = 401; return res.end('{}'); }
    if (req.url.startsWith('/api/recent')) return res.end(JSON.stringify([{ id: 'p1', title: 'Lab notes', icon: '🧪', kind: 'page', updatedAt: 5, snippet: 'Samples' }]));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => ink.listen(0, '127.0.0.1', r));
  await api('PUT', '/api/integrations/inkwell', { url: `http://127.0.0.1:${ink.address().port}`, token: 'ink_test' });
  const h = await api('GET', '/api/integrations/inkwell/home?limit=3');
  assert.deepEqual(h.recent.map((x) => [x.id, x.title, x.icon, x.url]), [['p1', 'Lab notes', '🧪', `http://127.0.0.1:${ink.address().port}/#/n/p1`]]);
  await api('PUT', '/api/integrations/inkwell', { url: `http://127.0.0.1:${ink.address().port}`, token: 'ink_wrong' });
  assert.match((await api('GET', '/api/integrations/inkwell/home')).error, /did not accept the token/);
  ink.close();
});
