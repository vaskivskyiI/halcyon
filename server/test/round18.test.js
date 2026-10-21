// Replies from the address a message was sent to (aliases allowed, nothing else), overlap checks across spaces, and the
// sign-in window that reports back even when the identity provider cut its link to the app.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r18-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, uid;
async function api(method, url, body, headers = {}) {
  const r = await fetch(base + url, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}

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

test('mail goes out from the account address or one of its aliases — never from another address', async () => {
  const { buildMime } = await import('../src/mail/send.js');
  const account = { email: 'igor@ijs.si', display_name: 'Igor', aliases_json: JSON.stringify([{ address: 'info@ijs.si' }, 'office@ijs.si']) };
  const from = async (address) => (await buildMime(account, { from: { address, name: 'Igor' }, to: ['a@x.example'], subject: 's', text: 't' })).toString().match(/^From: (.*)$/m)[1];
  assert.match(await from('info@ijs.si'), /<info@ijs\.si>/);
  assert.match(await from('OFFICE@ijs.si'), /office@ijs\.si/i);
  assert.match(await from('ceo@bank.example'), /<igor@ijs\.si>/, 'a foreign address is replaced by the account');
  assert.match(await from(undefined), /<igor@ijs\.si>/);
});

test('the overlap check sees events of every space and says which space they are in', async () => {
  const work = await api('POST', '/api/calendars', { name: 'Work cal', space: 'Work' });
  const home = await api('POST', '/api/calendars', { name: 'Home cal', space: 'Private' });
  const t = Date.parse('2026-11-02T08:00:00Z');
  await api('POST', '/api/events', { calendarId: home.id, title: 'Dentist', start: t, end: t + 3600e3 }, { 'x-halcyon-space': 'Private' });
  const inWork = await api('GET', `/api/events?from=${t}&to=${t + 3600e3}`, undefined, { 'x-halcyon-space': 'Work' });
  assert.equal(inWork.length, 0, 'the Work view itself does not show private events');
  const all = await api('GET', `/api/events?from=${t}&to=${t + 3600e3}&allSpaces=1`, undefined, { 'x-halcyon-space': 'Work' });
  assert.deepEqual(all.map((e) => [e.title, e.space, e.calendarName]), [['Dentist', 'Private', 'Home cal']]);
  assert.ok(work.id);
});

test('the sign-in window reports back over a channel that survives the identity provider cutting window.opener', async () => {
  const html = await api('GET', '/api/oauth/callback?state=unknown');
  assert.match(html, /BroadcastChannel\('halcyon-oauth'\)/);
  assert.match(html, /ok: false/);
  assert.match(html, /postMessage\(m, location\.origin\)/, 'no longer posts to any origin');
  assert.match(html, /window\.close\(\)/);
});
