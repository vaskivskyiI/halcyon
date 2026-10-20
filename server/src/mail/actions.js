// User-initiated mailbox operations. Applied locally first (instant UI), then replayed on the server.
import { get, all, run, tx, now, json } from '../db/index.js';
import { queueOp, runningOps } from './sync.js';
import { recountFolder, deleteMessages, readRaw } from './store.js';
import { notify } from '../util/events.js';

function ownedMessages(userId, ids) {
  if (!ids?.length) return [];
  const ph = ids.map(() => '?').join(',');
  return all(`SELECT m.id, m.uid, m.account_id, m.folder_id, f.path AS folder_path, f.special_use, m.raw_path, m.is_read
    FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.user_id = ? AND m.id IN (${ph})`, userId, ...ids.map(Number));
}

const groupBy = (arr, key) => arr.reduce((m, x) => { (m[x[key]] ||= []).push(x); return m; }, {});

export function setFlags(userId, ids, { read, flagged, answered }) {
  const msgs = ownedMessages(userId, ids);
  tx(() => {
    for (const m of msgs) {
      if (read !== undefined) run('UPDATE messages SET is_read = ? WHERE id = ?', read ? 1 : 0, m.id);
      if (flagged !== undefined) run('UPDATE messages SET is_flagged = ? WHERE id = ?', flagged ? 1 : 0, m.id);
      if (answered !== undefined) run('UPDATE messages SET is_answered = ? WHERE id = ?', answered ? 1 : 0, m.id);
    }
  });
  const add = [], remove = [];
  if (read !== undefined) (read ? add : remove).push('\\Seen');
  if (flagged !== undefined) (flagged ? add : remove).push('\\Flagged');
  if (answered !== undefined) (answered ? add : remove).push('\\Answered');
  for (const group of Object.values(groupBy(msgs, 'folder_id'))) {
    const uids = group.map((m) => m.uid).filter(Boolean);
    if (uids.length) queueOp(group[0].account_id, 'flags', { folder: group[0].folder_path, uids, add, remove });
    recountFolder(group[0].folder_id);
  }
  notify(userId, 'mail:changed', { ids });
  return msgs.length;
}

export function findSpecialFolder(accountId, special, fallbackName) {
  let f = get('SELECT * FROM folders WHERE account_id = ? AND special_use = ?', accountId, special);
  if (!f && fallbackName) f = get('SELECT * FROM folders WHERE account_id = ? AND lower(name) = lower(?)', accountId, fallbackName);
  return f;
}

export function ensureFolder(accountId, special, name) {
  let f = findSpecialFolder(accountId, special, name);
  if (f) return f;
  const r = run('INSERT INTO folders (account_id, path, name, special_use, sync_enabled) VALUES (?, ?, ?, ?, 1)', accountId, name, name, special);
  queueOp(accountId, 'createFolder', { path: name });
  return get('SELECT * FROM folders WHERE id = ?', r.lastInsertRowid);
}

export async function moveMessages(userId, ids, targetFolderId) {
  const target = get('SELECT f.* FROM folders f JOIN accounts a ON a.id = f.account_id WHERE f.id = ? AND a.user_id = ?', targetFolderId, userId);
  if (!target) throw new Error('Target folder not found');
  const msgs = ownedMessages(userId, ids).filter((m) => m.folder_id !== target.id);
  for (const group of Object.values(groupBy(msgs, 'folder_id'))) {
    const src = group[0];
    if (src.account_id === target.account_id) {
      const map = {};
      tx(() => { for (const m of group) { run('UPDATE messages SET folder_id = ?, uid = NULL WHERE id = ?', target.id, m.id); if (m.uid) map[m.uid] = m.id; } });
      const uids = group.map((m) => m.uid).filter(Boolean);
      if (uids.length) queueOp(src.account_id, 'move', { from: src.folder_path, to: target.path, uids, map });
    } else {
      // Cross-account move: append the raw message to the target account, then delete at source.
      for (const m of group) {
        const raw = readRaw(m);
        if (raw) queueOp(target.account_id, 'append', { folder: target.path, raw: raw.toString('base64'), flags: m.is_read ? ['\\Seen'] : [] });
        if (m.uid) queueOp(src.account_id, 'delete', { folder: src.folder_path, uids: [m.uid] });
      }
      deleteMessages(group.map((m) => m.id));
    }
    recountFolder(src.folder_id);
  }
  recountFolder(target.id);
  notify(userId, 'mail:changed', { ids });
  return msgs.length;
}

async function moveToSpecial(userId, ids, special, name) {
  const msgs = ownedMessages(userId, ids);
  for (const [accountId, group] of Object.entries(groupBy(msgs, 'account_id'))) {
    const target = ensureFolder(Number(accountId), special, name);
    await moveMessages(userId, group.filter((m) => m.folder_id !== target.id).map((m) => m.id), target.id);
  }
}

export const archiveMessages = (userId, ids) => moveToSpecial(userId, ids, '\\Archive', 'Archive');
export const spamMessages = (userId, ids) => moveToSpecial(userId, ids, '\\Junk', 'Junk');

