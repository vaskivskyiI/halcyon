// Nothing lost or stuck: unreadable mail is stored anyway, failed sends show; fewer made-up "forward" suggestions;
// topics with something coming up first.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r29-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
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
const add = (o) => {
  const id = Number(db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, thread_id, subject, from_name, from_addr, to_json, cc_json, date, body_text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, '[]', '[]', ?, ?, ?)`).run(uid, account.id, inbox.id, ++n, `r29-${n}@x`, o.thread || `t${n}`, o.subject, o.from || 'ana@x.example', Date.now() - (o.ageH || 1) * 3600e3, o.body || '', Date.now()).lastInsertRowid);
  if (o.topic) db.prepare("INSERT INTO ai_insights (message_id, summary, priority, category, topic, model, created_at) VALUES (?, '', 60, 'work', ?, 'mock', ?)").run(id, o.topic, Date.now());
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
  await api('PATCH', '/api/settings', { ai: { autoAnalyze: false } });
  account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, 'me@example.org', 0, ?)").run(uid, Date.now()).lastInsertRowid);
  inbox = db.prepare('SELECT * FROM folders WHERE id = ?').get(db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'INBOX', '\\Inbox')").run(account.id).lastInsertRowid);
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('a message that cannot be parsed is stored with what can be read, not dropped', async () => {
  const { fallbackParse, ingestMessage } = await import('../src/mail/store.js');
  const raw = Buffer.from('Message-ID: <broken@x>\r\nFrom: "Ana" <ana@x.example>\r\nSubject: Contract\r\nDate: Mon, 19 Oct 2026 10:00:00 +0200\r\n\r\n\u0000\u0001 garbage');
  const p = fallbackParse(raw, new Error('bad MIME'));
  assert.equal(p.subject, 'Contract'); assert.equal(p.from.value[0].address, 'ana@x.example'); assert.match(p.text, /could not be read completely/);
  // ingestMessage stores even an unparseable message (fallback), keeping the original for download.
  const r = await ingestMessage({ account, folder: inbox, uid: 999, flags: [], raw: Buffer.from('From: x@y.example\r\nSubject: ok\r\n\r\nhello') });
  assert.ok(r.id);
});

test('the Outbox count knows about messages that could not be sent', async () => {
  db.prepare("INSERT INTO outbox (user_id, account_id, payload_json, send_at, status, error, attempts, created_at) VALUES (?, ?, '{\"subject\":\"Hi\"}', ?, 'failed', '550 no such user', 5, ?)").run(uid, account.id, Date.now(), Date.now());
  const c = (await api('GET', '/api/folders')).counts;
  assert.equal(c.scheduled, 1); assert.equal(c.outboxFailed, 1);
});

test('"forward the earlier email" only when the email really asks for it, and never for automated mail', async () => {
  const { checkRequests } = await import('../src/ai/verify.js');
  const ask = { subject: 'Report', from_addr: 'ana@x.example', body_text: 'Hi, could you forward me the signed report from last week? Thanks' };
  assert.equal(checkRequests(ask, [{ description: 'report', quote: 'could you forward me the signed report from last week?' }]).length, 1);
  assert.equal(checkRequests(ask, [{ description: 'report', quote: 'Please send the invoice to accounting.' }]).length, 0, 'quote not in the email');
  assert.equal(checkRequests({ ...ask, body_text: 'The signed report is attached.' }, [{ description: 'report', quote: 'The signed report is attached.' }]).length, 0, 'no request to send');
  assert.equal(checkRequests({ ...ask, from_addr: 'noreply@shop.example' }, [{ description: 'x', quote: 'could you forward me the signed report from last week?' }]).length, 0);
  assert.equal(checkRequests({ subject: 'Poročilo', from_addr: 'jana@x.si', body_text: 'Prosim, pošlji mi poročilo za september.' }, [{ quote: 'Prosim, pošlji mi poročilo za september.' }]).length, 1, 'Slovenian');
});

test('topics with a task or event coming up soon are listed first, then the most recent', async () => {
  add({ subject: 'Old project 1', topic: 'Old project', ageH: 48 }); add({ subject: 'Old project 2', topic: 'Old project', ageH: 47 });
  add({ subject: 'Recent 1', topic: 'Recent topic', ageH: 2 }); add({ subject: 'Recent 2', topic: 'Recent topic', ageH: 1 });
  const a = add({ subject: 'Shoot 1', topic: 'Wedding shoot', ageH: 100 }); add({ subject: 'Shoot 2', topic: 'Wedding shoot', ageH: 99 });
  db.prepare('INSERT INTO tasks (user_id, title, due, source_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(uid, 'Prepare gear', Date.now() + 2 * 864e5, a, Date.now(), Date.now());
  const topics = (await api('GET', '/api/folders')).topics.map((t) => t.name);
  assert.deepEqual(topics.slice(0, 3), ['Wedding shoot', 'Recent topic', 'Old project']);
});
