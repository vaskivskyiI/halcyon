// Timing of opening a long conversation (not part of the test suite): node test/bench-thread.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-bench-'));
process.env.HALCYON_LOG_LEVEL = 'error';
const N = Number(process.env.N || 60);

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
await call('POST', '/api/auth/setup', { email: 'u@example.org', name: 'U', password: 'password123' });
const acc = db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (1, 'u@example.org', 0, 0)").run().lastInsertRowid;
const f = db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'INBOX', '\\Inbox')").run(acc).lastInsertRowid;
const row = '<tr><td style="padding:4px;font-family:Arial"><a href="https://example.org/x?utm=1">Item</a> <img src="https://example.org/p.png" width="1" height="1"> text text text</td></tr>';
const html = `<html><head><style>.a{color:red}</style></head><body><table>${row.repeat(1500)}</table></body></html>`;
const att = Buffer.alloc(3e6, 'A').toString('base64').replace(/.{76}/g, '$&\r\n');
const ids = [];
for (let i = 0; i < N; i++) {
  const raw = `From: Ana <ana@x.example>\r\nTo: u@example.org\r\nSubject: Weekly report\r\nMessage-ID: <m${i}@x>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/html\r\n\r\n${html}\r\n--b\r\nContent-Type: application/pdf; name=a.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\n${att}\r\n--b--\r\n`;
  const p = path.join(process.env.HALCYON_DATA_DIR, `m${i}.eml`);
  fs.writeFileSync(p, raw);
  ids.push(Number(db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, thread_id, subject, from_name, from_addr, to_json, cc_json, date, body_html, body_text, attachments_json, raw_path, is_read, created_at)
    VALUES (1, ?, ?, ?, ?, 'thr', 'Weekly report', 'Ana', 'ana@x.example', '[]', '[]', ?, ?, 'report text', '[{"filename":"a.pdf","contentType":"application/pdf","size":3000000}]', ?, 0, 0)`).run(acc, f, i + 1, `m${i}@x`, Date.now() - (N - i) * 864e5, html, p).lastInsertRowid));
}
const time = async (label, fn) => { const t = performance.now(); const r = await fn(); console.log(label, Math.round(performance.now() - t), 'ms', r ? `${Math.round(JSON.stringify(r).length / 1024)} KB` : ''); return r; };
await time('message (first)', () => call('GET', `/api/messages/${ids[N - 1]}`));
await time('thread (first)', () => call('GET', '/api/threads/thr'));
await time('thread (again)', () => call('GET', '/api/threads/thr'));
await time('thread as reader asks, read thread', async () => { db.prepare('UPDATE messages SET is_read = 1, calendar_ics = NULL, sender_json = NULL').run(); return call('GET', `/api/threads/thr?full=${ids[3]}`); });
await time('thread as reader asks, all unread', async () => { db.prepare('UPDATE messages SET is_read = 0, calendar_ics = NULL, sender_json = NULL').run(); return call('GET', `/api/threads/thr?full=${ids[N - 1]}`); });
await app.close();
process.exit(0);
