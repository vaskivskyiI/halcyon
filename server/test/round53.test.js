// Inkwell integration: the address and token are saved (token encrypted, never returned), Halcyon asks Inkwell which
// pages link to mail / events / tasks — several refs at once — and stays quiet when Inkwell is not set up or not there.
// Behind a private CA: its certificate (fixtures/tls: test CA, and a server certificate for 127.0.0.1) or no check.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r53-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

const TOKEN = 'ink_test_0123456789abcdef';
let app, base, cookie = '', db, ink, inkBase, seen = [];
async function call(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return { status: r.status, data: await r.json() };
}
const api = async (method, url, body) => {
  const r = await call(method, url, body);
  if (r.status >= 400) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
};

// A fake Inkwell: answers /api/links/lookup like the real one (url relative when INKWELL_PUBLIC_URL is not set).
const PAGES = [
  { ref: '42', id: 'p1', title: 'Kick-off notes', icon: '🗓️', kind: 'page', updatedAt: 1700000000000, snippet: 'Agenda', url: '/#/n/p1' },
  { ref: '43', id: 'p2', title: 'Follow-up', icon: null, kind: 'page', updatedAt: 1700000001000, snippet: '', url: 'https://notes.example.org/#/n/p2' },
  { ref: '43', id: 'p3', title: 'Sneaky', icon: null, kind: 'page', updatedAt: 1, snippet: '', url: 'javascript:alert(1)' },
  { ref: '99', id: 'p4', title: 'Not asked for', url: '/#/n/p4' },
];
function handler(req, res) {
  const u = new URL(req.url, 'http://x');
  seen.push({ path: u.pathname, kind: u.searchParams.get('kind'), ref: u.searchParams.get('ref'), auth: req.headers.authorization });
  res.setHeader('content-type', 'application/json');
  if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'bad token' })); }
  if (u.pathname !== '/api/links/lookup') { res.statusCode = 404; return res.end('{}'); }
  const refs = String(u.searchParams.get('ref') || '').split(',');
  // Like the real one, but also the page for ref 99: Halcyon must only pass on what it asked for.
  res.end(JSON.stringify(u.searchParams.get('kind') === 'event' ? PAGES.filter((p) => refs.includes(p.ref) || p.ref === '99') : []));
}
before(async () => {
  ink = http.createServer(handler);
  await new Promise((r) => ink.listen(0, '127.0.0.1', r));
  inkBase = `http://127.0.0.1:${ink.address().port}`;

  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  await api('PATCH', '/api/settings', { ai: { enabled: false } });
});
after(async () => { await app?.close(); ink?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('not set up: no url, no links, and Inkwell is not asked', async () => {
  assert.deepEqual(await api('GET', '/api/integrations/inkwell'), { url: '', hasToken: false, configured: false, tls: { ca: '', insecure: false } });
  assert.deepEqual(await api('GET', '/api/integrations/inkwell/links?kind=event&ref=42'), { url: null, links: [] });
  assert.equal(seen.length, 0);
});

test('saving: only http(s) addresses and ink_ tokens; the token is encrypted and never returned', async () => {
  assert.equal((await call('PUT', '/api/integrations/inkwell', { url: 'ftp://notes.example.org', token: TOKEN })).status, 400);
  assert.equal((await call('PUT', '/api/integrations/inkwell', { url: inkBase, token: 'hmcp_wrong_kind' })).status, 400);
  const saved = await api('PUT', '/api/integrations/inkwell', { url: `${inkBase}/`, token: TOKEN });
  assert.deepEqual(saved, { url: inkBase, hasToken: true, configured: true, tls: { ca: '', insecure: false } }, 'trailing slash dropped, no token in the answer');
  assert.ok(!JSON.stringify(await api('GET', '/api/integrations/inkwell')).includes(TOKEN));
  assert.ok(!JSON.stringify(await api('GET', '/api/me')).includes(TOKEN));
  const row = db.prepare("SELECT token_enc FROM integrations WHERE kind = 'inkwell'").get();
  assert.ok(row.token_enc.startsWith('v1:') && !row.token_enc.includes(TOKEN));
  // Changing only the address keeps the token.
  assert.equal((await api('PUT', '/api/integrations/inkwell', { url: inkBase })).hasToken, true);
  assert.deepEqual(await api('POST', '/api/integrations/inkwell/test'), { ok: true });
});

test('links: refs batched in one request with the token; urls absolute and http(s) only; only refs asked for', async () => {
  seen = [];
  const r = await api('GET', '/api/integrations/inkwell/links?kind=event&ref=42,43,42,abc');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { path: '/api/links/lookup', kind: 'event', ref: '42,43', auth: `Bearer ${TOKEN}` });
  assert.equal(r.url, inkBase);
  assert.deepEqual(r.links.map((l) => [l.ref, l.id, l.url]), [
    ['42', 'p1', `${inkBase}/#/n/p1`], ['43', 'p2', 'https://notes.example.org/#/n/p2'], ['43', 'p3', `${inkBase}/#/n/p3`],
  ]);
  assert.deepEqual(r.links[0], { ref: '42', id: 'p1', title: 'Kick-off notes', icon: '🗓️', kind: 'page', updatedAt: 1700000000000, snippet: 'Agenda', url: `${inkBase}/#/n/p1` });
  assert.deepEqual(await api('GET', '/api/integrations/inkwell/links?kind=task&ref=7'), { url: inkBase, links: [] }, 'set up, nothing linked: the url still comes (for "New note")');
  assert.equal((await call('GET', '/api/integrations/inkwell/links?kind=contact&ref=1')).status, 400);
});

test('Inkwell refusing the token or not reachable: no url, no links (the views look as without it)', async () => {
  db.prepare("UPDATE integrations SET token_enc = NULL WHERE kind = 'inkwell'").run();
  assert.deepEqual(await api('GET', '/api/integrations/inkwell/links?kind=event&ref=42'), { url: null, links: [] }, 'no token: not set up');
  await api('PUT', '/api/integrations/inkwell', { url: inkBase, token: 'ink_revoked' });
  const refused = await api('GET', '/api/integrations/inkwell/links?kind=event&ref=42');
  assert.deepEqual([refused.url, refused.links], [null, []]);
  assert.match(refused.error, /token/);
  assert.equal((await api('POST', '/api/integrations/inkwell/test')).ok, false);

  await new Promise((r) => ink.close(r));
  await api('PUT', '/api/integrations/inkwell', { url: inkBase, token: TOKEN });
  const down = await api('GET', '/api/integrations/inkwell/links?kind=event&ref=42');
  assert.deepEqual([down.url, down.links], [null, []]);
  assert.ok(down.error);

  assert.deepEqual(await api('PUT', '/api/integrations/inkwell', { url: '' }), { url: '', hasToken: false, configured: false, tls: { ca: '', insecure: false } });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM integrations").get().n, 0);
});

test('Inkwell behind a private CA: refused until its CA is added or checking is switched off', async () => {
  const fx = (f) => fs.readFileSync(new URL(`./fixtures/tls/${f}`, import.meta.url), 'utf8');
  const secure = https.createServer({ key: fx('server.key'), cert: fx('server.pem') }, handler);
  await new Promise((r) => secure.listen(0, '127.0.0.1', r));
  const url = `https://127.0.0.1:${secure.address().port}`;
  try {
    await api('PUT', '/api/integrations/inkwell', { url, token: TOKEN });
    const untrusted = await api('GET', '/api/integrations/inkwell/links?kind=event&ref=42');
    assert.deepEqual([untrusted.url, untrusted.links], [null, []]);
    assert.match(untrusted.error, /certificate is not trusted/);
    assert.match((await api('POST', '/api/integrations/inkwell/test')).error, /certificate authority/);

    assert.equal((await call('PUT', '/api/integrations/inkwell', { url, tls: { ca: 'not a certificate' } })).status, 400);
    const saved = await api('PUT', '/api/integrations/inkwell', { url, tls: { ca: fx('ca.pem'), insecure: false } });
    assert.deepEqual([saved.configured, saved.tls.insecure, saved.tls.ca.startsWith('-----BEGIN CERTIFICATE-----')], [true, false, true]);
    assert.deepEqual((await api('GET', '/api/integrations/inkwell/links?kind=event&ref=42')).links.map((l) => l.id), ['p1']);
    assert.equal((await api('PUT', '/api/integrations/inkwell', { url })).tls.ca, saved.tls.ca, 'kept when not sent');

    await api('PUT', '/api/integrations/inkwell', { url, tls: { ca: '', insecure: true } });
    assert.deepEqual((await api('GET', '/api/integrations/inkwell/links?kind=event&ref=42')).links.map((l) => l.id), ['p1']);
    await api('PUT', '/api/integrations/inkwell', { url, tls: { ca: '', insecure: false } });
    assert.ok((await api('GET', '/api/integrations/inkwell/links?kind=event&ref=42')).error, 'checked again');
  } finally { await new Promise((r) => secure.close(r)); }
});
