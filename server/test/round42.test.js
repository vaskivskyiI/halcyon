// Search keywords as in Outlook; problems put aside; the starter calendar makes way for synced ones; the sidebar's
// strong count is the Focused one; an email whose only action is its summary leaves Action needed when done.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r42-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, uid, acc, inbox;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
let n = 0;
function add({ from = 'ana@x.example', name = 'Ana', subject = 'Hello', body = 'text', date = Date.now(), read = 0, flagged = 0, att = null, cc = [], priority, category = 'work', action }) {
  const id = db.prepare(`INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, thread_id, subject, from_addr, from_name, to_json, cc_json, date, is_read, is_flagged,
      has_attachments, attachments_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[{"address":"me@example.org"}]', ?, ?, ?, ?, ?, ?, ?)`)
    .run(uid, acc, inbox, ++n, `m${n}@x`, `t${n}`, subject, from, name, JSON.stringify(cc.map((a) => ({ address: a }))), date, read, flagged, att ? 1 : 0, JSON.stringify(att ? [{ filename: att }] : []), Date.now()).lastInsertRowid;
  db.prepare('INSERT INTO messages_fts (rowid, subject, sender, recipients, body) VALUES (?, ?, ?, ?, ?)').run(id, subject, `${name} ${from}`, 'me@example.org', body);
  if (priority != null) db.prepare('INSERT INTO ai_insights (message_id, priority, category, needs_action, action_summary, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, priority, category, action ? 1 : 0, action || null, Date.now());
  return id;
}
const search = async (q) => (await api('GET', `/api/messages?q=${encodeURIComponent(q)}&semantic=0`)).items.map((m) => m.id).sort((a, b) => a - b);

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  uid = db.prepare('SELECT id FROM users').get().id;
  acc = db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, 'me@example.org', 0, ?)").run(uid, Date.now()).lastInsertRowid;
  inbox = db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'INBOX', '\\Inbox')").run(acc).lastInsertRowid;
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('Outlook search keywords', async () => {
  const { parseQuery, dateRange } = await import('../src/search.js');
  const day = 864e5, now = Date.now();
  const a = add({ subject: 'Budget plan for spring', body: 'numbers attached', att: 'report.pdf', date: now - 1000 });
  const b = add({ from: 'bob@y.example', name: 'Bob', subject: 'Plan the trip', body: 'tickets and hotels', read: 1, flagged: 1, cc: ['ana@x.example'], date: now - 40 * day });
  const c = add({ from: 'cid@z.example', name: 'Cid', subject: 'Budget review', body: 'no plan yet', read: 1, date: now - 3 * day });
  assert.deepEqual(await search('from:ana'), [a]);
  assert.deepEqual(await search('from: ana'), [a].concat(), 'a space after the colon is tolerated (as Outlook does)');
  assert.deepEqual(await search('participants:ana'), [a, b]);
  assert.deepEqual(await search('cc:ana'), [b]);
  assert.deepEqual(await search('subject:(budget spring)'), [a]);
  assert.deepEqual(await search('subject:"budget plan"'), [a]);
  assert.deepEqual(await search('hasattachments:yes'), [a]);
  assert.deepEqual(await search('hasattachments:no'), [b, c]);
  assert.deepEqual(await search('attachments:report'), [a]);
  assert.deepEqual(await search('isread:no'), [a]);
  assert.deepEqual(await search('isread:yes'), [b, c]);
  assert.deepEqual(await search('isflagged:yes'), [b]);
  assert.deepEqual(await search('received:today'), [a]);
  assert.deepEqual(await search('received:"this year"').then((x) => x.includes(a)), true);
  assert.deepEqual(await search('received:last week').then((x) => x.includes(a)), false);
  assert.deepEqual(await search(`received:>=${new Date(now - 5 * day).toISOString().slice(0, 10)}`), [a, c]);
  assert.deepEqual(await search('body:tickets'), [b]);
  assert.deepEqual(await search('plan NOT budget'), [b]);
  assert.deepEqual(await search('plan -budget'), [b]);
  assert.deepEqual(await search('tickets OR review'), [b, c]);
  assert.deepEqual(await search('folder:inbox from:bob'), [b]);
  assert.equal(dateRange('nonsense'), null);
  const [s, e] = dateRange('2026-01-15');
  assert.equal(e - s, day);
  assert.deepEqual(dateRange('15.1.2026'), [s, e]);
  assert.deepEqual(parseQuery('isflagged:no').is, [{ val: 'unflagged', neg: false }]);
});

