// Archives: mailboxes Halcyon keeps itself, on no mail server — like Outlook's .pst archives. Filled by importing
// Outlook data files (PST/OST), MBOX or EML files, or by moving mail out of a mailbox (copied and checked first; the
// mailbox copy then goes to Trash, never deleted outright). Exported as MBOX or EML files for other programs.
// Mail in an archive is searchable; it is not analysed by the AI (moved mail keeps its analysis).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { get, all, run, tx, now, json } from '../db/index.js';
import { config } from '../config.js';
import { ingestMessage, readRaw, recountFolder, deleteMessages } from './store.js';
import { trashMessages } from './actions.js';
import { createAccount } from '../accounts.js';
import { notify } from '../util/events.js';
import { logger } from '../util/log.js';

const log = logger('archive');

export const isArchive = (accountId) => get('SELECT kind FROM accounts WHERE id = ?', accountId)?.kind === 'archive';
export const archiveOf = (userId, id) => get("SELECT * FROM accounts WHERE id = ? AND user_id = ? AND kind = 'archive'", id, userId);

export function createArchive(userId, { name, space = '' } = {}) {
  const a = createAccount(userId, { email: '', name: String(name || 'Archive').trim().slice(0, 80) || 'Archive', space }, { sync_enabled: 0 });
  run("UPDATE accounts SET kind = 'archive', sync_state = 'idle' WHERE id = ?", a.id);
  return get('SELECT * FROM accounts WHERE id = ?', a.id);
}

/** The archive folder at this path ("Inbox/Projects"), made with its parents when missing. */
export function archiveFolder(accountId, folderPath) {
  const parts = String(folderPath || 'Inbox').split('/').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) parts.push('Inbox');
  let f = null;
  for (let i = 0; i < parts.length; i++) {
    const p = parts.slice(0, i + 1).join('/');
    f = get('SELECT * FROM folders WHERE account_id = ? AND path = ?', accountId, p);
    if (!f) {
      const r = run('INSERT INTO folders (account_id, path, name, delimiter, parent_path, sync_enabled) VALUES (?, ?, ?, ?, ?, 1)', accountId, p, parts[i], '/', i ? parts.slice(0, i).join('/') : null);
      f = get('SELECT * FROM folders WHERE id = ?', r.lastInsertRowid);
    }
  }
  return f;
}

// The Message-ID as ingestMessage will store it (the same raw gives the same made-up id): for skipping duplicates.
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
function messageIdOf(raw) {
  const head = raw.subarray(0, 65536).toString('latin1').split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');
  const id = (head.match(/^Message-ID:[ \t]*<?([^>\s]+)>?/mi) || [])[1];
  return id || `${sha1(raw).slice(0, 24)}@halcyon.local`;
}

/**
 * Adds one email to an archive folder. Already there (same Message-ID in that folder; `anywhere`: in the whole archive,
 * so a second export of the same mailbox adds only what is new) → skipped. Returns the new id, or null when skipped.
 */
export async function addToArchive(account, folder, raw, { flags = [], date = null, anywhere = false } = {}) {
  const msgid = messageIdOf(raw);
  if (get(`SELECT 1 AS x FROM messages WHERE ${anywhere ? 'account_id' : 'folder_id'} = ? AND message_id = ?`, anywhere ? account.id : folder.id, msgid)) return null;
  run('UPDATE folders SET last_uid = COALESCE(last_uid, 0) + 1 WHERE id = ?', folder.id);
  const uid = get('SELECT last_uid FROM folders WHERE id = ?', folder.id).last_uid;
  const { id } = await ingestMessage({ account, folder, uid, flags, raw, internalDate: date });
  run("UPDATE messages SET ai_status = CASE WHEN ai_status = 'done' THEN 'done' ELSE 'none' END WHERE id = ?", id);
  return id;
}

