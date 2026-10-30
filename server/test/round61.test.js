// One login, several kinds of access: the AI sees what the login sees; anything can be shared; a companion app signs in.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r61-test-'));
process.env.HALCYON_LOG_LEVEL = 'error';
process.env.HALCYON_SSO_SECRET = 'sso-test-secret';
process.env.HALCYON_SSO_REDIRECTS = 'https://notes.test/api/auth/halcyon/callback';
const BACK = process.env.HALCYON_SSO_REDIRECTS;

let app, base, ann = '', ben = '', space, db, A, annId;
async function call(cookie, method, url, body, headers = {}) {
  const r = await fetch(base + url, { method, redirect: 'manual', headers: { cookie, ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  return { status: r.status, location: r.headers.get('location'), data: await r.json().catch(() => null), cookie: sc ? sc.split(';')[0] : cookie };
}
const data = async (...a) => (await call(...a)).data;
const inbox = (uid, acc) => db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'Inbox', '\\Inbox')").run(acc).lastInsertRowid;
function mail(uid, email, subject, text) {
  const acc = db.prepare('INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, ?, 0, ?)').run(uid, email, Date.now()).lastInsertRowid;
  return db.prepare('INSERT INTO messages (user_id, account_id, folder_id, message_id, thread_id, subject, subject_key, from_addr, body_text, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(uid, acc, inbox(uid, acc), `<${subject}@x>`, `t-${subject}`, subject, subject, 'a@x.example', text, Date.now() - 36e5).lastInsertRowid;
}

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  A = await import('../src/ai/assistant.js');
  const s = await call('', 'POST', '/api/auth/setup', { email: 'ann@example.org', name: 'Ann', password: 'password123' });
  ann = s.cookie; annId = s.data.user.id;
  await call(ann, 'POST', '/api/admin/users', { email: 'ben@example.org', name: 'Ben', password: 'password123' });
  ben = (await call('', 'POST', '/api/auth/login', { email: 'ben@example.org', password: 'password123' })).cookie;
  space = (await data(ann, 'POST', '/api/shared', { name: 'Work' })).id;
  await call(ann, 'POST', `/api/shared/${space}/members`, { email: 'ben@example.org' });
  await call(ann, 'POST', '/api/ai/providers', { type: 'mock', name: 'Mock' });
  await call(ann, 'POST', '/api/ai/providers', { type: 'mock', name: 'Mock' }, { 'x-halcyon-as': String(space) });
  mail(annId, 'ann@private.example', 'Holiday plans', 'The zebra holiday is booked.');
  mail(space, 'work@firm.example', 'Budget review', 'The zebra budget is approved.');
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

const answer = async (uid) => {
  const seen = [];
  const r = await A.ask(uid, { question: 'What about the zebra?' }, null, { onStatus: () => {} });
  seen.push(...r.sources.map((s) => s.subject));
  return seen;
};

test('a login with both sees both; with the space hidden, only its own; the space itself only the space', async () => {
  assert.deepEqual((await answer(annId)).sort(), ['Holiday plans']);
  await call(ann, 'PATCH', '/api/settings', { ui: { showShared: true } });
  assert.deepEqual((await answer(annId)).sort(), ['Budget review', 'Holiday plans']);
  assert.deepEqual(await answer(space), ['Budget review']);
});

test('a login that only has the space never reaches private mail', async () => {
  const benId = db.prepare("SELECT id FROM users WHERE email = 'ben@example.org'").get().id;
  await call(ben, 'PATCH', '/api/settings', { ui: { showShared: true } });
  await call(ben, 'POST', '/api/ai/providers', { type: 'mock', name: 'Mock' });
  assert.deepEqual(await answer(benId), ['Budget review']);
});

test('a space that keeps its AI local is not given to a cloud-capable login', async () => {
  const { saveSettings } = await import('../src/settings.js');
  saveSettings(space, { ai: { privacyMode: true } });
  assert.deepEqual(await answer(annId), ['Holiday plans']);
  saveSettings(annId, { ai: { privacyMode: true } });
  assert.equal((await answer(annId)).length >= 1, true);
  saveSettings(space, { ai: { privacyMode: false } });
  saveSettings(annId, { ai: { privacyMode: false } });
});

test('read-only, server and account-synced calendars and contacts can be shared; a server\'s calendars go together', async () => {
  const src = db.prepare("INSERT INTO calendar_sources (user_id, name, url, created_at) VALUES (?, 'Colleagues', 'https://dav.example/', ?)").run(annId, Date.now()).lastInsertRowid;
  const add = (name, extra = {}) => db.prepare('INSERT INTO calendars (user_id, name, source, url, readonly, source_id, account_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(annId, name, extra.source || 'caldav', extra.url || `https://dav.example/${name}`, extra.readonly ?? 1, extra.src ?? null, extra.acc ?? null, Date.now()).lastInsertRowid;
  const a = add('Info A', { src }), b = add('Info B', { src });
  assert.equal((await call(ann, 'POST', `/api/shared/${space}/move-in`, { calendarId: a })).status, 200);
  assert.equal(db.prepare('SELECT user_id FROM calendars WHERE id = ?').get(b).user_id, space, 'same server login');
  assert.equal(db.prepare('SELECT user_id FROM calendar_sources WHERE id = ?').get(src).user_id, space);
  const acc = db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, 'own@x.example', 0, ?)").run(annId, Date.now()).lastInsertRowid;
  const synced = add('Synced', { acc, readonly: 0 });
  assert.equal((await call(ann, 'POST', `/api/shared/${space}/move-in`, { calendarId: synced })).status, 200);
  assert.equal(db.prepare('SELECT account_id FROM calendars WHERE id = ?').get(synced).account_id, acc, 'still synced through the account');
  const book = db.prepare("INSERT INTO address_books (user_id, account_id, name, source, url, created_at) VALUES (?, ?, 'Synced book', 'carddav', 'https://dav.example/b', ?)").run(annId, acc, Date.now()).lastInsertRowid;
  assert.equal((await call(ann, 'POST', `/api/shared/${space}/move-in`, { addressBookId: book })).status, 200);
});

test('sign-in for a companion app: only to the configured address, one use, and only with the secret', async () => {
  const auth = `/api/sso/authorize?redirect_uri=${encodeURIComponent(BACK)}&state=abc`;
  assert.equal((await call(ann, 'GET', `/api/sso/authorize?redirect_uri=${encodeURIComponent('https://evil.test/cb')}&state=abc`)).status, 400);
  const anon = await call('', 'GET', auth);
  assert.equal(anon.status, 302);
  assert.match(anon.location, /^\/\?sso=/, 'not signed in: sign in first');
  const ok = await call(ann, 'GET', auth);
  const to = new URL(ok.location);
  assert.equal(`${to.origin}${to.pathname}`, BACK);
  assert.equal(to.searchParams.get('state'), 'abc');
  const code = to.searchParams.get('code');
  const secret = { authorization: 'Bearer sso-test-secret' };
  assert.equal((await call('', 'POST', '/api/sso/token', { code, redirect_uri: BACK }, { authorization: 'Bearer nope' })).status, 401);
  const r = await call('', 'POST', '/api/sso/token', { code, redirect_uri: BACK }, secret);
  assert.deepEqual([r.data.email, r.data.sub], ['ann@example.org', String(annId)]);
  assert.equal((await call('', 'POST', '/api/sso/token', { code, redirect_uri: BACK }, secret)).status, 400, 'one use');
  const spaces = await data('', 'POST', '/api/sso/spaces', {}, secret);
  assert.deepEqual(spaces.find((s) => s.id === String(space)).members.map((m) => m.role).sort(), ['member', 'owner'].sort());
  assert.equal((await call(ann, 'POST', '/api/sso/spaces', {})).status, 401, 'a session is not the secret');
});
