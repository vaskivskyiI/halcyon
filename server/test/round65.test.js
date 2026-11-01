// Sync opens only what changed, and never loses track of mail: against a scripted IMAP client.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r65-test-'));
process.env.HALCYON_LOG_LEVEL = 'error';

const eml = (u) => Buffer.from(`From: A <a@x.example>\r\nTo: me@x.example\r\nSubject: M${u}\r\nMessage-ID: <m${u}@x>\r\nDate: Mon, 02 Nov 2026 10:00:00 +0000\r\n\r\nHello\r\n`);

/** Folders: { path: { uids: Map(uid → flags), modseq } }. Counts what the sync asks for. */
function fakeClient(folders, { condstore = true } = {}) {
  const calls = { open: [], searchAll: [], flagFetch: [], source: [] };
  const c = {
    calls, usable: true, mailbox: null, enabled: new Set(condstore ? ['CONDSTORE'] : []),
    list: async () => Object.entries(folders).map(([p, f]) => ({ path: p, name: p, delimiter: '/', flags: new Set(), specialUse: p === 'INBOX' ? '\\Inbox' : undefined, subscribed: true,
      status: { messages: f.uids.size, uidNext: Math.max(0, ...f.uids.keys()) + 1, ...(condstore ? { highestModseq: BigInt(f.modseq) } : {}) } })),
    getMailboxLock: async (p) => {
      calls.open.push(p);
      const f = folders[p];
      c.mailbox = { path: p, uidValidity: 1n, exists: f.uids.size, uidNext: Math.max(0, ...f.uids.keys()) + 1, ...(condstore ? { highestModseq: BigInt(f.modseq) } : {}) };
      return { release() {} };
    },
    search: async (q) => {
      const uids = [...folders[c.mailbox.path].uids.keys()];
      if (q.all) { calls.searchAll.push(c.mailbox.path); return uids; }
      if (q.since && !q.uid) return uids;
      const [lo] = String(q.uid).split(':').map(Number);
      return uids.filter((u) => u >= lo);
    },
    async *fetch(range, want, opts) {
      const f = folders[c.mailbox.path];
      if (want.source) { for (const u of range) { calls.source.push(u); if (f.uids.has(u)) yield { uid: u, flags: new Set(f.uids.get(u)), source: eml(u), internalDate: new Date() }; } return; }
      calls.flagFetch.push({ path: c.mailbox.path, range, since: opts?.changedSince });
      const [lo, hi] = String(range).split(':').map(Number);
      for (const [u, fl] of f.uids) if (u >= lo && u <= hi) yield { uid: u, flags: new Set(fl) };
    },
  };
  return c;
}

let db, Sync, acc, n = 0;
const worker = (folders, opts) => {
  const a = db.prepare('INSERT INTO accounts (user_id, email, sync_enabled, created_at) VALUES (?, ?, 1, ?)').run(1, `u${++n}@x.example`, Date.now()).lastInsertRowid;
  acc = Number(a);
  const w = new Sync(acc);
  w.client = fakeClient(folders, opts);
  w.client.calls.reset = () => { for (const k of ['open', 'searchAll', 'flagFetch', 'source']) w.client.calls[k].length = 0; };
  return w;
};
const count = () => db.prepare('SELECT COUNT(*) AS n FROM messages WHERE account_id = ?').get(acc).n;
const row = (uid) => db.prepare('SELECT * FROM messages WHERE account_id = ? AND uid = ?').get(acc, uid);

before(async () => {
  const { db: d, run } = await import('../src/db/index.js');
  db = d;
  run("INSERT INTO users (id, email, name, created_at) VALUES (1, 'me@x.example', 'Me', 0)");
  ({ AccountSync: Sync } = await import('../src/mail/sync.js'));
});
after(() => setTimeout(() => process.exit(0), 50).unref());

const mk = (uids, modseq = 10) => ({ uids: new Map(uids.map((u) => [u, []])), modseq });

test('a second sync opens only the Inbox, and only asks for what can have changed', async () => {
  const folders = { INBOX: mk([1, 2, 3]), Sent: mk([1, 2]), Old: mk([1, 2, 3, 4]) };
  const w = worker(folders);
  await w.fullCycle();
  assert.equal(count(), 9);
  w.client.calls.reset();
  await w.fullCycle();
  assert.deepEqual(w.client.calls.open, ['INBOX'], 'unchanged folders are not opened');
  assert.deepEqual(w.client.calls.searchAll, [], 'no list of every UID');
  assert.deepEqual(w.client.calls.flagFetch, []);
});

