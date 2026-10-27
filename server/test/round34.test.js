// AI: the user's emails that wait for an answer ("Waiting for reply"), and a briefing before a meeting.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r34-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, uid, account, inbox, sent, n = 0;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
const add = (folder, o) => {
  const id = Number(db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, thread_id, subject, from_name, from_addr, to_json, cc_json, date, body_text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, '[]', ?, ?, ?)`).run(uid, account.id, folder.id, ++n, `r34-${n}@x`, o.thread || `t${n}`, o.subject, o.from, JSON.stringify((o.to || ['me@example.org']).map((a) => ({ name: '', address: a }))), Date.now() - (o.ageH || 1) * 3600e3, o.body || '', Date.now()).lastInsertRowid);
  db.prepare('INSERT INTO messages_fts (rowid, subject, sender, recipients, body) VALUES (?, ?, ?, ?, ?)').run(id, o.subject, o.from, (o.to || []).join(' '), o.body || '');
  return id;
};
const view = async (v) => (await api('GET', `/api/messages?view=${v}&threads=0`)).items.map((m) => m.id);

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
  account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, 'me@example.org', 0, ?)").run(uid, Date.now()).lastInsertRowid);
  const folder = (p, s) => db.prepare('SELECT * FROM folders WHERE id = ?').get(db.prepare('INSERT INTO folders (account_id, path, name, special_use) VALUES (?, ?, ?, ?)').run(account.id, p, p, s).lastInsertRowid);
  inbox = folder('INBOX', '\\Inbox'); sent = folder('Sent', '\\Sent');
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('my question without an answer waits; an answer, thanks or "stop waiting" end it', async () => {
  const { analyzeMessage } = await import('../src/ai/tasks.js');
  const q = add(sent, { subject: 'Quote', from: 'me@example.org', to: ['ana@x.example'], thread: 'q', body: 'Could you send me the quote for the shoot?', ageH: 50 });
  const thanks = add(sent, { subject: 'Thanks', from: 'me@example.org', to: ['bob@x.example'], thread: 'th', body: 'Thank you, all good.', ageH: 40 });
  const q2 = add(sent, { subject: 'Date', from: 'me@example.org', to: ['cid@x.example'], thread: 'd', body: 'Which date works for you?', ageH: 30 });
  for (const id of [q, thanks, q2]) await analyzeMessage(uid, id, { interactive: true });
  assert.deepEqual((await view('waiting')).sort((a, b) => a - b), [q, q2].sort((a, b) => a - b));
  assert.equal((await api('GET', '/api/folders')).counts.waiting, 2);
  // Cid answers in the conversation.
  add(inbox, { subject: 'Re: Date', from: 'cid@x.example', thread: 'd', body: 'Tuesday.', ageH: 2 });
  assert.deepEqual(await view('waiting'), [q]);
  await api('POST', `/api/messages/${q}/dismiss`, { resolution: 'done' });
  assert.deepEqual(await view('waiting'), []);
  assert.equal((await api('GET', `/api/messages/${q2}`)).insight.expectsReply, true);
});

test('meeting preparation uses recent mail with the participants and cites it', async () => {
  const m = add(inbox, { subject: 'Wedding shoot plan', from: 'ana@x.example', body: 'Ceremony at 14:00, 120 guests, drone allowed.', ageH: 20 });
  const cal = db.prepare('SELECT id FROM calendars WHERE user_id = ? AND is_default = 1').get(uid).id;
  const e = await api('POST', '/api/events', { calendarId: cal, title: 'Wedding shoot planning', start: Date.now() + 864e5, end: Date.now() + 864e5 + 3600e3, attendees: [{ email: 'ana@x.example', name: 'Ana' }] });
  const r = await fetch(`${base}/api/events/${e.id}/prep`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' });
  const lines = (await r.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const result = lines.find((l) => l.done)?.result || '';
  // The mock answers a briefing with the emails it was given: the participant's email is among them, by id.
  assert.match(result, new RegExp(`\\[#${m}\\]`));
  assert.match(result, /Wedding shoot planning/);
});