test('problems can be dismissed — all or one — and come back when they change or return', async () => {
  const { davStatus } = await import('../src/scheduler.js');
  db.prepare("UPDATE accounts SET caldav_url = 'https://dav.example/' WHERE id = ?").run(acc);
  const o = db.prepare("INSERT INTO pending_ops (account_id, op, payload_json, attempts, error, created_at) VALUES (?, 'flag', '{}', 5, 'NO such message', ?)").run(acc, Date.now()).lastInsertRowid;
  davStatus.set(acc, { at: Date.now(), error: 'Calendars (CalDAV): refused' });
  let p = await api('GET', '/api/status/problems');
  assert.deepEqual(p.problems.map((x) => x.key).sort(), [`dav:${acc}`, `op:${o}`]);
  await api('POST', '/api/status/problems/dismiss', { keys: [`op:${o}`] });
  p = await api('GET', '/api/status/problems');
  assert.deepEqual([p.problems.map((x) => x.key), p.hidden], [[`dav:${acc}`], 1]);
  await api('POST', '/api/status/problems/dismiss', {});
  p = await api('GET', '/api/status/problems');
  assert.deepEqual([p.problems.length, p.hidden], [0, 2]);
  assert.ok(db.prepare('SELECT 1 FROM pending_ops WHERE id = ?').get(o), 'dismissing deletes nothing');
  // A different error is a new problem; one that went away is forgotten and shows again when it returns.
  davStatus.set(acc, { at: Date.now(), error: 'Calendars (CalDAV): not found' });
  p = await api('GET', '/api/status/problems');
  assert.deepEqual(p.problems.map((x) => x.key), [`dav:${acc}`]);
  db.prepare('DELETE FROM pending_ops WHERE id = ?').run(o);
  await api('GET', '/api/status/problems');
  assert.ok(!db.prepare('SELECT 1 FROM problem_dismissals WHERE key = ?').get(`op:${o}`));
  p = await api('GET', '/api/status/problems?all=1');
  assert.equal(p.problems.length, 1);
  await api('POST', '/api/status/problems/dismiss', { restore: true });
  davStatus.delete(acc);
  db.prepare('UPDATE accounts SET caldav_url = NULL WHERE id = ?').run(acc);
});

test('the empty starter calendar makes way for synced calendars; the default one can be removed for another', async () => {
  const { dropStarters } = await import('../src/bootstrap.js');
  const starter = db.prepare("SELECT id FROM calendars WHERE user_id = ? AND source = 'local'").get(uid).id;
  assert.equal(dropStarters(uid), false, 'kept while it is the only one');
  const dav = db.prepare("INSERT INTO calendars (user_id, account_id, name, color, source, created_at) VALUES (?, ?, 'Work', '#000', 'caldav', ?)").run(uid, acc, Date.now()).lastInsertRowid;
  assert.equal(dropStarters(uid), true);
  assert.ok(!db.prepare('SELECT 1 FROM calendars WHERE id = ?').get(starter));
  assert.equal(db.prepare('SELECT is_default FROM calendars WHERE id = ?').get(dav).is_default, 1);
  // A local calendar with events stays; a default one can be removed when another can take its place.
  const local = (await api('POST', '/api/calendars', { name: 'Calendar' })).id;
  db.prepare("INSERT INTO events (calendar_id, uid, title, start, \"end\") VALUES (?, 'e1', 'x', ?, ?)").run(local, Date.now(), Date.now() + 36e5);
  assert.equal(dropStarters(uid), false);
  await api('PATCH', `/api/calendars/${local}`, { isDefault: true });
  await api('DELETE', `/api/calendars/${local}`);
  assert.equal(db.prepare('SELECT is_default FROM calendars WHERE id = ?').get(dav).is_default, 1);
  db.prepare("UPDATE calendars SET readonly = 1 WHERE id = ?").run(dav);
  await assert.rejects(api('DELETE', `/api/calendars/${dav}`), /only calendar/);
  const spaces = await api('GET', '/api/spaces');
  assert.ok(spaces.calendars.every((c) => c.origin));
});

test('with Focused Inbox on, the strong unread count is the Focused tab count', async () => {
  db.prepare('UPDATE messages SET is_read = 1').run();
  add({ priority: 50 }); add({ priority: 20, category: 'newsletter' }); add({ priority: 90 }); add({});
  const tabs = await api('GET', '/api/messages/tab-counts?view=unified');
  let f = await api('GET', '/api/folders');
  let box = f.accounts[0].folders.find((x) => x.id === inbox);
  assert.deepEqual([box.unread, box.important, f.counts.emphasis], [4, tabs.focused, 'focused']);
  assert.equal(tabs.focused, 3);
  await api('PATCH', '/api/settings', { mail: { focusedInbox: false } });
  f = await api('GET', '/api/folders');
  box = f.accounts[0].folders.find((x) => x.id === inbox);
  assert.deepEqual([box.important, f.counts.emphasis], [1, 'important']);
  await api('PATCH', '/api/settings', { mail: { focusedInbox: true } });
});

test('an email whose one action is its summary leaves Action needed when that is done', async () => {
  const id = add({ priority: 80, action: 'Sign the form' });
  assert.ok((await api('GET', '/api/messages?view=needsaction')).items.some((m) => m.id === id));
  const r = await api('POST', `/api/messages/${id}/action-item`, { text: 'Sign the form', resolution: 'done' });
  assert.equal(r.insight.dismissed, true);
  assert.ok(!(await api('GET', '/api/messages?view=needsaction')).items.some((m) => m.id === id));
});
