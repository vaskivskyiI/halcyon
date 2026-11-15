// Search in one folder or one mailbox instead of everywhere, and a conversation put into a topic by hand (dragged
// onto it in the sidebar).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r93-test-'));
process.env.HALCYON_LOG_LEVEL = 'error';
process.env.HALCYON_DEMO = '1';

let app, base, cookie = '', db, uid, ingestMessage, n = 0;
const accounts = [], folders = {};
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
async function arrive(account, folder, subject, thread = '') {
  const raw = `Message-ID: <r93-${++n}@x>\r\n${thread ? `In-Reply-To: <${thread}>\r\nReferences: <${thread}>\r\n` : ''}From: <someone@example.com>\r\nTo: ${account.email}\r\nSubject: ${subject}\r\nDate: ${new Date(Date.now() - 600e3 + n * 1000).toUTCString()}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nAbout the harbour budget.\r\n`;
  return (await ingestMessage({ account, folder, uid: n, flags: [], raw: Buffer.from(raw) })).id;
}

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  ({ ingestMessage } = await import('../src/mail/store.js'));
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  for (const email of ['me@example.org', 'work@example.org']) {
    const a = db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare('INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, ?, 0, ?)').run(uid, email, Date.now()).lastInsertRowid);
    accounts.push(a);
    for (const [name, special] of [['INBOX', '\\Inbox'], ['Projects', null]]) {
      folders[`${email}/${name}`] = db.prepare('SELECT * FROM folders WHERE id = ?').get(db.prepare('INSERT INTO folders (account_id, path, name, special_use) VALUES (?, ?, ?, ?)').run(a.id, name, name, special).lastInsertRowid);
    }
  }
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('a search can stay in one folder or one mailbox', async () => {
  const [me, work] = accounts;
  const inMe = await arrive(me, folders['me@example.org/INBOX'], 'Harbour plan A');
  const inMeProjects = await arrive(me, folders['me@example.org/Projects'], 'Harbour plan B');
  const inWork = await arrive(work, folders['work@example.org/INBOX'], 'Harbour plan C');
  const ids = async (extra) => (await api('GET', `/api/messages?q=harbour&semantic=0&threads=0${extra}`)).items.map((m) => m.id).sort();
  assert.deepEqual(await ids(''), [inMe, inMeProjects, inWork].sort(), 'everywhere');
  assert.deepEqual(await ids(`&inFolder=${folders['me@example.org/Projects'].id}`), [inMeProjects], 'this folder');
  assert.deepEqual(await ids(`&inAccount=${me.id}`), [inMe, inMeProjects].sort(), 'this mailbox');
  assert.deepEqual(await ids(`&inAccount=${work.id}`), [inWork]);
  assert.deepEqual(await ids('&inFolder=999999'), [], 'a folder that is not the user\'s finds nothing');
});

test('a conversation dragged onto a topic joins it', async () => {
  const [me] = accounts;
  const first = await arrive(me, folders['me@example.org/INBOX'], 'Boat repair');
  const second = await arrive(me, folders['me@example.org/INBOX'], 'Re: Boat repair', `r93-${n}@x`);
  for (const id of [first, second]) db.prepare("INSERT INTO ai_insights (message_id, category, priority, topic, created_at) VALUES (?, 'work', 50, NULL, ?)").run(id, Date.now());
  const r = await api('POST', '/api/messages/topic', { ids: [second], threads: true, topic: 'Marina project' });
  assert.equal(r.changed, 2, 'the whole conversation');
  const topics = db.prepare('SELECT topic FROM ai_insights WHERE message_id IN (?, ?)').all(first, second).map((x) => x.topic);
  assert.deepEqual(topics, ['Marina project', 'Marina project']);
  const listed = await api('GET', `/api/messages?view=topic&topic=${encodeURIComponent('Marina project')}&threads=0`);
  assert.ok(listed.items.some((m) => m.id === second));
});