export async function notSpam(userId, ids) {
  const msgs = ownedMessages(userId, ids);
  for (const [accountId, group] of Object.entries(groupBy(msgs, 'account_id'))) {
    const inbox = findSpecialFolder(Number(accountId), '\\Inbox', 'INBOX');
    if (inbox) await moveMessages(userId, group.map((m) => m.id), inbox.id);
  }
}

// Moving to Trash never deletes: mail already in Trash/Junk is left alone. Permanent deletion is only the explicit
// 'delete' action, which the UI always confirms.
export async function trashMessages(userId, ids) {
  const rest = ownedMessages(userId, ids).filter((m) => m.special_use !== '\\Trash' && m.special_use !== '\\Junk');
  if (rest.length) await moveToSpecial(userId, rest.map((m) => m.id), '\\Trash', 'Trash');
}

/** Folder of each message, recorded before a move so it can be undone. */
export const folderSnapshot = (userId, ids) => ownedMessages(userId, ids).map((m) => ({ id: m.id, folderId: m.folder_id }));

/**
 * Undo of archive / trash / spam / move: puts messages back into the folders they came from. A move not yet sent
 * to the server is simply cancelled; one being sent right now is waited for and then reversed.
 */
export async function restoreMessages(userId, items) {
  for (const { id, folderId } of items || []) {
    let m = ownedMessages(userId, [id])[0];
    const target = m && get('SELECT f.* FROM folders f JOIN accounts a ON a.id = f.account_id WHERE f.id = ? AND a.user_id = ?', Number(folderId), userId);
    if (!m || !target || m.folder_id === target.id) continue;
    if (m.uid == null) {
      const ops = all("SELECT * FROM pending_ops WHERE account_id = ? AND op = 'move'", m.account_id)
        .map((o) => ({ ...o, p: json(o.payload_json, {}) })).filter((o) => Object.values(o.p.map || {}).map(Number).includes(m.id));
      for (let i = 0; i < 100 && ops.some((o) => runningOps.has(o.id)); i++) await new Promise((r) => setTimeout(r, 100));
      const pending = ops.find((o) => !runningOps.has(o.id) && get('SELECT 1 AS x FROM pending_ops WHERE id = ?', o.id));
      if (pending && pending.p.from === target.path) {
        const oldUid = Object.entries(pending.p.map).find(([, v]) => Number(v) === m.id)[0];
        const uids = pending.p.uids.filter((u) => String(u) !== String(oldUid));
        delete pending.p.map[oldUid];
        tx(() => {
          if (uids.length) run('UPDATE pending_ops SET payload_json = ? WHERE id = ?', JSON.stringify({ ...pending.p, uids }), pending.id);
          else run('DELETE FROM pending_ops WHERE id = ?', pending.id);
          run('UPDATE messages SET folder_id = ?, uid = ? WHERE id = ?', target.id, Number(oldUid), m.id);
        });
        recountFolder(m.folder_id); recountFolder(target.id);
        continue;
      }
      m = ownedMessages(userId, [id])[0];
    }
    await moveMessages(userId, [m.id], target.id);
  }
  notify(userId, 'mail:changed', { ids: (items || []).map((x) => x.id) });
}

export function deletePermanently(userId, ids) {
  const msgs = ownedMessages(userId, ids);
  for (const group of Object.values(groupBy(msgs, 'folder_id'))) {
    const uids = group.map((m) => m.uid).filter(Boolean);
    if (uids.length) queueOp(group[0].account_id, 'delete', { folder: group[0].folder_path, uids });
    deleteMessages(group.map((m) => m.id));
    recountFolder(group[0].folder_id);
  }
  notify(userId, 'mail:changed', { ids });
}

export function snoozeMessages(userId, ids, until) {
  const msgs = ownedMessages(userId, ids);
  tx(() => { for (const m of msgs) run('UPDATE messages SET snoozed_until = ? WHERE id = ?', until || null, m.id); });
  notify(userId, 'mail:changed', { ids });
}

export function wakeSnoozed() {
  const due = all('SELECT id, user_id FROM messages WHERE snoozed_until IS NOT NULL AND snoozed_until <= ?', now());
  for (const m of due) {
    run('UPDATE messages SET snoozed_until = NULL WHERE id = ?', m.id);
    setFlags(m.user_id, [m.id], { read: false });
    notify(m.user_id, 'mail:unsnoozed', { id: m.id });
  }
}

export function setLabels(userId, ids, { add = [], remove = [] }) {
  const msgs = ownedMessages(userId, ids);
  tx(() => {
    for (const m of msgs) {
      const cur = new Set(json(get('SELECT labels_json FROM messages WHERE id = ?', m.id)?.labels_json, []));
      add.forEach((l) => cur.add(Number(l)));
      remove.forEach((l) => cur.delete(Number(l)));
      run('UPDATE messages SET labels_json = ? WHERE id = ?', JSON.stringify([...cur]), m.id);
    }
  });
  notify(userId, 'mail:changed', { ids });
}
