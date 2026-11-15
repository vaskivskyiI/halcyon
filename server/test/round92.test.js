// Why an email is in Focused or Other (shown in the reader), tidy-up suggestions for senders the user always deletes,
// and warnings for an unusual money request from a known contact or a contact's name on a stranger's address.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r92-test-'));
process.env.HALCYON_LOG_LEVEL = 'error';
process.env.HALCYON_DEMO = '1';

let app, base, cookie = '', db, uid, account, inbox, ingestMessage, afterIngest, n = 0;
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
async function arrive({ from, name = '', subject, body, headers = '', folder = inbox, analyse = true }) {
  const raw = `${headers}Message-ID: <r92-${++n}@x>\r\nFrom: ${name ? `"${name}" ` : ''}<${from}>\r\nTo: me@example.org\r\nSubject: ${subject}\r\nDate: ${new Date(Date.now() - 60e3 + n * 1000).toUTCString()}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;
  const { id } = await ingestMessage({ account, folder, uid: n, flags: [], raw: Buffer.from(raw) });
  if (analyse) { await afterIngest(account, folder, [id]); await waitFor(() => insight(id)); }
  return id;
}

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
  inbox = folder('INBOX', '\\Inbox'); folder('Sent', '\\Sent'); folder('Trash', '\\Trash'); folder('Junk', '\\Junk');
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('the reader says why an email is in Focused or Other', async () => {
  const low = await arrive({ from: 'info@club.example', subject: 'Club news', body: 'Nothing much.' });
  let p = (await api('GET', `/api/messages/${low}`)).placement;
  assert.equal(p.focused, false);
  assert.match(p.reason, /low priority \(priority 30/);
  const high = await arrive({ from: 'boss@work.example', subject: 'urgent: budget today', body: 'Today please' });
  p = (await api('GET', `/api/messages/${high}`)).placement;
  assert.equal(p.focused, true);
  assert.match(p.reason, /worth your attention/);
  await api('POST', '/api/messages/focus', { ids: [low], focused: true });
  assert.match((await api('GET', `/api/messages/${low}`)).placement.reason, /You moved this conversation to Focused/);
  await api('PATCH', '/api/settings', { mail: { focusedInbox: false } });
  assert.equal((await api('GET', `/api/messages/${low}`)).placement, null, 'not shown without the Focused inbox');
  await api('PATCH', '/api/settings', { mail: { focusedInbox: true } });
});

test('senders the user always deletes are suggested for tidying up, until kept', async () => {
  const ids = [];
  for (let k = 0; k < 5; k++) {
    ids.push(await arrive({ from: 'promo@deals.example', name: 'Deals', subject: `Offer ${k}`, body: 'Buy', analyse: false,
      headers: 'List-Unsubscribe: <mailto:leave@deals.example>\r\n' }));
  }
  await api('POST', '/api/messages/actions', { action: 'trash', ids: ids.slice(0, 4) });
  const list = await api('GET', '/api/senders/cleanup');
  const s = list.find((x) => x.address === 'promo@deals.example');
  assert.ok(s, JSON.stringify(list));
  assert.match(s.reason, /You deleted 4 of their last 5 emails \(4 without reading\)/);
  assert.equal(s.plan.method, 'mailto');
  assert.ok(!list.some((x) => x.address === 'boss@work.example'));
  await api('POST', '/api/senders/habit', { address: 'promo@deals.example', keep: true });
  assert.ok(!(await api('GET', '/api/senders/cleanup')).some((x) => x.address === 'promo@deals.example'));
  // Never opened; "Always Other" settles it too.
  for (let k = 0; k < 5; k++) await arrive({ from: 'spam@bulk.example', subject: `x${k}`, body: 'x', analyse: false });
  assert.ok((await api('GET', '/api/senders/cleanup')).some((x) => x.address === 'spam@bulk.example' && /opened 0 of their last 5/.test(x.reason)));
  await api('POST', '/api/focus-senders', { address: 'spam@bulk.example', other: true });
  assert.ok(!(await api('GET', '/api/senders/cleanup')).some((x) => x.address === 'spam@bulk.example'));
});

test('a known contact asking for money in a new way, and a contact name on a stranger address, are flagged', async () => {
  const { trustSignals } = await import('../src/mail/trust.js');
  const cid = db.prepare("INSERT INTO contacts (user_id, display_name, emails_json) VALUES (?, 'Ana Novak', '[\"ana@uni.example\"]')").run(uid).lastInsertRowid;
  db.prepare('INSERT INTO contact_emails (contact_id, user_id, email) VALUES (?, ?, ?)').run(cid, uid, 'ana@uni.example');
  await arrive({ from: 'ana@uni.example', name: 'Ana Novak', subject: 'Lunch', body: 'Lunch on Friday?', analyse: false });
  const ask = await arrive({ from: 'ana@uni.example', name: 'Ana Novak', subject: 'Invoice', body: 'Our bank details have changed, please use the new IBAN for the payment today.' });
  const t = JSON.parse(insight(ask).trust_json);
  assert.ok(t.unusual && t.level === 'medium', JSON.stringify(t));
  assert.equal((await api('GET', `/api/messages/${ask}`)).insight.trust.unusual, t.unusual);
  // The same request again is no longer new.
  const again = trustSignals(uid, { id: 0, date: Date.now() + 60e3, from_name: 'Ana Novak', from_addr: 'ana@uni.example', subject: 'Re: Invoice', body_text: 'Reminder: our bank details have changed.', reply_to_json: '[]' }, { raw: null });
  assert.equal(again.unusual, null);

  const fake = trustSignals(uid, { id: 0, from_name: 'Ana Novak', from_addr: 'ana.novak.office@gmail.com', subject: 'Quick favour', body_text: 'Are you at your desk?', reply_to_json: '[]' }, { raw: null });
  assert.ok(fake.reasons.some((r) => /Uses the name of your contact Ana Novak/.test(r)), fake.reasons.join('; '));
  const real = trustSignals(uid, { id: 0, from_name: 'Ana Novak', from_addr: 'ana@uni.example', subject: 'Hi', body_text: 'Hi', reply_to_json: '[]' }, { raw: null });
  assert.ok(!real.reasons.length, real.reasons.join('; '));
});
