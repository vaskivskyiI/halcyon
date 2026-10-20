// Downloading older mail ("history") after the quick first sync, against a fake IMAP client: respects the account's
// window (90 days / a year / all), resumes in batches without duplicates, and handles folders with no recent mail.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-hist-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';
process.env.HALCYON_HISTORY_BATCH = '40';

let db, AccountSync, account, folder;

// A mailbox of `n` messages, uid i sent i days ago (uid 1 is the oldest when reversed below).
function fakeClient(n) {
  const day = 864e5, now = Date.now();
  const msgs = Array.from({ length: n }, (_, i) => ({ uid: i + 1, date: now - (n - i) * day }));
  const raw = (m) => Buffer.from(`Message-ID: <h${m.uid}@x.example>\r\nFrom: a@x.example\r\nTo: me@example.org\r\nSubject: m${m.uid}\r\nDate: ${new Date(m.date).toUTCString()}\r\n\r\nbody ${m.uid}\r\n`);
  return {
    usable: true,
    mailbox: { exists: n, uidNext: n + 1, uidValidity: 1 },
    async getMailboxLock() { return { release() {} }; },
    async search(crit) {
      const [lo, hi] = String(crit.uid || '1:*').split(':').map((x) => (x === '*' ? Infinity : Number(x)));
      return msgs.filter((m) => m.uid >= lo && m.uid <= hi && (!crit.since || m.date >= crit.since.getTime())).map((m) => m.uid);
    },
    async *fetch(uids) { for (const u of uids) { const m = msgs[u - 1]; yield { uid: u, flags: new Set(['\\Seen']), source: raw(m), internalDate: new Date(m.date) }; } },
  };
}

before(async () => {
  ({ db } = await import('../src/db/index.js'));
  ({ AccountSync } = await import('../src/mail/sync.js'));
  const { createUser } = await import('../src/auth.js');
  const u = createUser({ email: 'me@example.org', name: 'Me', password: 'password123' });
  account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare("INSERT INTO accounts (user_id, email, sync_enabled, sync_history, created_at) VALUES (?, 'me@example.org', 1, '90', ?)").run(u.id, Date.now()).lastInsertRowid);
  // State after a quick first sync that took only the newest 30 messages (uids 271..300).
  folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(db.prepare("INSERT INTO folders (account_id, path, name, special_use, sync_enabled, last_uid, oldest_uid, last_synced_at, server_total) VALUES (?, 'INBOX', 'INBOX', '\\Inbox', 1, 300, 271, ?, 300)").run(account.id, Date.now()).lastInsertRowid);
});

after(() => setTimeout(() => process.exit(0), 50).unref());

const local = () => db.prepare('SELECT COUNT(*) AS n FROM messages WHERE folder_id = ?').get(folder.id).n;
const f = () => db.prepare('SELECT * FROM folders WHERE id = ?').get(folder.id);

async function runUntilDone(w) {
  for (let i = 0; i < 50 && w.historyPending; i++) await w.backfillHistory();
}

test('older mail is downloaded in batches within the 90-day window, then everything when "all" is chosen', async () => {
  const w = new AccountSync(account.id);
  w.client = fakeClient(300);
  assert.equal(w.historyPending, true);
  await w.backfillHistory();
  assert.equal(local(), 40, 'one batch per round');
  await runUntilDone(w);
  assert.equal(f().history_done, 1);
  // uid i is (301 - i) days old: the 90-day window below the first-sync batch is uids ~211..270.
  const inWindow = local();
  assert.ok(inWindow >= 59 && inWindow <= 60, `mail within 90 days, older than the first-sync batch (${inWindow})`);
  assert.equal(f().last_uid, 300, 'new-mail checks continue above the newest message');

  db.prepare("UPDATE accounts SET sync_history = 'all' WHERE id = ?").run(account.id);
  db.prepare('UPDATE folders SET history_done = 0 WHERE id = ?').run(folder.id);
  await runUntilDone(w);
  assert.equal(local(), 270, 'everything older than the first-sync batch (uids 1..270) is downloaded once');
  assert.equal(f().oldest_uid, 1);
  assert.equal(db.prepare('SELECT COUNT(DISTINCT uid) AS n FROM messages WHERE folder_id = ?').get(folder.id).n, 270, 'no duplicates');
});

test('a folder with no recent mail still gets its history and a last_uid', async () => {
  const g = db.prepare('SELECT * FROM folders WHERE id = ?').get(db.prepare("INSERT INTO folders (account_id, path, name, sync_enabled, last_uid, last_synced_at) VALUES (?, 'Old', 'Old', 1, 0, ?)").run(account.id, Date.now()).lastInsertRowid);
  db.prepare('UPDATE folders SET history_done = 1 WHERE id = ?').run(folder.id);
  const w = new AccountSync(account.id);
  w.client = fakeClient(50);
  await runUntilDone(w);
  const row = db.prepare('SELECT * FROM folders WHERE id = ?').get(g.id);
  assert.equal(row.history_done, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE folder_id = ?').get(g.id).n, 50);
  assert.equal(row.last_uid, 50);
});
