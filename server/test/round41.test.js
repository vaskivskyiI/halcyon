// Servers with their own certificates (self-signed / private CA) trusted per account; important unread counted apart;
// big files uploaded in pieces (see round38).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r41-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, uid;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}

// A self-signed certificate for 127.0.0.1 (openssl), or null where openssl is missing.
function selfSigned() {
  try {
    const key = path.join(dataDir, 'k.pem'), cert = path.join(dataDir, 'c.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    return { key: fs.readFileSync(key, 'utf8'), cert: fs.readFileSync(cert, 'utf8') };
  } catch { return null; }
}
const pair = selfSigned();

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('an account trusts its own CA or skips the check; a bad certificate text is refused', async () => {
  const { tlsOf, certHint } = await import('../src/mail/connection.js');
  assert.equal(tlsOf({}).rejectUnauthorized, true);
  assert.equal(tlsOf({ tls_insecure: 1 }).rejectUnauthorized, false);
  const withCa = tlsOf({ tls_ca: '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----' });
  assert.equal(withCa.rejectUnauthorized, true);
  assert.ok(withCa.ca.length > 10, 'added to the usual authorities, not instead of them');
  assert.match(certHint('unable to verify the first certificate'), /add its certificate authority/);
  await assert.rejects(api('POST', '/api/accounts', { services: ['calendar'], caldavUrl: 'https://127.0.0.1:9/', davUser: 'a', tls: { ca: 'not a certificate' } }), /PEM/);
});

test('a calendar server with a self-signed certificate: refused with a clear reason, then trusted', { skip: !pair && 'openssl not available' }, async () => {
  const srv = https.createServer({ key: pair.key, cert: pair.cert }, (req, res) => { res.writeHead(401, { 'www-authenticate': 'Basic' }); res.end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `https://127.0.0.1:${srv.address().port}/dav/`;
  try {
    const a = await api('POST', '/api/accounts', { services: ['calendar'], caldavUrl: url, davUser: 'alice', davPassword: 'x' });
    assert.match(a.dav.error, /certificate is not trusted/);
    // With its CA (here: the certificate itself) the connection works — and the server's answer (401) is reported.
    const b = await api('POST', `/api/accounts/${a.id}/services/calendar`, { url, tls: { ca: pair.cert } });
    assert.doesNotMatch(b.dav.error, /certificate/);
    assert.match(b.dav.error, /refused the username or password/);
    assert.equal(b.tls.ca.trim(), pair.cert.trim());
    const c = await api('POST', `/api/accounts/${a.id}/services/calendar`, { url, tls: { ca: '', insecure: true } });
    assert.match(c.dav.error, /refused the username or password/);
  } finally { srv.close(); }
});

test('unread counts tell the important ones apart', async () => {
  const acc = db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, 'me@example.org', 0, ?)").run(uid, Date.now()).lastInsertRowid;
  const inbox = db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'INBOX', '\\Inbox')").run(acc).lastInsertRowid;
  let n = 0;
  const add = (priority, read = 0) => {
    const id = db.prepare('INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, thread_id, subject, from_addr, to_json, date, is_read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(uid, acc, inbox, ++n, `u${n}@x`, `t${n}`, `Mail ${n}`, 'a@x.example', '[]', Date.now(), read, Date.now()).lastInsertRowid;
    if (priority != null) db.prepare("INSERT INTO ai_insights (message_id, priority, category, created_at) VALUES (?, ?, 'work', ?)").run(id, priority, Date.now());
  };
  add(90); add(80); add(30); add(null); add(95, 1);
  // Without Focused Inbox the strong count is the important mail (with it: the Focused count, see round42).
  await api('PATCH', '/api/settings', { mail: { focusedInbox: false } });
  const f = await api('GET', '/api/folders');
  const box = f.accounts.find((a) => a.accountId === acc).folders.find((x) => x.id === inbox);
  assert.deepEqual([box.unread, box.important], [4, 2]);
  assert.deepEqual([f.counts.unified, f.counts.unifiedImportant], [4, 2]);
});
