// Sorting with evidence: a fake invoice (brand in the name, another domain, failed DMARC, links elsewhere) is phishing
// and stays out of Focused whatever the AI's text verdict; the sender's history (mail the user keeps deleting, people
// the user writes to) reaches the analysis and bounds the priority; and mail moves between Focused and Other by hand
// without being called important — once for the conversation, learned for the sender after two moves.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r91-test-'));
process.env.HALCYON_LOG_LEVEL = 'error';
process.env.HALCYON_DEMO = '1';

let app, base, cookie = '', db, uid, account, inbox, sent, trash, ingestMessage, afterIngest, n = 0;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
const waitFor = async (fn, ms = 15000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 30)); } };
const insight = (id) => db.prepare('SELECT * FROM ai_insights WHERE message_id = ?').get(id);

async function arrive({ from, name = '', subject, body, headers = '', folder = inbox, html = null, analyse = true, read = false }) {
  const type = html ? 'text/html' : 'text/plain';
  const raw = `${headers}Message-ID: <r91-${++n}@x>\r\nFrom: ${name ? `"${name}" ` : ''}<${from}>\r\nTo: me@example.org\r\nSubject: ${subject}\r\nDate: ${new Date(Date.now() - 60e3).toUTCString()}\r\nContent-Type: ${type}; charset=utf-8\r\n\r\n${html || body}\r\n`;
  const { id } = await ingestMessage({ account, folder, uid: n, flags: read ? ['\\Seen'] : [], raw: Buffer.from(raw) });
  if (analyse) { await afterIngest(account, folder, [id]); await waitFor(() => insight(id)); }
  return id;
}
const listIds = async (filter) => (await api('GET', `/api/messages?view=unified&threads=0&filter=${filter}`)).items.map((m) => m.id);

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  ({ ingestMessage } = await import('../src/mail/store.js'));
  ({ afterIngest } = await import('../src/mail/pipeline.js'));
  (await import('../src/ai/queue.js')).startQueue();
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  await api('POST', '/api/ai/providers', { type: 'mock', name: 'Mock' });
  await api('PATCH', '/api/settings', { mail: { focusedInbox: true } });
  account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, 'me@example.org', 0, ?)").run(uid, Date.now()).lastInsertRowid);
  const folder = (name, special) => db.prepare('SELECT * FROM folders WHERE id = ?').get(db.prepare('INSERT INTO folders (account_id, path, name, special_use) VALUES (?, ?, ?, ?)').run(account.id, name, name, special).lastInsertRowid);
  inbox = folder('INBOX', '\\Inbox'); sent = folder('Sent', '\\Sent'); trash = folder('Trash', '\\Trash'); folder('Junk', '\\Junk');
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('the checks read SPF/DKIM/DMARC and spot brands sent from other domains and look-alikes', async () => {
  const { authResults, trustSignals } = await import('../src/mail/trust.js');
  assert.deepEqual(authResults(Buffer.from('Authentication-Results: mx.example.org; spf=fail smtp.mailfrom=x.xyz; dkim=none; dmarc=fail header.from=x.xyz\r\nFrom: a@b\r\n\r\nbody')),
    { spf: 'fail', dkim: 'none', dmarc: 'fail', dkimDomain: null });
  assert.equal(authResults(Buffer.from('From: a@b\r\n\r\nbody')), null);
  const base = { id: 0, subject: 'Your invoice', body_text: 'Your payment failed', reply_to_json: '[]' };
  const fake = trustSignals(uid, { ...base, from_name: 'ChatGPT Billing', from_addr: 'billing@gpt-invoices.xyz' }, { raw: null });
  assert.ok(fake.reasons.some((r) => /OpenAI \/ ChatGPT/.test(r)), fake.reasons.join('; '));
  const real = trustSignals(uid, { ...base, from_name: 'ChatGPT', from_addr: 'noreply@tm.openai.com' }, { raw: Buffer.from('Authentication-Results: mx; spf=pass; dkim=pass header.d=openai.com; dmarc=pass\r\n\r\n') });
  assert.equal(real.level, 'low', real.reasons.join('; '));
  assert.ok(!real.reasons.some((r) => /ChatGPT|DMARC/.test(r)), real.reasons.join('; '));
  const twin = trustSignals(uid, { ...base, subject: 'Hello', body_text: 'hi', from_name: 'Pay', from_addr: 'service@paypa1.com' }, { raw: null });
  assert.ok(twin.reasons.some((r) => /looks like paypal\.com/.test(r)), twin.reasons.join('; '));
});

