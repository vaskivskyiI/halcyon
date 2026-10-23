// Corrections with a reason: a rule the AI applies to similar mail from anyone — not a blanket rule for the sender
// (genuine invitations from the same address must not be caught by "not important: fake conferences").
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r28-test-'));
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
const add = (subject, from, body, ageH = 2) => {
  const id = Number(db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, thread_id, subject, from_name, from_addr, to_json, cc_json, date, body_text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, '[]', '[]', ?, ?, ?)`).run(uid, account.id, inbox.id, ++n, `r28-${n}@x`, `t${n}`, subject, from, Date.now() - ageH * 3600e3, body, Date.now()).lastInsertRowid);
  db.prepare("INSERT INTO ai_insights (message_id, summary, priority, category, needs_reply, model, created_at) VALUES (?, ?, 70, 'work', 0, 'mock', ?)").run(id, subject, Date.now());
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

test('"not important" with a reason is a rule for similar mail, not for everything from the sender', async () => {
  const { senderPreference, preferenceExamples } = await import('../src/ai/learning.js');
  const fake = add('Invitation: International Conference on Advanced Materials Science 2027', 'invite@conference-hub.example',
    'Dear Esteemed Researcher, you are invited as keynote speaker. Publication fee applies. Submit your abstract to our open access journal.');
  // Similar recent mail (another fake conference from another sender), and something unrelated.
  const other = add('Call for papers: World Congress on Materials Science 2027', 'cfp@globalcongress.example', 'Dear Esteemed Researcher, submit your abstract; publication fee for the open access journal.');
  const unrelated = add('Lab meeting moved', 'ana@uni.example', 'The lab meeting is moved to Friday.');
  const r = await api('POST', `/api/messages/${fake}/feedback`, { kind: 'unimportant', reason: 'Fake conferences: "Dear Esteemed Researcher", publication fee, open access journal. Real ones come from known societies.' });
  assert.equal(db.prepare('SELECT priority FROM ai_insights WHERE message_id = ?').get(fake).priority <= 15, true, 'this email at once');
  assert.ok(r.rechecked >= 1);
  const queued = db.prepare("SELECT ref_id FROM ai_jobs WHERE type = 'analyze'").all().map((j) => Number(j.ref_id));
  assert.ok(queued.includes(other) && !queued.includes(unrelated), 'similar recent mail is analysed again, unrelated is not');
  // No blanket preference for the sender: a real invitation from the same address is judged on its own.
  assert.equal(senderPreference(uid, 'invite@conference-hub.example').importance, null);
  // The reason reaches the model as a rule for any similar email.
  const text = preferenceExamples(uid, { from_addr: 'someone@new-sender.example', subject: 'Invitation to the Materials Science Summit', body_text: 'Dear Esteemed Researcher, publication fee …' });
  assert.match(text, /RULES THE USER EXPLAINED/);
  assert.match(text, /Dear Esteemed Researcher", publication fee/);
  // Without a reason it stays the per-sender behaviour.
  await api('POST', `/api/messages/${unrelated}/feedback`, { kind: 'important' });
  assert.equal(senderPreference(uid, 'ana@uni.example').importance, 'important');
});

test('rules are listed, can be edited, and deleted', async () => {
  const rules = await api('GET', '/api/ai/rules');
  assert.equal(rules.length, 1); assert.equal(rules[0].kind, 'unimportant');
  await api('PATCH', `/api/ai/rules/${rules[0].id}`, { reason: 'Predatory conferences (publication fee, flattering greeting)' });
  assert.match((await api('GET', '/api/ai/rules'))[0].reason, /Predatory/);
  await api('PATCH', `/api/ai/rules/${rules[0].id}`, { reason: '' });
  assert.equal((await api('GET', '/api/ai/rules')).length, 0);
  // The plain per-sender corrections list does not show reasoned ones (it never did: this one is gone anyway).
  assert.ok((await api('GET', '/api/ai/preferences')).every((p) => p.fromAddr !== 'invite@conference-hub.example'));
});
