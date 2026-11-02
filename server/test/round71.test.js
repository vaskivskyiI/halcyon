// A shared space is set up once, by its owners, for everyone in it; members keep their own habits. Inkwell of the same
// suite reaches mail and is reached with the sign-on secret, so nobody pastes tokens.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r71-test-'));
process.env.HALCYON_LOG_LEVEL = 'error';
process.env.HALCYON_SSO_SECRET = 'suite-secret-123';

let app, base, db, owner, member, space;
const jar = { owner: '', member: '' };
async function api(who, method, url, body, headers = {}) {
  const r = await fetch(base + url, { method, headers: { cookie: jar[who] || '', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc && who) jar[who] = sc.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => null) };
}
const as = (who, method, url, body) => api(who, method, url, body, { 'x-halcyon-as': String(space) });

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  await api('owner', 'POST', '/api/auth/setup', { email: 'owner@example.org', name: 'Owner', password: 'password123' });
  owner = db.prepare("SELECT id FROM users WHERE email = 'owner@example.org'").get().id;
  const { createUser } = await import('../src/auth.js');
  member = createUser({ email: 'member@example.org', name: 'Member', password: 'password123' }).id;
  assert.equal((await api('member', 'POST', '/api/auth/login', { email: 'member@example.org', password: 'password123' })).status, 200);
  await api('owner', 'PATCH', '/api/settings', { ui: { language: 'sl' } });
  space = (await api('owner', 'POST', '/api/shared', { name: 'Studio' })).data.id;
  assert.equal((await api('owner', 'POST', `/api/shared/${space}/members`, { email: 'member@example.org' })).status, 200);
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('only owners change the space; members keep their own habits; the space writes in its owner\'s language', async () => {
  assert.equal((await as('member', 'PATCH', '/api/settings', { ai: { summaryLanguage: 'German' } })).status, 403);
  assert.equal((await as('member', 'POST', '/api/rules', { name: 'x', conditions: [], actions: [] })).status, 403);
  assert.equal((await as('member', 'POST', '/api/custom-categories', { name: 'Invoices' })).status, 403);
  assert.equal((await as('owner', 'PATCH', '/api/settings', { ai: { summaryLanguage: 'German' } })).status, 200);
  const { getSettings } = await import('../src/settings.js');
  assert.equal(getSettings(space).ai.summaryLanguage, 'German');

  // Habits are the member's own, also inside the space; the space's values stay as they were.
  const r = await as('member', 'PATCH', '/api/settings', { mail: { loadRemoteImages: true, undoSendSeconds: 30 }, ui: { theme: 'dark' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.mail.loadRemoteImages, true);
  assert.equal(getSettings(member).mail.undoSendSeconds, 30);
  assert.equal(getSettings(space).mail.undoSendSeconds, 10);
  assert.equal((await as('owner', 'GET', '/api/me')).data.settings.mail.undoSendSeconds, 10, 'the owner has their own');

  // Recent searches are the person's (on every device), and a shorter list replaces the longer one.
  await as('member', 'PATCH', '/api/settings', { ui: { recentSearches: ['budget', 'from:ana'] } });
  assert.deepEqual((await as('member', 'PATCH', '/api/settings', { ui: { recentSearches: ['from:ana'] } })).data.ui.recentSearches, ['from:ana']);
  assert.deepEqual(getSettings(member).ui.recentSearches, ['from:ana']);
  assert.deepEqual(getSettings(space).ui.recentSearches, []);

  // A member's device zone never moves the space's.
  const tz0 = getSettings(space).calendar.timezone;
  assert.equal((await as('member', 'PATCH', '/api/settings', { calendar: { tzAuto: true } })).status, 200, 'only the ignored zone switch: allowed, nothing changes');
  assert.equal(getSettings(space).calendar.timezone, tz0);
  assert.equal(getSettings(space).calendar.tzAuto, false);
  assert.equal((await as('member', 'PATCH', '/api/settings', { calendar: { timezone: 'Asia/Tokyo' } })).status, 403);

  assert.equal(getSettings(space).ui.language, 'sl', 'the AI of the space writes in the owner\'s language');
  assert.equal((await api('member', 'GET', '/api/auth/status', undefined, { 'x-halcyon-as': String(space) })).data.acting.role, 'member');
});

test('Inkwell reaches mail with the sign-on secret, as the person, only where they are a member; it can be turned off', async () => {
  const mcp = (headers) => fetch(`${base}/api/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer suite-secret-123', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tasks', arguments: {} } }) });
  assert.equal((await mcp({ 'x-halcyon-sub': String(member) })).status, 200);
  assert.equal((await mcp({ 'x-halcyon-sub': String(member), 'x-halcyon-target': String(space) })).status, 200);
  assert.equal((await mcp({ 'x-halcyon-sub': String(member), 'x-halcyon-target': String(owner) })).status, 401, 'not someone else\'s mail');
  assert.equal((await mcp({ 'x-halcyon-sub': String(space) })).status, 401, 'a space is not a person');
  assert.equal((await mcp({ 'x-halcyon-sub': String(member), authorization: 'Bearer wrong' })).status, 401);

  const list = (await api('member', 'GET', '/api/mcp-tokens')).data;
  const g = list.find((t) => t.suite && t.targetId === space);
  assert.deepEqual([g.name, g.access, g.target], ['Inkwell (through sign-in)', 'propose', 'Studio']);
  await api('member', 'DELETE', `/api/mcp-tokens/${g.id}`);
  assert.equal((await mcp({ 'x-halcyon-sub': String(member), 'x-halcyon-target': String(space) })).status, 401, 'turned off');
  assert.ok((await api('member', 'GET', '/api/mcp-tokens')).data.find((t) => t.id === g.id).off, 'still listed, to turn on again');
  await api('member', 'POST', `/api/mcp-tokens/${g.id}/restore`);
  assert.equal((await mcp({ 'x-halcyon-sub': String(member), 'x-halcyon-target': String(space) })).status, 200);
});

test('Halcyon asks the suite\'s Inkwell as the person, with the secret; a person without Inkwell sees nothing', async () => {
  const seen = [];
  const ink = http.createServer((req, res) => {
    seen.push([req.url.split('?')[0], req.headers.authorization, req.headers['x-halcyon-sub']]);
    res.setHeader('content-type', 'application/json');
    if (req.headers['x-halcyon-sub'] !== String(owner)) { res.statusCode = 401; return res.end('{}'); }
    res.end(req.url.startsWith('/api/recent') ? JSON.stringify([{ id: 'n1', title: 'Plan' }]) : '[]');
  });
  await new Promise((r) => ink.listen(0, '127.0.0.1', r));
  process.env.HALCYON_INKWELL_URL = `http://127.0.0.1:${ink.address().port}`;
  const st = (await api('owner', 'GET', '/api/integrations/inkwell')).data;
  assert.deepEqual([st.configured, st.suite, st.hasToken], [true, true, false]);
  assert.deepEqual((await api('owner', 'GET', '/api/integrations/inkwell/home')).data.recent.map((n) => n.title), ['Plan']);
  assert.deepEqual(seen[0], ['/api/recent', 'Bearer suite-secret-123', String(owner)]);
  // Also inside the shared space: the person's own Inkwell (which has the space's pages).
  assert.equal((await api('owner', 'GET', '/api/integrations/inkwell/links?kind=email&ref=1', undefined, { 'x-halcyon-as': String(space) })).data.url, process.env.HALCYON_INKWELL_URL);
  assert.equal(seen.at(-1)[2], String(owner));
  const m = (await api('member', 'GET', '/api/integrations/inkwell/home')).data;
  assert.deepEqual([m.recent, m.error], [[], undefined], 'never signed in to Inkwell: nothing, quietly');
  ink.close();
  delete process.env.HALCYON_INKWELL_URL;
});