test('a change in any folder is found: new mail, a deletion, a flag', async () => {
  const folders = { INBOX: mk([1]), Sent: mk([1]), Old: mk([1, 2, 3]) };
  const w = worker(folders);
  await w.fullCycle();
  folders.Old.uids.set(4, []); folders.Old.modseq = 11;
  w.client.calls.reset();
  await w.fullCycle();
  assert.ok(w.client.calls.open.includes('Old'));
  assert.ok(!w.client.calls.open.includes('Sent'));
  assert.equal(count(), 6);
  folders.Old.uids.delete(2); folders.Old.modseq = 12;
  await w.fullCycle();
  assert.equal(count(), 5, 'deleted on the server, gone here');
  folders.Old.uids.set(3, ['\\Seen']); folders.Old.modseq = 13;
  await w.fullCycle();
  assert.equal(db.prepare("SELECT is_read FROM messages m JOIN folders f ON f.id = m.folder_id WHERE f.account_id = ? AND f.path = 'Old' AND m.uid = 3").get(acc).is_read, 1);
});

test('one deleted and one new in the same folder are both noticed', async () => {
  const folders = { INBOX: mk([1]), Old: mk([1, 2, 3]) };
  const w = worker(folders);
  await w.fullCycle();
  folders.Old.uids.delete(1); folders.Old.uids.set(4, []); folders.Old.modseq = 11;
  await w.fullCycle();
  const uids = db.prepare("SELECT m.uid FROM messages m JOIN folders f ON f.id = m.folder_id WHERE f.account_id = ? AND f.path = 'Old' ORDER BY m.uid").all(acc).map((r) => r.uid);
  assert.deepEqual(uids, [2, 3, 4]);
});

test('a server without CONDSTORE: recent flags each time, all of them in the hourly pass; a folder is still skipped when counts match', async () => {
  const folders = { INBOX: mk([1, 2, 3]), Old: mk([1, 2]) };
  const w = worker(folders, { condstore: false });
  await w.fullCycle();
  w.client.calls.reset();
  await w.fullCycle();
  assert.deepEqual(w.client.calls.open, ['INBOX']);
  folders.INBOX.uids.set(3, ['\\Seen']);
  await w.fullCycle();
  assert.equal(row(3)?.is_read ?? db.prepare("SELECT is_read FROM messages m JOIN folders f ON f.id = m.folder_id WHERE f.account_id = ? AND f.path = 'INBOX' AND m.uid = 3").get(acc).is_read, 1);
  w.lastDeep = 0;
  w.client.calls.reset();
  await w.fullCycle();
  assert.deepEqual(w.client.calls.open.sort(), ['INBOX', 'Old'], 'the hourly pass reads every folder');
  assert.equal(w.client.calls.searchAll.length, 2);
});

test('nothing changed: no event that makes every window reload', async () => {
  const { bus } = await import('../src/util/events.js');
  const folders = { INBOX: mk([1, 2]) };
  const w = worker(folders);
  await w.fullCycle();
  const seen = [];
  const h = (e) => seen.push(e.type);
  bus.on('user-event', h);
  await w.fullCycle();
  bus.off('user-event', h);
  assert.ok(!seen.includes('folder:synced') && !seen.includes('folders:changed'), seen.join());
});

test('older mail stops for a sync and carries on where it stopped, without a gap', async () => {
  const uids = Array.from({ length: 80 }, (_, i) => i + 1);
  const folders = { INBOX: mk(uids) };
  const w = worker(folders);
  await w.fullCycle();
  const all = count();
  db.prepare("UPDATE folders SET history_done = 0, oldest_uid = 41 WHERE account_id = ?").run(acc);
  const { deleteMessages } = await import('../src/mail/store.js');
  deleteMessages(db.prepare('SELECT id FROM messages WHERE account_id = ? AND uid < 41').all(acc).map((r) => r.id));
  assert.equal(count(), 40);
  let chunks = 0;
  const realFetch = w.client.fetch;
  w.client.fetch = function fetch(range, want, opts) { if (want.source && ++chunks === 1) w.fullRequested = true; return realFetch.call(this, range, want, opts); };
  await w.backfillHistory();
  assert.equal(count(), 65, 'the first 25, then it yields');
  assert.equal(db.prepare('SELECT history_done AS d FROM folders WHERE account_id = ?').get(acc).d, 0);
  w.fullRequested = false;
  await w.backfillHistory();
  assert.equal(count(), all, 'nothing skipped');
  assert.equal(db.prepare('SELECT history_done AS d FROM folders WHERE account_id = ?').get(acc).d, 1);
});
