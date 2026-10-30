// Archives: import (MBOX, ZIP of EML), move mail into an archive (copied, checked, mailbox copy to Trash), export as
// a ZIP of EML files and import it back; nothing done to an archive reaches a mail server; moves between accounts
// delete the source only after the copy is on the target server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r38-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, uid, account, account2, inbox, inbox2, store, n = 0;
async function api(method, url, body, headers = {}) {
  const raw = Buffer.isBuffer(body);
  const r = await fetch(base + url, { method, headers: { cookie, ...(body === undefined ? {} : { 'content-type': raw ? 'application/octet-stream' : 'application/json' }), ...headers }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
const eml = (o) => Buffer.from([`From: ${o.from || 'Ana <ana@x.example>'}`, 'To: me@example.org', `Subject: ${o.subject}`, `Date: ${new Date(o.date || Date.now()).toUTCString()}`,
  `Message-ID: <${o.id || `r38-${++n}@x`}>`, 'Content-Type: text/plain; charset=utf-8', ...(o.status ? [`Status: ${o.status}`] : []), '', o.body || 'Hello', ''].join('\r\n'));
const ingest = async (acc, folder, o) => (await store.ingestMessage({ account: acc, folder, uid: ++n, flags: o.flags || [], raw: eml(o) })).id;
const waitJobs = async () => {
  for (let i = 0; i < 100; i++) {
    const jobs = await api('GET', '/api/archives/jobs');
    if (!jobs.some((j) => ['queued', 'running'].includes(j.status))) return jobs;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('jobs did not finish');
};

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  store = await import('../src/mail/store.js');
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  await api('PATCH', '/api/settings', { ai: { autoAnalyze: false, embeddings: false } });
  const acc = (email) => db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare('INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, ?, 0, ?)').run(uid, email, Date.now()).lastInsertRowid);
  account = acc('me@example.org'); account2 = acc('me2@example.org');
  const folder = (a, p, s) => db.prepare('SELECT * FROM folders WHERE id = ?').get(db.prepare('INSERT INTO folders (account_id, path, name, special_use) VALUES (?, ?, ?, ?)').run(a.id, p, p, s).lastInsertRowid);
  inbox = folder(account, 'INBOX', '\\Inbox'); folder(account, 'Trash', '\\Trash'); inbox2 = folder(account2, 'INBOX', '\\Inbox');
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('an MBOX file is imported into an archive folder (flags, escaped lines); importing it again adds nothing', async () => {
  const { id } = await api('POST', '/api/archives', { name: 'Old mail' });
  const mbox = Buffer.concat([
    Buffer.from('From ana@x.example Mon Jan  1 10:00:00 2018\n'), eml({ subject: 'Budget 2018', status: 'RO', body: 'Line one\n>From the start, we agreed.' }),
    Buffer.from('\nFrom bob@x.example Tue Jan  2 10:00:00 2018\n'), eml({ subject: 'Party', from: 'Bob <bob@x.example>' }),
    Buffer.from('\nFrom cid@x.example Wed Jan  3 10:00:00 2018\n'), eml({ subject: 'Invoice', from: 'Cid <cid@x.example>', status: 'O' }), Buffer.from('\n'),
  ]);
  await api('POST', `/api/archives/${id}/import?filename=${encodeURIComponent('2018 mail.mbox')}`, mbox);
  let [job] = await waitJobs();
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.done, 3);
  const list = await api('GET', '/api/archives');
  const ar = list.archives.find((a) => a.id === id);
  assert.deepEqual(ar.folders.map((f) => [f.path, f.total]), [['2018 mail', 3]]);
  const rows = db.prepare('SELECT subject, is_read, body_text, ai_status FROM messages WHERE account_id = ? ORDER BY subject').all(id);
  assert.deepEqual(rows.map((r) => [r.subject, r.is_read]), [['Budget 2018', 1], ['Invoice', 0], ['Party', 0]]);
  assert.match(rows[0].body_text, /^From the start/m, 'mboxrd escaping undone');
  assert.ok(rows.every((r) => r.ai_status === 'none'), 'archived mail is not sent to the AI');
  await api('POST', `/api/archives/${id}/import?filename=${encodeURIComponent('2018 mail.mbox')}`, mbox);
  [job] = await waitJobs();
  assert.deepEqual([job.done, job.skipped], [0, 3]);
  // Searchable like any mail.
  const found = await api('GET', '/api/messages?q=Party&threads=0');
  assert.ok(found.items.some((m) => m.subject === 'Party'));
});

test('mail moved into an archive is copied and checked first, keeps its analysis, and the mailbox copy goes to Trash', async () => {
  const { id } = await api('POST', '/api/archives', { name: 'Archive 2025' });
  const a = await ingest(account, inbox, { subject: 'Contract signed', flags: ['\\Seen'] });
  const b = await ingest(account, inbox, { subject: 'Holiday plans' });
  db.prepare("INSERT INTO ai_insights (message_id, summary, priority, category, created_at) VALUES (?, 'Ana signed the contract', 60, 'work', ?)").run(a, Date.now());
  const task = db.prepare("INSERT INTO tasks (user_id, title, source_message_id, created_at, updated_at) VALUES (?, 'File the contract', ?, ?, ?)").run(uid, a, Date.now(), Date.now()).lastInsertRowid;
  await api('POST', `/api/archives/${id}/move`, { ids: [a, b] });
  const [job] = await waitJobs();
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.done, 2);
  const copies = db.prepare('SELECT m.id, m.subject, m.is_read, f.path FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.account_id = ? ORDER BY m.subject').all(id);
  assert.deepEqual(copies.map((c) => [c.subject, c.path, c.is_read]), [['Contract signed', 'Inbox', 1], ['Holiday plans', 'Inbox', 0]]);
  const copyA = copies[0].id;
  assert.equal(db.prepare('SELECT summary FROM ai_insights WHERE message_id = ?').get(copyA).summary, 'Ana signed the contract');
  assert.equal(db.prepare('SELECT source_message_id FROM tasks WHERE id = ?').get(task).source_message_id, copyA);
  // The originals: in the mailbox's Trash (to be moved there on the server), not deleted.
  const orig = db.prepare("SELECT f.special_use FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.id IN (?, ?)").all(a, b);
  assert.deepEqual(orig.map((o) => o.special_use), ['\\Trash', '\\Trash']);
  assert.ok(db.prepare("SELECT 1 FROM pending_ops WHERE account_id = ? AND op = 'move'").get(account.id));
  assert.ok(!db.prepare("SELECT 1 FROM pending_ops WHERE op = 'delete'").get(), 'nothing deleted on the server');

  // Whatever is done in the archive stays local: no server operation for it.
  await api('POST', '/api/messages/actions', { ids: [copyA], action: 'unread' });
  assert.ok(!db.prepare('SELECT 1 FROM pending_ops WHERE account_id = ?').get(id));
  await assert.rejects(api('POST', '/api/send', { accountId: id, to: [{ address: 'x@y.example' }], subject: 'x', html: 'x' }), /archive cannot send/);
});

test('export as a ZIP of .eml files (folders kept) and import it back', async () => {
  const src = (await api('GET', '/api/archives')).archives.find((x) => x.name === 'Old mail');
  const zip = await api('GET', `/api/archives/export?archiveId=${src.id}`);
  assert.equal(zip.subarray(0, 4).toString('hex'), '504b0304');
  const { zipEntries } = await import('../src/util/zip.js');
  const f = path.join(dataDir, 'x.zip'); fs.writeFileSync(f, zip);
  const entries = zipEntries(f);
  assert.deepEqual(entries.map((e) => e.name.replace(/^.*\d{4} /, '')).sort(), ['Budget 2018.eml', 'Invoice.eml', 'Party.eml']);
  assert.ok(entries.every((e) => e.name.startsWith('2018 mail/')));
  assert.match(entries[0].read().toString(), /^From: /m);
  entries.close();
  const { id } = await api('POST', '/api/archives', { name: 'Copy' });
  await api('POST', `/api/archives/${id}/import?filename=old.zip`, zip);
  const [job] = await waitJobs();
  assert.equal(job.done, 3, job.error);
  assert.deepEqual((await api('GET', '/api/archives')).archives.find((x) => x.id === id).folders.map((x) => [x.path, x.total]), [['2018 mail', 3]]);
});

test('a move between two mail accounts deletes the source only after the copy is on the target server', async () => {
  const m = await ingest(account, inbox, { subject: 'Move me' });
  await api('POST', '/api/messages/actions', { ids: [m], action: 'move', folderId: inbox2.id });
  const ops = db.prepare('SELECT account_id, op, payload_json FROM pending_ops WHERE op IN (?, ?)').all('append', 'delete');
  assert.deepEqual(ops.map((o) => [o.account_id, o.op]), [[account2.id, 'append']]);
  const then = JSON.parse(ops[0].payload_json).then;
  assert.equal(then.accountId, account.id); assert.equal(then.op, 'delete');
});

// An Outlook data file, when one is given (TEST_PST=/path/file.pst — not part of the repository).
test('an Outlook data file is imported with its folders', { skip: !process.env.TEST_PST }, async () => {
  const { id } = await api('POST', '/api/archives', { name: 'Outlook' });
  const file = fs.readFileSync(process.env.TEST_PST);
  // The server keeps answering while the file is read (in a worker thread): no long stall of the main thread.
  let last = Date.now(), worst = 0;
  const watch = setInterval(() => { const n = Date.now(); worst = Math.max(worst, n - last - 20); last = n; }, 20);
  await api('POST', `/api/archives/${id}/import?filename=${encodeURIComponent(path.basename(process.env.TEST_PST))}`, file);
  const jobs = await waitJobs();
  clearInterval(watch);
  assert.ok(worst < 1000, `the server stalled for ${worst} ms`);
  const job = jobs.find((j) => j.archiveId === id);
  assert.equal(job.status, 'done', job.error);
  const ar = (await api('GET', '/api/archives')).archives.find((x) => x.id === id);
  console.log(JSON.stringify({ job, folders: ar.folders.map((f) => `${f.path} (${f.total})`) }));
  assert.ok(job.done > 0);
  const sample = db.prepare("SELECT subject, from_addr, to_json, body_text, body_html, attachments_json, date FROM messages WHERE account_id = ? AND from_addr != '' LIMIT 3").all(id);
  console.log(JSON.stringify(sample.map((m) => ({ ...m, body_text: m.body_text?.slice(0, 80), body_html: !!m.body_html, date: new Date(m.date).toISOString() }))));
  assert.ok(sample.length);
  console.log(JSON.stringify(db.prepare('SELECT COUNT(*) AS n, SUM(has_attachments) AS att FROM messages WHERE account_id = ?').get(id)));
});

test('a large file is uploaded in pieces (whatever the proxy limit) and resumes after a lost answer', async () => {
  const { id } = await api('POST', '/api/archives', { name: 'Pieces' });
  const mbox = Buffer.concat([1, 2, 3].map((i) => Buffer.concat([Buffer.from(`From x@y Mon Jan  1 10:00:00 2018\n`), eml({ subject: `Piece mail ${i}`, id: `piece-${i}@x` }), Buffer.from('\n')])));
  const up = await api('POST', '/api/archives/uploads', { filename: 'pieces.mbox', size: mbox.length });
  const put = (offset, buf) => fetch(`${base}/api/archives/uploads/${up.id}?offset=${offset}`, { method: 'PUT', headers: { cookie, 'content-type': 'application/octet-stream' }, body: buf });
  const half = Math.floor(mbox.length / 2);
  assert.equal((await (await put(0, mbox.subarray(0, half))).json()).size, half);
  // The same piece sent again (its answer was lost): the server says where to continue.
  const again = await put(0, mbox.subarray(0, half));
  assert.equal(again.status, 409);
  assert.equal((await again.json()).size, half);
  await assert.rejects(api('POST', `/api/archives/${id}/import`, { uploadId: up.id }), /not complete/);
  assert.equal((await (await put(half, mbox.subarray(half))).json()).size, mbox.length);
  await api('POST', `/api/archives/${id}/import`, { uploadId: up.id });
  const jobs = await waitJobs();
  const job = jobs.find((j) => j.archiveId === id);
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.done, 3);
  // Someone else's upload is not reachable.
  await assert.rejects(api('GET', '/api/archives/uploads/000000000000000000000000'), /not found/i);
});

