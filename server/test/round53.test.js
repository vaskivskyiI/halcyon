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
  { ref: '42', id: 'p1', title: 'Kick-off notes', icon: '🗓️', kind: 'page', updatedAt: 1700000000000, snippet: 'Agenda', url: '/#/n/p1', date: 'nonsense' },
  { ref: '43', id: 'p2', title: 'Follow-up', icon: null, kind: 'page', updatedAt: 1700000001000, snippet: '', date: '2026-11-01', url: 'https://notes.example.org/#/n/p2' },
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
  assert.deepEqual(r.links[0], { ref: '42', id: 'p1', title: 'Kick-off notes', icon: '🗓️', kind: 'page', updatedAt: 1700000000000, snippet: 'Agenda', date: null, url: `${inkBase}/#/n/p1` });
  assert.equal(r.links[1].date, '2026-11-01', 'the date of the linked occurrence comes along');
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

test('"New note in Inkwell" opens Inkwell\'s #/new with the item, URL-encoded', async () => {
  const { inkwellNewUrl, occurrenceDay } = await import('../src/util/inkwell.js');
  const ev = inkwellNewUrl('https://notes.example.org', 'event', { ref: 42, title: 'Kick-off & plan', start: Date.UTC(2026, 10, 1, 9), end: Date.UTC(2026, 10, 1, 10), location: 'Room 4', attendees: ['Ana Novak', 'bob@x.si'] });
  assert.equal(ev, 'https://notes.example.org/#/new?kind=event&ref=42&title=Kick-off%20%26%20plan&start=2026-11-01T09%3A00%3A00.000Z&end=2026-11-01T10%3A00%3A00.000Z&location=Room%204&attendees=Ana%20Novak%2C%20bob%40x.si&day=' + occurrenceDay(Date.UTC(2026, 10, 1, 9)));
  const q = new URLSearchParams(ev.split('#/new?')[1]);
  assert.deepEqual([q.get('title'), q.get('attendees')], ['Kick-off & plan', 'Ana Novak, bob@x.si']);
  const mail = new URLSearchParams(inkwellNewUrl('https://n.example', 'email', { ref: 7, title: 'a+b?', from: 'Ana <ana@x.si>', date: 0, due: null }).split('?')[1]);
  assert.deepEqual(Object.fromEntries(mail), { kind: 'email', ref: '7', title: 'a+b?', from: 'Ana <ana@x.si>', date: '1970-01-01T00:00:00.000Z' });
  assert.equal(inkwellNewUrl('https://n.example', 'task', { ref: 3, title: '', due: undefined }), 'https://n.example/#/new?kind=task&ref=3');
});

test('the deep link carries the space; a note belongs to an occurrence by its date', async () => {
  const { inkwellNewUrl, sameOccurrence, occurrenceDay } = await import('../src/util/inkwell.js');
  const q = (space) => new URLSearchParams(inkwellNewUrl('https://n.example', 'event', { ref: 5, start: 0, space }).split('?')[1]);
  assert.equal(q('Work & play').get('hspace'), 'Work & play');
  assert.equal(q('').has('hspace'), false, 'shared items have none');
  const day = new Date(2026, 10, 3, 23, 30).getTime(); // local time, whatever the zone of the test machine
  assert.equal(sameOccurrence('2026-11-03', day), true);
  assert.equal(sameOccurrence('2026-11-04', day), false);
  assert.equal(sameOccurrence(null, day), false);
  assert.equal(occurrenceDay(day), '2026-11-03');
  const dayOf = (kind, item) => new URLSearchParams(inkwellNewUrl('https://n.example', kind, { ref: 5, ...item }).split('?')[1]).get('day');
  assert.equal(dayOf('event', { start: day }), '2026-11-03', 'the same day Halcyon compares with');
  assert.equal(dayOf('event', { start: Date.UTC(2026, 10, 3), allDay: true }), '2026-11-03');
  assert.equal(dayOf('task', { due: day }), null, 'events only');
  assert.equal(sameOccurrence('2026-11-03', Date.UTC(2026, 10, 3), true), true, 'all-day events are stored at midnight UTC');
});

