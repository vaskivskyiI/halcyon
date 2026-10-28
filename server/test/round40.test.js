// An account's services (mail, calendar, contacts) are separate: a calendar-only account never touches mail; services
// are added / removed later. Spaces can be renamed, merged and removed; defaults per space; address books renamed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r40-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';
const DAV = process.env.TEST_DAV_URL;

let app, base, cookie = '', db, uid;
async function api(method, url, body, headers = {}) {
  const r = await fetch(base + url, { method, headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  await api('POST', '/api/auth/setup', { email: 'alice@test.local', name: 'Alice', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('a calendar-only account: no mail anywhere, and it says what it found', async () => {
  const a = await api('POST', '/api/accounts', { services: ['calendar'], caldavUrl: 'http://127.0.0.1:9/dav/', davUser: 'alice', davPassword: 'x' });
  assert.deepEqual(a.services, { mail: false, calendar: true, contacts: false });
  assert.equal(a.email, 'alice');
  assert.match(a.dav.error, /could not be reached/);
  const { syncManager } = await import('../src/mail/sync.js');
  assert.ok(!syncManager.workers.has(a.id), 'no mail sync for it');
  assert.ok(!(await api('GET', '/api/folders')).accounts.some((x) => x.accountId === a.id), 'not in the mail folders');
  await assert.rejects(api('POST', '/api/send', { accountId: a.id, to: [{ address: 'x@y.example' }], subject: 's', html: 'x' }), /calendar \/ contacts only/);
  await assert.rejects(api('POST', '/api/accounts', { services: [] }), /Choose what to add|IMAP/);
  // Its last service removed: the account goes.
  const r = await api('DELETE', `/api/accounts/${a.id}/services/calendar`);
  assert.equal(r.removed, true);
  assert.ok(!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(a.id));
});

test('services are added and removed later (only what Halcyon keeps is removed)', { skip: !DAV && 'set TEST_DAV_URL' }, async () => {
  const a = await api('POST', '/api/accounts', { services: ['calendar'], caldavUrl: DAV, davUser: 'alice', davPassword: 'secret123', name: 'Family' });
  assert.equal(a.dav.error, null);
  assert.ok(a.dav.calendars >= 1);
  const c = await api('POST', `/api/accounts/${a.id}/services/contacts`, { url: DAV });
  assert.deepEqual(c.services, { mail: false, calendar: true, contacts: true });
  assert.ok(c.dav.books >= 1);
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM calendars WHERE account_id = ? AND source = 'caldav'").get(a.id).n >= 1);
  const r = await api('DELETE', `/api/accounts/${a.id}/services/calendar`);
  assert.deepEqual(r.services, { mail: false, calendar: false, contacts: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendars WHERE account_id = ?').get(a.id).n, 0);
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM address_books WHERE account_id = ?').get(a.id).n >= 1);
});

test('spaces are renamed (merged) and removed; what the assistant knows for one moves along', async () => {
  const acc = db.prepare("INSERT INTO accounts (user_id, email, space, sync_enabled, created_at) VALUES (?, 'work@test.local', 'Work', 0, ?)").run(uid, Date.now()).lastInsertRowid;
  const book = db.prepare("INSERT INTO address_books (user_id, name, source, space, created_at) VALUES (?, 'Clients', 'local', 'Work', ?)").run(uid, Date.now()).lastInsertRowid;
  db.prepare("INSERT INTO facts (user_id, owner, text, created_at) VALUES (?, 's:Work', 'Works at NM Studio', ?)").run(uid, Date.now());
  await api('PATCH', '/api/settings', { defaults: { Work: { bookId: book } } });
  let r = await api('POST', '/api/spaces/rename', { from: 'Work', to: 'Studio' });
  assert.deepEqual(r.spaces, ['Studio']);
  assert.equal(db.prepare('SELECT owner FROM facts').get().owner, 's:Studio');
  assert.equal((await api('GET', '/api/me')).settings.defaults.Studio.bookId, book, 'its defaults go along');
  // The default address book of the space is used for new contacts there.
  const c = await api('POST', '/api/contacts', { displayName: 'Ana' }, { 'x-halcyon-space': 'Studio' });
  assert.equal(c.addressBookId, book);
  r = await api('POST', '/api/spaces/rename', { from: 'Studio', to: '' });
  assert.deepEqual(r.spaces, []);
  assert.equal(db.prepare('SELECT space FROM accounts WHERE id = ?').get(acc).space, '', 'removed → shared, nothing deleted');
  assert.equal(db.prepare('SELECT space FROM address_books WHERE id = ?').get(book).space, '');
});

test('address books are renamed and one is the default; calendars and books say where they come from', async () => {
  const b = db.prepare("INSERT INTO address_books (user_id, name, source, created_at) VALUES (?, 'Contacts', 'local', ?)").run(uid, Date.now()).lastInsertRowid;
  await api('PATCH', `/api/address-books/${b}`, { name: 'Family', isDefault: true });
  const books = await api('GET', '/api/address-books');
  assert.deepEqual(books.filter((x) => x.isDefault).map((x) => x.name), ['Family']);
  const sp = await api('GET', '/api/spaces');
  assert.equal(sp.addressBooks.find((x) => x.id === b).origin, 'Kept in Halcyon only (on no other server)');
  assert.ok(sp.calendars.every((x) => x.origin));
  const c = await api('POST', '/api/contacts', { displayName: 'Bob' });
  assert.equal(c.addressBookId, b, 'new contacts go to the default address book');
});

test('Google sign-in asks only for the services chosen', async () => {
  const { authorizeUrl } = await import('../src/mail/oauth.js');
  const scope = (s) => new URL(authorizeUrl('google', 'st', 'https://x/cb', s)).searchParams.get('scope');
  assert.ok(scope(['calendar']).includes('auth/calendar') && !scope(['calendar']).includes('mail.google.com'));
  assert.ok(scope(['mail', 'contacts']).includes('mail.google.com') && scope(['mail', 'contacts']).includes('carddav') && !scope(['mail', 'contacts']).includes('auth/calendar'));
  assert.ok(scope([]).includes('mail.google.com') && scope([]).includes('auth/calendar'), 'nothing chosen → all');
  assert.equal(new URL(authorizeUrl('google', 'st', 'https://x/cb', ['calendar'])).searchParams.get('include_granted_scopes'), 'true');
});