test('a file that is not an Outlook data file fails with a readable reason (no binary in the message)', async () => {
  const { id } = await api('POST', '/api/archives', { name: 'Broken' });
  const junk = Buffer.alloc(4096);
  const up = await api('POST', '/api/archives/uploads', { filename: 'broken.pst', size: junk.length });
  await fetch(`${base}/api/archives/uploads/${up.id}?offset=0`, { method: 'PUT', headers: { cookie, 'content-type': 'application/octet-stream' }, body: junk });
  assert.deepEqual(await api('GET', `/api/archives/uploads/${up.id}`), { id: up.id, size: 4096, total: 4096 }, 'where an upload stands (to continue it later)');
  await api('POST', `/api/archives/${id}/import`, { uploadId: up.id });
  const job = (await waitJobs()).find((j) => j.archiveId === id);
  assert.equal(job.status, 'failed');
  assert.match(job.error, /not an Outlook data file/);
  assert.doesNotMatch(job.error, /[\u0000-\u0008]/);
});

test('a second export adds only what the archive lacks, in any folder; two archives become one and nothing is lost', async () => {
  const one = (await api('POST', '/api/archives', { name: 'From Outlook' })).id, two = (await api('POST', '/api/archives', { name: 'From Gmail' })).id;
  const shared = eml({ id: 'both@x', subject: 'In both' }), only = eml({ id: 'only@x', subject: 'Only here' });
  await api('POST', `/api/archives/${one}/import?filename=a.eml&folder=Outlook`, shared);
  await waitJobs();
  const mbox = (...l) => Buffer.concat(l.flatMap((m) => [Buffer.from('From x@x.example Mon Jan  1 10:00:00 2018\n'), m, Buffer.from('\n')]));
  await api('POST', `/api/archives/${one}/import?filename=b.mbox&folder=Gmail`, mbox(shared, only));
  await waitJobs();
  const count = (id) => db.prepare('SELECT COUNT(*) AS n FROM messages WHERE account_id = ?').get(id).n;
  assert.equal(count(one), 2, 'the shared email is not imported again into the other folder');
  await api('POST', `/api/archives/${two}/import?filename=c.mbox&folder=Old`, mbox(shared, eml({ id: 'three@x', subject: 'Third' })));
  await waitJobs();
  const m3 = db.prepare("SELECT id FROM messages WHERE account_id = ? AND message_id = 'three@x'").get(two).id;
  const task = db.prepare("INSERT INTO tasks (user_id, title, source_message_id, created_at, updated_at) VALUES (?, 'T', ?, 0, 0)").run(uid, db.prepare("SELECT id FROM messages WHERE account_id = ? AND message_id = 'both@x'").get(two).id).lastInsertRowid;
  await assert.rejects(api('POST', `/api/archives/${one}/merge`, { fromId: one }), /404/);
  await api('POST', `/api/archives/${one}/merge`, { fromId: two });
  const jobs = await waitJobs();
  assert.deepEqual([jobs[0].type, jobs[0].status, jobs[0].skipped, jobs[0].failed], ['merge', 'done', 1, 0]);
  assert.equal(count(one), 3);
  assert.equal(db.prepare('SELECT 1 AS x FROM accounts WHERE id = ?').get(two), undefined, 'the empty archive is gone');
  assert.equal(db.prepare('SELECT 1 AS x FROM messages WHERE id = ?').get(m3), undefined);
  const third = db.prepare("SELECT m.*, f.path FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.account_id = ? AND m.message_id = 'three@x'").get(one);
  assert.equal(third.path, 'Old', 'folders keep their names');
  assert.ok(store.readRaw(third).toString().includes('Third'), 'the original is readable');
  const back = db.prepare('SELECT source_message_id AS s FROM tasks WHERE id = ?').get(task).s;
  assert.equal(db.prepare('SELECT message_id FROM messages WHERE id = ?').get(back).message_id, 'both@x', 'a task made from a duplicate follows the kept copy');
});

test('a copy that fails stays in the other archive, which then is not removed', async () => {
  const a = (await api('POST', '/api/archives', { name: 'Keep' })).id, b = (await api('POST', '/api/archives', { name: 'Broken' })).id;
  await api('POST', `/api/archives/${b}/import?filename=a.eml`, eml({ id: 'gone@x', subject: 'Gone' }));
  await waitJobs();
  db.prepare("UPDATE messages SET raw_path = '/nowhere/x' WHERE account_id = ?").run(b);
  await api('POST', `/api/archives/${a}/merge`, { fromId: b });
  const [j] = await waitJobs();
  assert.equal(j.failed, 1);
  assert.ok(db.prepare('SELECT 1 AS x FROM accounts WHERE id = ?').get(b));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE account_id = ?').get(b).n, 1);
});