let insightCols = null;
/** What Halcyon knows about a moved email goes along: analysis, own categories, tasks and events made from it. */
function carryOver(fromId, toId) {
  insightCols ||= all('PRAGMA table_info(ai_insights)').map((c) => c.name).filter((c) => c !== 'message_id');
  tx(() => {
    run(`INSERT OR REPLACE INTO ai_insights (message_id, ${insightCols.join(', ')}) SELECT ?, ${insightCols.join(', ')} FROM ai_insights WHERE message_id = ?`, toId, fromId);
    if (get('SELECT 1 AS x FROM ai_insights WHERE message_id = ?', toId)) run("UPDATE messages SET ai_status = 'done' WHERE id = ?", toId);
    run('INSERT OR IGNORE INTO message_tags (message_id, category_id, source, created_at) SELECT ?, category_id, source, created_at FROM message_tags WHERE message_id = ?', toId, fromId);
    run('UPDATE messages SET labels_json = (SELECT labels_json FROM messages WHERE id = ?), is_flagged = (SELECT is_flagged FROM messages WHERE id = ?) WHERE id = ?', fromId, fromId, toId);
    run('UPDATE tasks SET source_message_id = ? WHERE source_message_id = ?', toId, fromId);
    run('UPDATE events SET source_message_id = ? WHERE source_message_id = ?', toId, fromId);
  });
}

/**
 * Moves emails into an archive folder: each is copied, the copy read back and compared with the original, and only
 * then the original leaves its mailbox — to the mailbox's Trash (recoverable there; removed when Trash is emptied),
 * or, from another archive, removed there. `keep`: copy only. `merge`: an email the archive already has anywhere is not
 * copied again (what was known of it goes along). Returns { moved, skipped, failed: [{ id, error }] }.
 */
export async function intoArchive(userId, ids, folder, { keep = false, merge = false, onProgress } = {}) {
  const account = get("SELECT * FROM accounts WHERE id = ? AND user_id = ? AND kind = 'archive'", folder.account_id, userId);
  if (!account) throw new Error('Not an archive');
  const done = [], fromArchive = [], failed = [];
  let n = 0, skipped = 0;
  for (const id of ids) {
    const m = get('SELECT m.*, a.kind FROM messages m JOIN accounts a ON a.id = m.account_id WHERE m.id = ? AND m.user_id = ?', id, userId);
    if (!m || m.folder_id === folder.id) continue;
    try {
      const same = merge && m.message_id && get('SELECT id FROM messages WHERE account_id = ? AND message_id = ? LIMIT 1', account.id, m.message_id);
      if (same) {
        if (!get('SELECT 1 AS x FROM ai_insights WHERE message_id = ?', same.id)) carryOver(m.id, same.id);
        run('UPDATE tasks SET source_message_id = ? WHERE source_message_id = ?', same.id, m.id);
        run('UPDATE events SET source_message_id = ? WHERE source_message_id = ?', same.id, m.id);
        fromArchive.push(m.id);
        skipped++;
        if (++n % 25 === 0) { onProgress?.(n); await new Promise((r) => setImmediate(r)); }
        continue;
      }
      const raw = readRaw(m);
      if (!raw) throw new Error('the original is not stored on this computer');
      const flags = [m.is_read && '\\Seen', m.is_flagged && '\\Flagged', m.is_answered && '\\Answered'].filter(Boolean);
      const newId = await addToArchive(account, folder, raw, { flags, date: new Date(m.date) })
        ?? get('SELECT id FROM messages WHERE folder_id = ? AND message_id = ?', folder.id, m.message_id)?.id;
      const copy = newId && get('SELECT * FROM messages WHERE id = ?', newId);
      const back = copy && readRaw(copy);
      if (!back || sha1(back) !== sha1(raw)) throw new Error('the archived copy could not be verified');
      carryOver(m.id, newId);
      (m.kind === 'archive' ? fromArchive : done).push(m.id);
    } catch (e) {
      failed.push({ id, error: e.message });
      log.warn(`archive ${id}: ${e.message}`);
    }
    if (++n % 25 === 0) { onProgress?.(n); await new Promise((r) => setImmediate(r)); }
  }
  recountFolder(folder.id);
  if (!keep) {
    for (let i = 0; i < done.length; i += 200) await trashMessages(userId, done.slice(i, i + 200));
    if (fromArchive.length) {
      const folders = [...new Set(fromArchive.map((id) => get('SELECT folder_id FROM messages WHERE id = ?', id)?.folder_id))];
      deleteMessages(fromArchive);
      folders.forEach((f) => f && recountFolder(f));
    }
  }
  notify(userId, 'mail:changed', { ids });
  notify(userId, 'folders:changed', {});
  return { moved: done.length + fromArchive.length - skipped, skipped, failed };
}