test('a fake ChatGPT invoice is phishing, low and in Other, with the reasons shown', async () => {
  const id = await arrive({
    from: 'billing@chatgpt-renewal.xyz', name: 'ChatGPT', subject: 'URGENT: your ChatGPT Plus payment failed — pay the invoice today',
    headers: 'Authentication-Results: mx.example.org; spf=softfail smtp.mailfrom=chatgpt-renewal.xyz; dkim=none; dmarc=fail header.from=chatgpt-renewal.xyz\r\n',
    html: '<p>Your payment failed. <a href="http://198.51.100.7/pay">https://chatgpt.com/billing</a></p>',
  });
  const i = insight(id);
  assert.equal(i.is_phishing, 1);
  assert.ok(i.priority <= 10, `priority ${i.priority}`);
  assert.equal(i.needs_action, 0);
  const trust = JSON.parse(i.trust_json);
  assert.ok(trust.score >= 60 && trust.reasons.some((r) => /DMARC/.test(r)), JSON.stringify(trust));
  assert.ok(!(await listIds('focused')).includes(id));
  assert.ok((await listIds('other')).includes(id));
  assert.equal((await api('GET', `/api/messages/${id}`)).insight.trust.level, 'high');
});

test('the sender history reaches the analysis: deleted mail is remembered, people the user writes to stay in Focused', async () => {
  const { senderStats, senderHistoryText, mostlyDeleted } = await import('../src/ai/sender-history.js');
  // Four emails the user deleted unread: counted when deleted, and kept after they are gone.
  const old = [];
  for (let k = 0; k < 4; k++) old.push(await arrive({ from: 'deals@shop.example', subject: `Deal ${k}`, body: 'Buy now', analyse: false }));
  await api('POST', '/api/messages/actions', { action: 'trash', ids: old });
  (await import('../src/mail/store.js')).deleteMessages(old);
  const next = await arrive({ from: 'deals@shop.example', subject: 'URGENT deal today', body: 'Only today' });
  const st = senderStats(uid, { id: next, from_addr: 'deals@shop.example' });
  assert.equal(st.deleted, 4);
  assert.equal(st.deletedUnread, 4);
  assert.ok(mostlyDeleted(st));
  assert.match(senderHistoryText(st, 'Europe/Ljubljana'), /deleted 4 \(4 without reading\)/);
  assert.ok(insight(next).priority <= 15, `held low despite "urgent": ${insight(next).priority}`);

  // Someone the user has written to: at least at the Focused level.
  await arrive({ from: 'me@example.org', subject: 'Question', body: 'x', folder: sent, analyse: false, headers: '' });
  db.prepare("UPDATE messages SET to_json = '[{\"name\":\"\",\"address\":\"ana@uni.example\"}]' WHERE folder_id = ?").run(sent.id);
  const ana = await arrive({ from: 'ana@uni.example', subject: 'Notes', body: 'Here are the notes from today.' });
  assert.ok(insight(ana).priority >= 40, `priority ${insight(ana).priority}`);
  assert.match(senderHistoryText(senderStats(uid, { id: ana, from_addr: 'ana@uni.example' }), 'UTC'), /written to them 1 time/);
});

