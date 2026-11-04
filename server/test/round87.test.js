// Links of an email: where they go, the rules that call them suspicious, and the AI's verdict (asked once per email).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r87-test-'));
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, account, ingestMessage, L, n = 0;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
async function mail(from, html) {
  const folder = db.prepare("SELECT * FROM folders WHERE account_id = ? AND path = 'INBOX'").get(account.id);
  const raw = `Message-ID: <l${++n}@x>\r\nFrom: ${from}\r\nTo: me@example.org\r\nSubject: Account notice ${n}\r\nContent-Type: text/html\r\n\r\n${html}\r\n`;
  return (await ingestMessage({ account, folder, uid: n, flags: [], raw: Buffer.from(raw) })).id;
}

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  ({ ingestMessage } = await import('../src/mail/store.js'));
  L = await import('../src/mail/links.js');
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  const uid = db.prepare('SELECT id FROM users').get().id;
  await api('PATCH', '/api/settings', { ai: { enabled: false } });
  account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, 'me@example.org', 0, ?)").run(uid, Date.now()).lastInsertRowid);
  db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'INBOX', '\Inbox')").run(account.id);
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('rules: text showing another site, IP address, punycode, user@ host', () => {
  assert.equal(L.siteOf('www.mail.example.co.uk'), 'example.co.uk');
  const links = L.linksOf({ body_html: `<a href="https://evil.example/login">https://www.bank.com/login</a>
    <a href="http://192.168.4.4/x">Pay</a> <a href='https://xn--pypal-4ve.com/'>PayPal</a> <a href="https://bank.com@evil.example/">here</a>
    <a href="https://bank.com/help">www.bank.com</a> <a href="mailto:a@b.c">mail</a> <a href="https://evil.example/login">again</a>` });
  assert.equal(links.length, 5, 'web links once each, no mailto');
  assert.match(links[0].flags[0], /shows www\.bank\.com, but the link goes to evil\.example/);
  assert.match(links[1].flags[0], /IP address/);
  assert.match(links[2].flags[0], /punycode/);
  assert.match(links[3].flags[0], /bank\.com@/);
  assert.deepEqual(links[4].flags, [], 'text and link on the same site');
});

test('without AI the rules decide; with AI its verdict, asked once and kept', async () => {
  const id = await mail('PayPal <service@paypal.com>', '<p>Confirm</p><a href="https://paypa1-secure.example/verify">Verify now</a> <a href="https://click.mailer.example/r/1">https://www.paypal.com</a> <a href="https://www.paypal.com/help">Help</a>');
  let r = await api('GET', `/api/messages/${id}/links`);
  assert.equal(r.ai, 'off');
  assert.deepEqual(r.links.map((l) => l.suspicious), [false, true, false], 'rules only: the text-shows-another-site link');
  await api('PATCH', '/api/settings', { ai: { enabled: true } });
  await api('POST', '/api/ai/providers', { type: 'mock', name: 'Mock' });
  r = await api('GET', `/api/messages/${id}/links`);
  assert.equal(r.ai, 'done');
  assert.deepEqual(r.links.map((l) => l.suspicious), [true, false, false], 'the AI: the look-alike, not the tracking link');
  assert.equal(r.links[0].reason, 'Look-alike of paypal.com');
  assert.match(r.links[1].flags[0], /shows www\.paypal\.com/, 'what the rules saw is still told');
  const calls = db.prepare('SELECT COUNT(*) AS n FROM ai_usage').get().n;
  await api('GET', `/api/messages/${id}/links`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_usage').get().n, calls, 'kept, not asked again');
});

test('links that stay on the sender\'s own site are not sent to the AI', async () => {
  const id = await mail('Shop <news@shop.example>', '<a href="https://www.shop.example/sale">Sale</a> <a href="https://shop.example/unsub">Unsubscribe</a>');
  const calls = db.prepare('SELECT COUNT(*) AS n FROM ai_usage').get().n;
  const r = await api('GET', `/api/messages/${id}/links`);
  assert.equal(r.links.length, 2);
  assert.ok(r.links.every((l) => !l.suspicious));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_usage').get().n, calls);
});
