// Timing of the mail lists and folder counts on a large mailbox (not part of the test suite): N=60000 node test/bench-lists.mjs
// DIR=<dir> keeps the generated database between runs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const N = Number(process.env.N || 60000);
const dir = process.env.DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-bench-lists-'));
fs.mkdirSync(dir, { recursive: true });
process.env.HALCYON_DATA_DIR = dir;
process.env.HALCYON_LOG_LEVEL = 'error';
const fresh = !fs.existsSync(path.join(dir, 'halcyon.db'));

const { buildServer } = await import('../src/index.js');
const app = await buildServer({ background: false });
await app.listen({ host: '127.0.0.1', port: 0 });
const base = `http://127.0.0.1:${app.server.address().port}`;
const { db } = await import('../src/db/index.js');
let cookie = '';
const call = async (method, url, body) => {
  const r = await fetch(base + url, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return r.json();
};
if (fresh) {
  await call('POST', '/api/auth/setup', { email: 'u@example.org', name: 'U', password: 'password123' });
  const acc = db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (1, 'u@example.org', 0, 0)").run().lastInsertRowid;
  const folder = (p, s) => db.prepare('INSERT INTO folders (account_id, path, name, special_use) VALUES (?, ?, ?, ?)').run(acc, p, p, s).lastInsertRowid;
  const fs_ = [folder('INBOX', '\\Inbox'), folder('Archive', '\\Archive'), folder('Sent', '\\Sent'), folder('Trash', '\\Trash'), folder('Lists', null)];
  const html = `<html><body>${'<p>Some long text of an email body with <a href="https://x.example">links</a>.</p>'.repeat(120)}</body></html>`;
  const ins = db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, thread_id, subject, subject_key, from_name, from_addr, to_json, cc_json, date, snippet, body_html, body_text, attachments_json, is_read, is_answered, created_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?, 'snippet', ?, ?, '[]', ?, 0, 0)`);
  const ai = db.prepare(`INSERT INTO ai_insights (message_id, summary, category, priority, needs_reply, needs_action, topic, expects_reply) VALUES (?, 'sum', ?, ?, ?, ?, ?, ?)`);
  const cats = ['work', 'personal', 'newsletter', 'notification', 'promotion', 'finance', 'travel'];
  const t0 = Date.now();
  db.transaction(() => {
    for (let i = 0; i < N; i++) {
      const f = fs_[i % 10 < 5 ? 0 : i % 10 < 7 ? 1 : i % 10 < 8 ? 2 : i % 10 < 9 ? 4 : 3];
      const thr = `t${Math.floor(i / 3)}`;
      const sender = `s${i % 500}@x.example`;
      const date = t0 - (N - i) * 15 * 60e3;
      const id = ins.run(acc, f, i + 1, `m${i}@x`, thr, `Subject ${Math.floor(i / 3)}`, `subject ${Math.floor(i / 3)}`, 'Sender', f === fs_[2] ? 'u@example.org' : sender,
        date, html, 'text '.repeat(400), i > N - 400 ? 0 : 1).lastInsertRowid;
      if (i % 10 < 8) ai.run(id, cats[i % cats.length], (i * 37) % 100, i % 4 === 0 ? 1 : 0, i % 5 === 0 ? 1 : 0, `Topic ${i % 60}`, f === fs_[2] ? 1 : 0);
    }
  })();
  for (let i = 0; i < 2000; i++) db.prepare("INSERT INTO ai_jobs (user_id, type, ref_id, status, priority, created_at, updated_at) VALUES (1, 'analyze', ?, 'queued', 1, 0, 0)").run(String(N - i));
  db.exec('ANALYZE');
} else await call('POST', '/api/auth/login', { email: 'u@example.org', password: 'password123' });

const time = async (label, url) => { const t = performance.now(); await call('GET', url); console.log(String(Math.round(performance.now() - t)).padStart(6), 'ms', label); };
const drop = () => db.prepare("UPDATE ai_insights SET summary = 'x' WHERE rowid = (SELECT MAX(rowid) FROM ai_insights)").run();
const inbox = db.prepare("SELECT id FROM folders WHERE special_use = '\\Inbox'").get().id;
for (let round = 0; round < 2; round++) {
  console.log('-- round', round + 1);
  await time('folders', '/api/folders');
  await time('folders (cached views)', '/api/folders');
  await time('unified', '/api/messages?view=unified');
  await time('unified focused', '/api/messages?view=unified&filter=focused');
  await time('unified other', '/api/messages?view=unified&filter=other');
  await time('unified unread', '/api/messages?view=unified&filter=unread');
  await time('tab-counts', '/api/messages/tab-counts?view=unified');
  await time('inbox folder', `/api/messages?view=folder&folderId=${inbox}`);
  await time('needsreply', '/api/messages?view=needsreply');
  await time('needsaction', '/api/messages?view=needsaction');
  await time('waiting', '/api/messages?view=waiting');
  await time('flagged', '/api/messages?view=flagged');
  await time('archive', '/api/messages?view=archive');
  await time('pinned', '/api/messages?view=unified&pinned=1');
  await time('unified no pinned', '/api/messages?view=unified&pinned=0');
  await time('sort subject', '/api/messages?view=unified&sort=subject');
  drop();
}
console.log('data dir', dir);
await app.close();
process.exit(0);
