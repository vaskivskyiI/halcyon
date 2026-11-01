// Calendars, tasks and contacts come from connections of their own, not from mail accounts: existing combined accounts
// are split, mail and calendar/contacts are never one row again, and lists say which connection they come from.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r68-test-'));
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, me = '', db, uid, mailId;
async function call(method, url, body) {
  const r = await fetch(base + url, { method, headers: { cookie: me, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) me = sc.split(';')[0];
  return { status: r.status, data: await r.json() };
}

before(async () => {
  // A database as it was before the split (migration 49): one account with mail, a calendar and contacts.
  const { config } = await import('../src/config.js');
  const { migrations } = await import('../src/db/schema.js');
  const Database = (await import('better-sqlite3')).default;
  const old = new Database(config.dbPath);
  old.function('fold', { deterministic: true }, (s) => (s == null ? s : String(s).toLowerCase()));
  for (let v = 0; v < 48; v++) old.exec(migrations[v]);
  old.pragma('user_version = 48');
  old.prepare("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES (1, 'me@x.example', 'Me', 'x', 1, 0)").run();
  old.prepare(`INSERT INTO accounts (id, user_id, email, imap_host, imap_user, imap_pass_enc, smtp_host, caldav_url, carddav_url, dav_user, dav_pass_enc, space, tls_insecure, created_at)
    VALUES (7, 1, 'igor@ijs.example', 'imap.ijs.example', 'igor', 'imap-secret', 'smtp.ijs.example', 'https://calendar.krigo.example/dav.php/calendars/igor/default/', 'https://calendar.krigo.example/dav.php/addressbooks/igor/', NULL, NULL, 'IJS', 1, 0)`).run();
  old.prepare("INSERT INTO calendars (id, user_id, account_id, name, source, url, created_at) VALUES (11, 1, 7, 'Igor IJS', 'caldav', 'https://calendar.krigo.example/c/', 0)").run();
  old.prepare("INSERT INTO address_books (id, user_id, account_id, name, source, url, created_at) VALUES (5, 1, 7, 'Igor IJS', 'carddav', 'https://calendar.krigo.example/b/', 0)").run();
  old.prepare("INSERT INTO task_lists (id, user_id, account_id, name, source, url, created_at) VALUES (3, 1, 7, 'Igor IJS', 'caldav', 'https://calendar.krigo.example/c/', 0)").run();
  old.close();

  ({ db } = await import('../src/db/index.js'));
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  uid = 1; mailId = 7;
  const { hashPassword } = await import('../src/util/crypto.js');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = 1').run(hashPassword('password123'));
  assert.equal((await call('POST', '/api/auth/login', { email: 'me@x.example', password: 'password123' })).status, 200);
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

const conn = () => db.prepare('SELECT * FROM accounts WHERE split_from = ?').get(mailId);

test('a mail account with calendars and contacts is split into the mail account and a connection', () => {
  const mail = db.prepare('SELECT * FROM accounts WHERE id = ?').get(mailId);
  assert.equal(mail.caldav_url, null);
  assert.equal(mail.carddav_url, null);
  assert.equal(mail.mail, 1);
  const c = conn();
  assert.ok(c, 'connection made');
  assert.equal(c.mail, 0);
  assert.equal(c.name, 'calendar.krigo.example');
  assert.equal(c.caldav_url, 'https://calendar.krigo.example/dav.php/calendars/igor/default/');
  assert.equal(c.carddav_url, 'https://calendar.krigo.example/dav.php/addressbooks/igor/');
  assert.equal(c.dav_user, 'igor', 'the mail login when it had none of its own');
  assert.equal(c.dav_pass_enc, 'imap-secret');
  assert.equal(c.space, 'IJS');
  assert.equal(c.tls_insecure, 1);
  for (const [t, id] of [['calendars', 11], ['address_books', 5], ['task_lists', 3]]) {
    assert.equal(db.prepare(`SELECT account_id FROM ${t} WHERE id = ?`).get(id).account_id, c.id, `${t} moved along, same id`);
  }
});

test('connections are not mail: own addresses, invitations and lists name the connection', async () => {
  const { ownAddresses } = await import('../src/mail/store.js');
  db.prepare("UPDATE accounts SET email = 'dav-login@x.example' WHERE id = ?").run(conn().id);
  assert.ok(ownAddresses(uid).has('igor@ijs.example'));
  assert.ok(!ownAddresses(uid).has('dav-login@x.example'));
  const { mailAccounts, serializeAccount } = await import('../src/accounts.js');
  assert.deepEqual(mailAccounts(uid).map((a) => a.id), [mailId]);
  const s = serializeAccount(conn());
  assert.equal(s.connection, true);
  assert.equal(s.label, 'calendar.krigo.example');
  assert.equal(serializeAccount(db.prepare('SELECT * FROM accounts WHERE id = ?').get(mailId)).connection, false);
  const { originOf } = await import('../src/routes/spaces.js');
  assert.equal(originOf({ account_id: conn().id, source: 'caldav' }), 'calendar.krigo.example · synced');
});

test('mail and calendars are separate rows: asked for together, both are made; a mail account takes no calendar', async () => {
  const r = await call('POST', '/api/accounts', { email: 'ana@x.example', imap: { host: 'imap.x.example', user: 'ana', password: 'p' }, smtp: { host: 'smtp.x.example' },
    services: ['mail', 'calendar'], caldavUrl: 'https://127.0.0.1:1/dav/', connectionName: 'Home' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const rows = db.prepare("SELECT * FROM accounts WHERE email = 'ana@x.example' ORDER BY id").all();
  assert.deepEqual(rows.map((a) => [a.mail, !!a.caldav_url]), [[0, true], [1, false]]);
  assert.equal(rows[0].name, 'Home');
  assert.equal(rows[0].dav_user, 'ana');
  assert.equal((await call('POST', `/api/accounts/${rows[1].id}/services/calendar`, { url: 'https://127.0.0.1:1/dav/' })).status, 400);
  assert.equal((await call('POST', `/api/accounts/${rows[0].id}/services/mail`, { imap: { host: 'x' }, smtp: { host: 'y' } })).status, 400);
});