test('moving to Focused or Other keeps the priority, and two moves of a sender are learned', async () => {
  const a = await arrive({ from: 'news@conf.example', subject: 'Programme update', body: 'The programme changed. Unsubscribe here.' });
  const before = insight(a).priority;
  assert.ok((await listIds('other')).includes(a));
  const r1 = await api('POST', '/api/messages/focus', { ids: [a], focused: true });
  assert.deepEqual(r1.senders, []);
  assert.ok((await listIds('focused')).includes(a));
  assert.equal(insight(a).priority, before, 'not made important');
  const b = await arrive({ from: 'news@conf.example', subject: 'Venue', body: 'The venue changed. Unsubscribe here.' });
  assert.ok((await listIds('other')).includes(b), 'one move is for that conversation only');
  const r2 = await api('POST', '/api/messages/focus', { ids: [b], focused: true });
  assert.deepEqual(r2.senders, ['news@conf.example']);
  const c = await arrive({ from: 'news@conf.example', subject: 'Dinner', body: 'Dinner at 8. Unsubscribe here.' });
  assert.ok((await listIds('focused')).includes(c), 'learned: the sender now always goes to Focused');

  // Always Other, and back: the conversation's own move wins.
  const d = await arrive({ from: 'boss@work.example', subject: 'urgent: budget today', body: 'Please look at the budget today' });
  assert.ok((await listIds('focused')).includes(d));
  await api('POST', '/api/messages/focus', { ids: [d], focused: false, always: true });
  assert.ok((await listIds('other')).includes(d));
  const rows = await api('GET', '/api/focus-senders');
  assert.equal(rows.find((x) => x.address === 'boss@work.example').other, true);
  const e = await arrive({ from: 'boss@work.example', subject: 'urgent: more budget', body: 'today please' });
  assert.ok((await listIds('other')).includes(e));
  await api('POST', '/api/messages/focus', { ids: [e], focused: true });
  assert.ok((await listIds('focused')).includes(e));
  const prefs = await api('GET', '/api/ai/preferences');
  assert.ok(prefs.some((p) => p.kind === 'focus' && p.fromAddr === 'boss@work.example'));
});

