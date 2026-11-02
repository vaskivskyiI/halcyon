// Focused Inbox goes by conversation: a reply that alone would be "Other" stays with its focused conversation, so a
// conversation is never split between the two tabs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r76-test-'));
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, db, cookie = '';
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
  const add = (thread, date, priority, category) => {
    const id = db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, thread_id, subject, from_addr, to_json, cc_json, date, is_read, created_at)
      VALUES (1, ?, ?, ?, ?, ?, 'S', 'a@x.example', '[]', '[]', ?, 0, 0)`).run(acc, f, date, `m${date}@x`, thread, date).lastInsertRowid;
    db.prepare('INSERT INTO ai_insights (message_id, summary, category, priority) VALUES (?, ?, ?, ?)').run(id, 's', category, priority);
    return Number(id);
  };
  add('important', 1000, 80, 'work');
  add('important', 2000, 10, 'newsletter'); // alone it would be Other
  add('noise', 3000, 10, 'newsletter');
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('a conversation that is focused keeps its new messages in Focused', async () => {
  for (const threads of ['1', '0']) {
    const focused = (await api('GET', `/api/messages?view=unified&filter=focused&threads=${threads}`)).data.items;
    const other = (await api('GET', `/api/messages?view=unified&filter=other&threads=${threads}`)).data.items;
    assert.ok(focused.every((m) => m.threadId === 'important') && focused.some((m) => m.date === 2000), `the reply is in Focused (threads=${threads})`);
    assert.deepEqual(other.map((m) => m.threadId), ['noise'], 'Other has only the conversation that is not focused');
  }
  const c = (await api('GET', '/api/messages/tab-counts?view=unified')).data;
  assert.equal(c.focused + c.other, c.all, 'every unread conversation is in exactly one tab');
  assert.equal(c.other, 1);
});
