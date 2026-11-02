// A long conversation opens fast: only the messages shown open come with their bodies; the others are asked for when
// unfolded. Older mail is not parsed for invitations it cannot hold.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r74-test-'));
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, db, cookie = '';
const ids = [];
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => null) };
}

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  await api('POST', '/api/auth/setup', { email: 'u@example.org', name: 'U', password: 'password123' });
  const acc = db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (1, 'u@example.org', 0, 0)").run().lastInsertRowid;
  const f = db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'INBOX', '\\Inbox')").run(acc).lastInsertRowid;
  // 30 messages: the first 25 read, the last 5 unread.
  for (let i = 0; i < 30; i++) {
    ids.push(Number(db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, thread_id, subject, from_name, from_addr, to_json, cc_json, date, body_html, body_text, attachments_json, is_read, created_at)
      VALUES (1, ?, ?, ?, ?, 'thr', 'Report', 'Ana', 'ana@x.example', '[]', '[]', ?, ?, 'text', '[{"filename":"a.pdf","contentType":"application/pdf"}]', ?, 0)`)
      .run(acc, f, i + 1, `m${i}@x`, 1e12 + i * 1000, `<p>Body ${i}</p>`, i < 25 ? 1 : 0).lastInsertRowid));
  }
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('a conversation comes with the bodies of what is shown open; the rest are asked for when unfolded', async () => {
  const r = await api('GET', `/api/threads/thr?full=${ids[3]}`);
  assert.equal(r.status, 200);
  const byId = new Map(r.data.messages.map((m) => [m.id, m]));
  const withBody = r.data.messages.filter((m) => !m.partial).map((m) => m.id);
  assert.deepEqual(withBody, [ids[3], ...ids.slice(25)], 'the one asked for, and the unread ones (the last two among them)');
  const folded = byId.get(ids[10]);
  assert.equal(folded.partial, true);
  assert.equal(folded.html, null);
  assert.equal(folded.subject, 'Report', 'a folded message still has what its row shows');
  assert.ok(byId.get(ids[3]).html.includes('Body 3'));

  const whole = await api('GET', '/api/threads/thr');
  assert.ok(whole.data.messages.every((m) => !m.partial && m.html), 'without ?full every body is sent');

  const one = await api('GET', `/api/messages/${ids[10]}`);
  assert.ok(one.data.html.includes('Body 10'), 'the body of a folded message, asked for on its own');
});

test('older mail without a part that can hold an invitation is not read for one', async () => {
  db.prepare('UPDATE messages SET calendar_ics = NULL, raw_path = ? WHERE id = ?').run(path.join(process.env.HALCYON_DATA_DIR, 'missing.eml'), ids[29]);
  const { icsOf } = await import('../src/mail/store.js');
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(ids[29]);
  assert.equal(await icsOf(m), '');
  assert.equal(db.prepare('SELECT calendar_ics FROM messages WHERE id = ?').get(ids[29]).calendar_ics, '', 'remembered: not looked for again');
});
