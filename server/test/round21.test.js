// AI context: direct summaries, profiles of the people the user writes with (who they are, how the user writes to
// them, the user's own notes first), used by the assistant; what the AI learns about the user.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r21-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, uid, account, inbox, sent, n = 0;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
const add = (folder, { from, fromName = '', to, subject, body, ageDays }) => Number(db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, thread_id, subject, from_name, from_addr, to_json, cc_json, date, body_text, snippet, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)`).run(uid, account.id, folder.id, ++n, `r21-${n}@x`, `t${n}`, subject, fromName, from, JSON.stringify([{ name: '', address: to }]),
  Date.now() - ageDays * 864e5, body, body.slice(0, 80), Date.now()).lastInsertRowid);

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  await api('POST', '/api/auth/setup', { email: 'igor@ijs.example', name: 'Igor', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  await api('POST', '/api/ai/providers', { type: 'mock', name: 'Mock' });
  account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, 'igor@ijs.example', 0, ?)").run(uid, Date.now()).lastInsertRowid);
  const folder = (p, s) => db.prepare('SELECT * FROM folders WHERE id = ?').get(db.prepare('INSERT INTO folders (account_id, path, name, special_use) VALUES (?, ?, ?, ?)').run(account.id, p, p, s).lastInsertRowid);
  inbox = folder('INBOX', '\\Inbox'); sent = folder('Sent', '\\Sent');
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('summaries start with the substance, not the sender or the subject', async () => {
  const { cleanSummary } = await import('../src/ai/summary.js');
  const from = { fromName: 'Ana Novak', fromAddr: 'ana@x.example', subject: 'Signed contract' };
  assert.equal(cleanSummary('Ana Novak asks you to send the signed contract by Friday.', from), 'Send the signed contract by Friday.');
  assert.equal(cleanSummary('Ana informs that the meeting moved to 10:00.', from), 'The meeting moved to 10:00.');
  assert.equal(cleanSummary('The email from Ana Novak is about the budget: 12k approved.', from), 'The budget: 12k approved.');
  assert.equal(cleanSummary('Signed contract: the client accepted the 8% discount.', from), 'The client accepted the 8% discount.');
  assert.equal(cleanSummary('Ana Novak invites you to the kickoff on Monday.', from), 'Ana Novak invites you to the kickoff on Monday.', 'verbs that carry meaning stay');
  assert.equal(cleanSummary('Payment of 420 EUR is due on 30 Oct.', from), 'Payment of 420 EUR is due on 30 Oct.');
  assert.equal(cleanSummary('Meeting moved to 10:00.', { fromName: null, fromAddr: null, subject: null }), 'Meeting moved to 10:00.', 'senders without a name');
});

test('a profile of a correspondent: who they are, what is discussed, how the user writes to them', async () => {
  add(inbox, { from: 'ana@x.example', fromName: 'Ana Novak', to: 'igor@ijs.example', subject: 'Helios budget', body: 'Could you send the Helios budget table?', ageDays: 10 });
  add(sent, { from: 'igor@ijs.example', to: 'ana@x.example', subject: 'Re: Helios budget', body: 'Živjo Ana,\nhere is the table.\nLp, Igor', ageDays: 9 });
  add(inbox, { from: 'ana@x.example', fromName: 'Ana Novak', to: 'igor@ijs.example', subject: 'Helios review', body: 'Thanks! Review on Monday?', ageDays: 5 });
  const { profileJob, noteCorrespondence, profileText } = await import('../src/ai/profiles.js');
  // New mail is counted and a build is queued once there is enough of it.
  noteCorrespondence(uid, ['ana@x.example', 'igor@ijs.example', 'no-reply@shop.example']);
  noteCorrespondence(uid, ['ana@x.example']);
  assert.ok(db.prepare("SELECT 1 FROM ai_jobs WHERE type = 'profile' AND ref_id = 'ana@x.example'").get(), 'build queued');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM contact_profiles WHERE email IN ('igor@ijs.example', 'no-reply@shop.example')").get().n, 0, 'not the user, not robots');
  await profileJob(uid, 'ana@x.example');
  const p = await api('GET', '/api/people/ana@x.example');
  assert.equal(p.name, 'Ana Novak');
  assert.match(p.profile.who, /Helios/);
  assert.match(p.profile.userWriting, /Živjo Ana/, 'how the user opens mails to her, from the user\'s own sent mail');
  // The user's own notes are kept, shown first and win.
  await api('PUT', '/api/people/ana@x.example/notes', { notes: 'My PhD student; we use informal "ti".' });
  const text = profileText(uid, 'ana@x.example', { writing: true });
  assert.match(text, /^Ana Novak <ana@x\.example> — The user's own notes about them \(authoritative\): My PhD student/);
  assert.match(text, /How the user writes to them: Opens with "Živjo Ana,"/);
});

test('the assistant gets the profiles of the people a question is about', async () => {
  const { buildContext } = await import('../src/ai/assistant.js');
  const ctx = await buildContext(uid, 'What am I working on with Ana?', null);
  assert.match(ctx.text, /PEOPLE \(what the user's mail shows about them/);
  assert.match(ctx.text, /My PhD student/);
});

test('what the AI learns about the user goes with every request', async () => {
  for (let i = 0; i < 6; i++) add(sent, { from: 'igor@ijs.example', to: `p${i}@x.example`, subject: `Helios task ${i}`, body: `Hello,\nplease see the Helios plan, part ${i}.\nIgor`, ageDays: i });
  const { aboutMeJob } = await import('../src/ai/profiles.js');
  await aboutMeJob(uid);
  const me = await api('GET', '/api/me');
  assert.match(me.settings.ai.learnedAboutMe, /projects/);
  const { userContext } = await import('../src/ai/prompts.js');
  const ctx = userContext({ name: 'Igor' }, me.settings, [{ email: 'igor@ijs.example' }]);
  assert.match(ctx, /What the user's mail shows about them \(learned; the user's own words win\): - Works on/);
  // The user can correct it.
  await api('PATCH', '/api/settings', { ai: { learnedAboutMe: 'Researcher; leads the Helios project.' } });
  assert.equal((await api('GET', '/api/me')).settings.ai.learnedAboutMe, 'Researcher; leads the Helios project.');
});
