// An event from a read-only / information calendar added to one's own: shown once, following the original;
// per-account vs global context.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r31-test-'));
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

test('an event of a read-only calendar added to my calendar shows once and follows the original', async () => {
  const sub = Number(db.prepare("INSERT INTO calendars (user_id, name, source, readonly, created_at) VALUES (?, 'Holidays', 'subscription', 1, ?)").run(uid, Date.now()).lastInsertRowid);
  const t = Date.parse('2026-11-10T09:00:00Z');
  const src = Number(db.prepare("INSERT INTO events (calendar_id, uid, title, location, start, end, created_at, updated_at) VALUES (?, 'conf-1', 'Physics conference', 'Ljubljana', ?, ?, ?, ?)").run(sub, t, t + 3 * 3600e3, Date.now() - 1000, Date.now() - 1000).lastInsertRowid);
  const range = `from=${t - 864e5}&to=${t + 864e5}`;
  assert.equal((await api('GET', `/api/events?${range}`)).length, 1);
  const copy = await api('POST', `/api/events/${src}/link`, {});
  assert.equal(copy.linkedFrom, sub);
  // Shown once: the copy, which says where it comes from.
  const list = await api('GET', `/api/events?${range}`);
  assert.equal(list.length, 1); assert.equal(list[0].id, copy.id); assert.equal(list[0].linkedFromName, 'Holidays');
  // Linking again does not make a second copy.
  assert.equal((await api('POST', `/api/events/${src}/link`, {})).id, copy.id);
  // The original moves (e.g. the subscription refreshed): the copy follows.
  db.prepare('UPDATE events SET start = ?, end = ?, location = ?, updated_at = ? WHERE id = ?').run(t + 864e5, t + 864e5 + 3600e3, 'Maribor', Date.now() + 1000, src);
  const { syncLinked } = await import('../src/calendar/linked.js');
  syncLinked();
  const c = db.prepare('SELECT * FROM events WHERE id = ?').get(copy.id);
  assert.deepEqual([c.start, c.location, c.status], [t + 864e5, 'Maribor', 'confirmed']);
  // Rebuilt with new rows (same uid): still found. Gone: the copy stays, marked cancelled.
  db.prepare('DELETE FROM events WHERE id = ?').run(src);
  syncLinked();
  assert.equal(db.prepare('SELECT status FROM events WHERE id = ?').get(copy.id).status, 'cancelled');
  // Stop following: an ordinary event.
  await api('POST', `/api/events/${copy.id}/unlink`);
  assert.equal(db.prepare('SELECT linked_cal_id FROM events WHERE id = ?').get(copy.id).linked_cal_id, null);
});

test('an event in my own writable calendar cannot be "linked" into the same calendar', async () => {
  const def = db.prepare('SELECT id FROM calendars WHERE user_id = ? AND is_default = 1').get(uid).id;
  const e = await api('POST', '/api/events', { calendarId: def, title: 'Own', start: Date.now() + 864e5, end: Date.now() + 864e5 + 3600e3 });
  await assert.rejects(api('POST', `/api/events/${e.id}/link`, { calendarId: def }), /already in that calendar/);
});

test('context: per account by default; "everything" globally or for one account', async () => {
  const acc = Number(db.prepare("INSERT INTO accounts (user_id, email, about_me, sync_enabled, created_at) VALUES (?, 'me@home.example', 'Private mail.', 0, ?)").run(uid, Date.now()).lastInsertRowid);
  db.prepare("INSERT INTO accounts (user_id, email, about_me, sync_enabled, created_at) VALUES (?, 'me@work.example', 'Physicist at an institute.', 0, ?)").run(uid, Date.now());
  const { ctxFor } = await import('../src/ai/tasks.js');
  const ctx = async (mode, accMode) => {
    await api('PATCH', '/api/settings', { ai: { contextMode: mode } });
    db.prepare('UPDATE accounts SET context_mode = ? WHERE id = ?').run(accMode, acc);
    return ctxFor(uid, acc).ctx;
  };
  assert.doesNotMatch(await ctx('account', null), /Physicist/);
  assert.match(await ctx('global', null), /Physicist/);
  assert.match(await ctx('account', 'global'), /Physicist/, 'one account asks for everything');
  assert.doesNotMatch(await ctx('global', 'account'), /Physicist/, 'one account keeps to itself');
  await api('PATCH', `/api/accounts/${acc}`, { contextMode: 'global' });
  assert.equal((await api('GET', '/api/accounts')).find((a) => a.id === acc).contextMode, 'global');
});