test('MCP spaces: list_spaces, the space argument, every item\'s space; a token\'s own space wins', async () => {
  const { createToken } = await import('../src/mcp/server.js');
  const uid = db.prepare('SELECT id FROM users').get().id;
  const insert = (sql, ...p) => db.prepare(sql).run(...p).lastInsertRowid;
  const account = (space) => insert('INSERT INTO accounts (user_id, email, space, sync_enabled, created_at) VALUES (?, ?, ?, 0, ?)', uid, `${space || 'shared'}@example.org`, space, Date.now());
  const work = account('Work'), priv = account('Private');
  const calendar = (space) => insert("INSERT INTO calendars (user_id, name, source, space, enabled) VALUES (?, ?, 'local', ?, 1)", uid, `cal ${space}`, space);
  const taskList = (space) => insert("INSERT INTO task_lists (user_id, name, source, space, created_at) VALUES (?, ?, 'local', ?, ?)", uid, `list ${space}`, space, Date.now());
  const soon = Date.now() + 36e5;
  const event = (cal, title) => insert('INSERT INTO events (calendar_id, uid, title, start, end) VALUES (?, ?, ?, ?, ?)', cal, title, title, soon, soon + 36e5);
  event(calendar('Work'), 'Standup'); event(calendar('Private'), 'Dentist');
  const task = (list, title) => insert('INSERT INTO tasks (user_id, list_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', uid, list, title, Date.now(), Date.now());
  task(taskList('Work'), 'Report'); task(taskList('Private'), 'Groceries'); task(null, 'No list');
  for (const [acc, subject] of [[work, 'Budget plan'], [priv, 'Budget party']]) {
    const f = insert("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'INBOX', '\\Inbox')", acc);
    const m = insert("INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, thread_id, subject, from_addr, from_name, to_json, date, is_read, created_at) VALUES (?, ?, ?, 1, ?, ?, ?, 'a@x.si', 'A', '[]', ?, 0, ?)", uid, acc, f, `${subject}@x`, subject, subject, Date.now(), Date.now());
    insert('INSERT INTO ai_insights (message_id, needs_reply, priority, summary, created_at) VALUES (?, 1, 80, ?, ?)', m, subject, Date.now());
    insert('INSERT INTO messages_fts (rowid, subject) VALUES (?, ?)', m, subject);
  }
  const rpc = async (token, name, args = {}) => {
    const r = await fetch(`${base}/api/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const { result } = await r.json();
    assert.ok(!result.isError, result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  const titles = (list, key = 'title') => list.map((x) => `${x[key]}|${x.space}`).sort();
  const all = createToken(uid, { name: 'All' }).token, fixed = createToken(uid, { name: 'Work only', space: 'Work' }).token;

  assert.deepEqual(await rpc(all, 'list_spaces'), { spaces: ['Private', 'Work'] });
  assert.deepEqual(await rpc(fixed, 'list_spaces'), { spaces: ['Work'] });

  const to = new Date(soon + 864e5).toISOString();
  assert.deepEqual(titles(await rpc(all, 'list_events', { to })), ['Dentist|Private', 'Standup|Work']);
  assert.deepEqual(titles(await rpc(all, 'list_events', { to, space: 'Private' })), ['Dentist|Private']);
  assert.deepEqual(titles(await rpc(fixed, 'list_events', { to, space: 'Private' })), ['Standup|Work'], 'a token never sees more than it may');
  assert.deepEqual(await rpc(all, 'list_events', { to, space: 'Nowhere' }), [], 'a space without calendars is empty, not everything');

  assert.deepEqual(titles(await rpc(all, 'list_tasks')), ['Groceries|Private', 'No list|', 'Report|Work']);
  assert.deepEqual(titles(await rpc(all, 'list_tasks', { space: 'Work' })), ['No list|', 'Report|Work']);
  assert.deepEqual(titles(await rpc(fixed, 'list_tasks', { space: 'Private' })), ['No list|', 'Report|Work']);

  assert.deepEqual(titles(await rpc(all, 'list_open_items'), 'subject'), ['Budget party|Private', 'Budget plan|Work']);
  assert.deepEqual(titles(await rpc(all, 'list_open_items', { space: 'Private' }), 'subject'), ['Budget party|Private']);
  assert.deepEqual(titles(await rpc(fixed, 'list_open_items', { space: 'Private' }), 'subject'), ['Budget plan|Work']);

  assert.deepEqual(titles(await rpc(all, 'search_mail', { query: 'budget', space: 'Work' }), 'subject'), ['Budget plan|Work']);
  assert.deepEqual(titles(await rpc(fixed, 'search_mail', { query: 'budget', space: 'Private' }), 'subject'), ['Budget plan|Work']);
});

test('MCP complete_task ticks like the app; list_tasks with ids returns exactly those', async () => {
  const { createToken } = await import('../src/mcp/server.js');
  const uid = db.prepare('SELECT id FROM users').get().id;
  const insert = (sql, ...p) => db.prepare(sql).run(...p).lastInsertRowid;
  const list = (space, readonly = 0) => insert("INSERT INTO task_lists (user_id, name, source, space, readonly, created_at) VALUES (?, ?, 'local', ?, ?, ?)", uid, `ticks ${space} ${readonly}`, space, readonly, Date.now());
  const home = list('Home'), office = list('Office'), locked = list('Home', 1);
  const task = (l, title, extra = {}) => insert('INSERT INTO tasks (user_id, list_id, title, due, rrule, done, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', uid, l, title, extra.due ?? null, extra.rrule ?? null, extra.done ?? 0, Date.now(), Date.now());
  const once = task(home, 'Once'), other = task(office, 'Other'), ro = task(locked, 'Read-only');
  const due = Date.now() + 864e5, weekly = task(home, 'Weekly', { due, rrule: 'FREQ=WEEKLY' });
  const rpc = async (token, name, args = {}) => {
    const r = await fetch(`${base}/api/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const { result, error } = await r.json();
    if (error) return { failed: error.message };
    return result.isError ? { failed: result.content[0].text } : JSON.parse(result.content[0].text);
  };
  const propose = createToken(uid, { name: 'Ticks', access: 'propose' }).token, spaced = createToken(uid, { name: 'Home', access: 'propose', space: 'Home' }).token, read = createToken(uid, { name: 'Read' }).token;
  const row = (id) => db.prepare('SELECT done, completed_at, due FROM tasks WHERE id = ?').get(id);

  assert.match((await rpc(read, 'complete_task', { id: once })).failed, /Unknown tool/);
  assert.deepEqual(await rpc(propose, 'complete_task', { id: once }), { id: once, done: true });
  assert.ok(row(once).done && row(once).completed_at);
  assert.deepEqual(await rpc(propose, 'complete_task', { id: once, done: false }), { id: once, done: false });
  assert.deepEqual([row(once).done, row(once).completed_at], [0, null]);

  assert.match((await rpc(propose, 'complete_task', { id: 999999 })).failed, /No task 999999/);
  assert.match((await rpc(propose, 'complete_task', { id: ro })).failed, /read-only/);
  assert.match((await rpc(spaced, 'complete_task', { id: other })).failed, /No task/, 'a token stays in its space');
  assert.equal(row(other).done, 0);

  const r = await rpc(propose, 'complete_task', { id: weekly });
  assert.equal(r.done, false, 'a repeating task stays open, on its next date');
  assert.ok(r.next_due && Date.parse(r.next_due) > due);
  assert.deepEqual([row(r.completed_id).done, row(r.completed_id).due], [1, due]);
  assert.deepEqual((await rpc(propose, 'list_tasks', { ids: [weekly, r.completed_id, other] })).map((t) => [t.id, t.repeats]).sort((a, b) => a[0] - b[0]),
    [[other, false], [weekly, true], [r.completed_id, false]].sort((a, b) => a[0] - b[0]), 'the completed occurrence does not repeat');

  // More than the 100 of a plain list: done ones are not hidden when asked for by id.
  for (let i = 0; i < 105; i++) task(home, `Filler ${i}`);
  await rpc(propose, 'complete_task', { id: once });
  const plain = await rpc(propose, 'list_tasks', { include_done: true });
  assert.equal(plain.length, 100);
  assert.ok(!plain.some((t) => t.id === once), 'the limit can hide it');
  const got = await rpc(propose, 'list_tasks', { ids: [once, other, 999999] });
  assert.deepEqual(got.map((t) => [t.id, t.done]).sort(), [[once, true], [other, false]].sort());
  assert.deepEqual((await rpc(spaced, 'list_tasks', { ids: [once, other] })).map((t) => t.id), [once], 'ids stay inside the token\'s space');
  assert.deepEqual(await rpc(propose, 'list_tasks', { ids: [] }), [], 'no ids, no tasks');
});