// ---- jobs (imports and moves run in the background, one at a time, with progress)

const importers = {};
export const registerImporter = (format, fn) => { importers[format] = fn; };

export const jobOut = (j) => j && ({
  id: j.id, archiveId: j.account_id, type: j.type, format: j.format, fileName: j.file_name, status: j.status, done: j.done, total: j.total,
  skipped: j.skipped, failed: j.failed, error: j.error, createdAt: j.created_at, finishedAt: j.finished_at,
});

export function queueJob(userId, accountId, type, { format = null, filePath = null, fileName = null, keepFile = false, params = {} } = {}) {
  const r = run('INSERT INTO archive_jobs (user_id, account_id, type, format, file_path, file_name, keep_file, params_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    userId, accountId, type, format, filePath, fileName, keepFile ? 1 : 0, JSON.stringify(params), now());
  setImmediate(runJobs);
  return jobOut(get('SELECT * FROM archive_jobs WHERE id = ?', r.lastInsertRowid));
}

let running = false;
export async function runJobs() {
  if (running) return;
  running = true;
  try {
    for (let j; (j = get("SELECT * FROM archive_jobs WHERE status = 'queued' ORDER BY id LIMIT 1"));) await runJob(j);
  } finally { running = false; }
}

async function runJob(j) {
  const set = (fields) => {
    const keys = Object.keys(fields);
    run(`UPDATE archive_jobs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => fields[k]), j.id);
    notify(j.user_id, 'archive:job', jobOut(get('SELECT * FROM archive_jobs WHERE id = ?', j.id)));
  };
  set({ status: 'running' });
  const account = get('SELECT * FROM accounts WHERE id = ?', j.account_id);
  const p = json(j.params_json, {});
  try {
    if (!account) throw new Error('The archive no longer exists');
    if (j.type === 'import') {
      const fn = importers[j.format];
      if (!fn) throw new Error(`Cannot import ${j.format} files`);
      let last = 0;
      const stats = { done: 0, skipped: 0, failed: 0, total: null };
      // Each email: added to its folder (made on first use), or skipped when it is already there.
      // (raw null: an item that is no email — skipped — or that could not be read — failed.)
      const add = async (folderPath, raw, opts = {}) => {
        try {
          if (!raw) { if (opts.error) throw opts.error; stats.skipped++; }
          else if (await addToArchive(account, archiveFolder(account.id, folderPath), raw, { ...opts, anywhere: true })) stats.done++;
          else stats.skipped++;
        } catch (e) { stats.failed++; log.warn(`import ${j.file_name}: ${e.message}`); }
        if (Date.now() - last > 1500) { last = Date.now(); set({ done: stats.done, skipped: stats.skipped, failed: stats.failed, total: stats.total }); await new Promise((r) => setImmediate(r)); }
      };
      await fn(j.file_path, { add, setTotal: (n) => { stats.total = n; }, folder: p.folder || null, name: j.file_name });
      for (const f of all('SELECT id FROM folders WHERE account_id = ?', account.id)) recountFolder(f.id);
      // (Outlook's own counts include hidden items: the total is what was gone through.)
      set({ status: 'done', done: stats.done, skipped: stats.skipped, failed: stats.failed, total: stats.done + stats.skipped + stats.failed, finished_at: now() });
    } else if (j.type === 'move') {
      const folder = archiveFolder(account.id, p.folderPath);
      const ids = p.ids?.length ? p.ids : candidates(j.user_id, p);
      set({ total: ids.length });
      // Each source folder keeps its name in the archive unless one folder was chosen.
      let done = 0, failed = 0;
      const groups = p.folderPath ? [[folder, ids]] : Object.entries(groupByFolder(ids)).map(([name, list]) => [archiveFolder(account.id, name), list]);
      for (const [f, list] of groups) {
        const r = await intoArchive(j.user_id, list, f, { keep: !!p.keep, onProgress: (n) => set({ done: done + n }) });
        done += r.moved; failed += r.failed.length;
        if (r.failed.length) set({ error: `${r.failed.length} not moved: ${r.failed[0].error}` });
      }
      set({ status: 'done', done, failed, finished_at: now() });
    } else if (j.type === 'merge') {
      // Everything goes over folder by folder, each new copy checked. The other archive disappears only when empty, so
      // a merge that fails part way loses nothing and can simply be run again.
      const src = archiveOf(j.user_id, p.fromId);
      if (!src) throw new Error('The other archive no longer exists');
      set({ total: get('SELECT COUNT(*) AS n FROM messages WHERE account_id = ?', src.id).n });
      let done = 0, skipped = 0, failed = 0;
      for (const f of all('SELECT * FROM folders WHERE account_id = ? ORDER BY path', src.id)) {
        const ids = all('SELECT id FROM messages WHERE folder_id = ? ORDER BY id', f.id).map((m) => m.id);
        if (!ids.length) continue;
        const r = await intoArchive(j.user_id, ids, archiveFolder(account.id, f.path), { merge: true, onProgress: (n) => set({ done: done + skipped + n }) });
        done += r.moved; skipped += r.skipped; failed += r.failed.length;
        if (r.failed.length) set({ error: `${r.failed.length} not moved, still in “${src.name}”: ${r.failed[0].error}` });
        set({ done: done + skipped, skipped, failed });
      }
      if (!get('SELECT 1 AS x FROM messages WHERE account_id = ? LIMIT 1', src.id)) {
        run('UPDATE facts SET owner = ? WHERE user_id = ? AND owner = ?', `a:${account.id}`, j.user_id, `a:${src.id}`);
        run('DELETE FROM memory WHERE user_id = ? AND owner = ?', j.user_id, `a:${src.id}`);
        run('DELETE FROM accounts WHERE id = ?', src.id);
      }
      set({ status: 'done', done: done + skipped, skipped, failed, finished_at: now() });
    }
  } catch (e) {
    log.warn(`job ${j.id}: ${e.message}`);
    // Readable and short (some libraries quote binary data in their errors).
    set({ status: 'failed', error: String(e.message || e).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\ufffd]+/g, '').slice(0, 300), finished_at: now() });
  } finally {
    if (j.file_path && !j.keep_file && j.file_path.startsWith(importDir())) fs.rm(j.file_path, { force: true }, () => {});
    notify(j.user_id, 'folders:changed', {});
  }
}

/** Mail of a folder older than a date ("archive everything before 2024"). */
function candidates(userId, { folderId, before }) {
  if (!folderId) return [];
  return all('SELECT m.id FROM messages m JOIN folders f ON f.id = m.folder_id JOIN accounts a ON a.id = f.account_id WHERE m.user_id = ? AND f.id = ? AND m.date < ? ORDER BY m.date',
    userId, Number(folderId), Number(before) || now()).map((r) => r.id);
}

function groupByFolder(ids) {
  const out = {};
  for (const id of ids) {
    const f = get('SELECT f.path, f.name, f.special_use, f.delimiter FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.id = ?', id);
    if (!f) continue;
    const name = { '\\Inbox': 'Inbox', '\\Sent': 'Sent', '\\Drafts': 'Drafts', '\\Archive': 'Archive', '\\Junk': 'Junk', '\\Trash': 'Deleted' }[f.special_use]
      || (f.delimiter && f.delimiter !== '/' ? f.path.split(f.delimiter).join('/') : f.path);
    (out[name] ||= []).push(id);
  }
  return out;
}

export const importDir = () => { const d = path.join(config.dataDir, 'imports'); fs.mkdirSync(d, { recursive: true }); return d; };

/** After a restart: what was running did not finish (imports skip what is already there when started again). */
export function resumeJobs() {
  run("UPDATE archive_jobs SET status = 'queued' WHERE status = 'running'");
  setImmediate(runJobs);
}