test('Subscriptions: a discussion list is one row (not its writers), people are left out, and the button says what it does', async () => {
  const listHdr = 'List-Id: "Staff list" <staff.lists.uni.example>\r\nList-Post: <mailto:staff@lists.uni.example>\r\nList-Unsubscribe: <mailto:staff-leave@lists.uni.example?subject=unsubscribe>\r\n';
  await arrive({ from: 'marko@uni.example', name: 'Marko', subject: 'Seminar on Friday', body: 'See you', headers: listHdr, analyse: false });
  await arrive({ from: 'petra@uni.example', name: 'Petra', subject: 'Lost keys', body: 'Anyone?', headers: listHdr, analyse: false });
  // Marko also writes to the user directly, and the user answered him: not a subscription as himself.
  await arrive({ from: 'marko@uni.example', name: 'Marko', subject: 'Lunch?', body: 'Lunch today?', analyse: false });
  await arrive({ from: 'me@example.org', subject: 'Re: Lunch?', body: 'Yes', folder: sent, analyse: false });
  db.prepare("UPDATE messages SET to_json = '[{\"name\":\"\",\"address\":\"marko@uni.example\"}]' WHERE subject = 'Re: Lunch?'").run();
  // A newsletter with one-click unsubscribe, and one with only a web page.
  await arrive({ from: 'news@shop.example', name: 'Shop', subject: 'Sale', body: 'Sale', analyse: false,
    headers: 'List-Unsubscribe: <https://shop.example/u/1>, <mailto:u@shop.example>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n' });
  await arrive({ from: 'hello@blog.example', name: 'Blog', subject: 'New post', body: 'Read', analyse: false, headers: 'List-Unsubscribe: <https://blog.example/unsub?x=1>\r\n' });

  const subs = await api('GET', '/api/subscriptions');
  const list = subs.find((r) => r.address === 'list:staff.lists.uni.example');
  assert.ok(list?.isList, JSON.stringify(subs.map((r) => r.address)));
  assert.equal(list.name, 'Staff list');
  assert.equal(list.total, 2);
  assert.ok(!subs.some((r) => r.address === 'marko@uni.example' || r.address === 'petra@uni.example'), 'writers are not subscriptions');
  assert.equal(list.plan.method, 'mailto');
  assert.match(list.plan.text, /email from me@example\.org to staff-leave@lists\.uni\.example.*leaves the mailing list “Staff list”/);
  assert.ok(list.recent.every((m) => m.subject !== 'Lunch?'), 'only the list mail is listed');
  assert.equal(subs.find((r) => r.address === 'news@shop.example').plan.method, 'one-click');
  const blog = subs.find((r) => r.address === 'hello@blog.example').plan;
  assert.equal(blog.method, 'web');
  assert.match(blog.text, /Opens the unsubscribe page on blog\.example/);

  // Leaving the list: an email to its leave address, remembered for the list.
  const r = await api('POST', `/api/messages/${list.unsubscribeId}/unsubscribe`);
  assert.equal(r.method, 'mailto');
  const out = db.prepare('SELECT payload_json FROM outbox ORDER BY id DESC LIMIT 1').get();
  assert.deepEqual(JSON.parse(out.payload_json).to, ['staff-leave@lists.uni.example']);
  assert.ok((await api('GET', '/api/subscriptions')).find((x) => x.address === 'list:staff.lists.uni.example').unsubscribedAt);
  // The message itself carries the same plan; the Senders view offers no unsubscribe for a list writer.
  assert.equal((await api('GET', `/api/messages/${list.unsubscribeId}`)).unsubscribe.list, 'Staff list');
  const senders = await api('GET', '/api/senders');
  assert.equal(senders.find((x) => x.address === 'marko@uni.example')?.plan ?? null, null);
});

test('topics: an existing one is reused when written differently, generic and newsletter topics are dropped, duplicates merge', async () => {
  const { normalizeTopic, sameTopic, mergeTopics } = await import('../src/ai/topics.js');
  const existing = ['NQW 2026', 'Helios grant', 'Order 4471'];
  assert.equal(normalizeTopic('NQW 2026 conference', existing), 'NQW 2026');
  assert.equal(normalizeTopic('Conference NQW 2026', existing), 'NQW 2026');
  assert.equal(normalizeTopic('Helios grant application', existing), 'Helios grant');
  assert.equal(normalizeTopic('#helios-grant', existing), 'Helios grant');
  assert.equal(normalizeTopic('NQW 2025', existing), 'NQW 2025', 'another year is another matter');
  assert.equal(normalizeTopic('Order 4472', existing), 'Order 4472');
  assert.equal(normalizeTopic('Project update', existing), null);
  assert.equal(normalizeTopic('Meeting', existing), null);
  assert.equal(normalizeTopic('Black Friday deals', existing, { category: 'promotion' }), null);
  assert.equal(normalizeTopic('ChatGPT subscription', existing, { phishing: true }), null);
  assert.ok(!sameTopic('Helios grant', 'Flat renovation'));

  const ids = [];
  for (const [k, t] of [[1, 'Helios grant'], [2, 'Helios grant'], [3, 'Helios grant application'], [4, 'Flat renovation']].map(([k, t]) => [k, t])) {
    const id = await arrive({ from: `x${k}@lab.example`, subject: `t${k}`, body: 'b', analyse: false });
    db.prepare("INSERT INTO ai_insights (message_id, summary, category, priority, topic, created_at) VALUES (?, '', 'work', 30, ?, ?)").run(id, t, Date.now());
    ids.push(id);
  }
  assert.equal(mergeTopics(uid), 1);
  assert.deepEqual(ids.map((id) => insight(id).topic), ['Helios grant', 'Helios grant', 'Helios grant', 'Flat renovation']);
});
