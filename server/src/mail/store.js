// Ingestion of fetched messages into the local store: parsing, threading, full-text index, hooks.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { tracked } from '../util/activity.js';
import { workerPool } from '../util/workers.js';
import { simpleParse, digestAndSave, findIcs, inviteText, actingSender } from './parse.js';
import { db, get, run, all, json, now } from '../db/index.js';
import { config } from '../config.js';
import { sha1 } from '../util/crypto.js';
import { subjectKey, isReplySubject } from '../util/subject.js';
import { logger } from '../util/log.js';

const log = logger('store');
export { findIcs, inviteText, fallbackParse } from './parse.js';

/** Sender of older mail (stored before sender_json existed): read once from the raw headers, then kept. */
export async function senderOf(m) {
  if (m.sender_json != null) return m.sender_json;
  let v = '';
  const raw = readRaw(m);
  if (raw) {
    const end = raw.indexOf('\r\n\r\n');
    try { v = actingSender((await parseRaw(raw.subarray(0, end > 0 ? end + 4 : Math.min(raw.length, 65536)))).headers, { address: m.from_addr }); } catch { /* unreadable: nothing to show */ }
  }
  run('UPDATE messages SET sender_json = ? WHERE id = ?', v, m.id);
  m.sender_json = v;
  return v;
}

/** Invitations in older mail (stored before detection improved): looked for once when the message is opened. */
// Parts findIcs looks in; mail with none of them (and no calendar data in its text) is not read from disk and parsed.
const ICS_PART = /^(text\/|application\/(ics|x-ics|octet-stream)|message\/rfc822)|\.(ics|vcs)$/i;
const mayHoldIcs = (m) => /BEGIN:VCALENDAR/.test(`${m.body_text || ''}${m.body_html || ''}`)
  || json(m.attachments_json, []).some((a) => ICS_PART.test(a.contentType || '') || ICS_PART.test(a.filename || ''));

export async function icsOf(m) {
  if (m.calendar_ics != null) return m.calendar_ics;
  let ics = '';
  const raw = mayHoldIcs(m) ? readRaw(m) : null;
  if (raw) { try { ics = (await findIcs(await parseRaw(raw))) || ''; } catch { /* unreadable */ } }
  run('UPDATE messages SET calendar_ics = ? WHERE id = ?', ics, m.id);
  m.calendar_ics = ics;
  if (ics && !String(m.body_text || '').trim() && !m.body_html) run('UPDATE messages SET body_text = ? WHERE id = ?', (m.body_text = inviteText(ics)), m.id);
  return ics;
}

export function readRaw(message) {
  if (!message?.raw_path || !fs.existsSync(message.raw_path)) return null;
  return fs.readFileSync(message.raw_path);
}

function resolveThreadId(userId, messageId, refs, bySubject) {
  const candidates = [...refs].reverse();
  if (candidates.length) {
    const placeholders = candidates.map(() => '?').join(',');
    const hit = db.prepare(`SELECT thread_id FROM messages WHERE user_id = ? AND message_id IN (${placeholders}) AND thread_id IS NOT NULL LIMIT 1`).get(userId, ...candidates);
    if (hit) return hit.thread_id;
  }
  if (messageId) {
    const child = get('SELECT thread_id FROM messages WHERE user_id = ? AND in_reply_to = ? LIMIT 1', userId, messageId);
    if (child) return child.thread_id;
  }
  // Reply headers missing or pointing to mail we do not have: same subject (prefixes in any language stripped),
  // a shared participant and close in time.
  const hit = bySubject && subjectThread(userId, bySubject);
  if (hit) return hit;
  return sha1(refs[0] || messageId || String(Math.random())).slice(0, 20);
}

const SUBJECT_WINDOW = 45 * 864e5;
export const ownAddresses = (userId) => new Set(all('SELECT email, aliases_json FROM accounts WHERE user_id = ? AND mail != 0', userId)
  .flatMap((a) => [a.email, ...json(a.aliases_json, []).map((x) => (typeof x === 'string' ? x : x?.address))]).filter(Boolean).map((x) => x.toLowerCase()));
const people = (m) => [m.from_addr, ...json(m.to_json, []).map((a) => a.address), ...json(m.cc_json, []).map((a) => a.address)]
  .filter(Boolean).map((a) => String(a).toLowerCase());

/** m: { id?, key, reply, date, from_addr, to_json, cc_json, own: Set of the user's addresses } → thread_id or null. */
export function subjectThread(userId, m) {
  if (!m.key) return null;
  const mine = people(m).filter((a) => !m.own.has(a));
  if (!mine.length) return null;
  const rows = all(`SELECT id, thread_id, subject, from_addr, to_json, cc_json FROM messages WHERE user_id = ? AND subject_key = ? AND date BETWEEN ? AND ?
    AND id != ? ORDER BY abs(date - ?) LIMIT 20`, userId, m.key, m.date - SUBJECT_WINDOW, m.date + SUBJECT_WINDOW, m.id || 0, m.date);
  for (const r of rows) {
    // A reply joins anything; an original only joins replies (two separate mails titled "Report" stay apart).
    if (!m.reply && !isReplySubject(r.subject)) continue;
    if (people(r).some((a) => mine.includes(a))) return r.thread_id;
  }
  return null;
}

export function flagsToCols(flags) {
  const f = new Set(flags || []);
  return { is_read: f.has('\\Seen') ? 1 : 0, is_flagged: f.has('\\Flagged') ? 1 : 0, is_answered: f.has('\\Answered') ? 1 : 0, is_draft: f.has('\\Draft') ? 1 : 0, is_forwarded: f.has('$Forwarded') ? 1 : 0 };
}

export async function parseRaw(raw) {
  // Tracked: a large message keeps the CPU busy here (admin activity view).
  return tracked('parse', 'Read email (mailparser)', { kb: Math.round(raw.length / 1024) }, () => simpleParse(raw));
}

// New mail is parsed in worker threads (parse-worker.js): taking a large or tricky message apart keeps the CPU busy for
// tens of milliseconds, during which no request would be answered. Writing it stays here: one writer, no lock waits.
const parsers = workerPool(new URL('./parse-worker.js', import.meta.url), { name: 'Mail parsing', size: Math.max(1, Math.min(2, os.availableParallelism() - 1)) });
// Should a worker fail (not the message: that gives the fallback in digest), the message is parsed here.
const digestRaw = (raw, dir) => tracked('parse', 'Read email (worker)', { kb: Math.round(raw.length / 1024) },
  () => parsers.call('digest', { raw, dir }).catch((e) => { log.warn(`parse worker: ${e.message}`); return digestAndSave(raw, dir); }));

/**
 * Inserts (or updates the uid of) a message. Returns { id, isNew }.
 */
export async function ingestMessage({ account, folder, uid, flags, raw, internalDate }) {
  const d = await digestRaw(raw, path.join(config.mailStoreDir, String(account.id)));
  const messageId = d.messageId || `${sha1(raw).slice(0, 24)}@halcyon.local`;
  const { inReplyTo, refs, from, to, cc, bcc, replyTo, html, text, snippet, attachments, ics } = d;

  // Message moved locally (uid unknown) and now re-discovered → just attach the uid.
  const pendingMove = get('SELECT id FROM messages WHERE folder_id = ? AND uid IS NULL AND message_id = ?', folder.id, messageId);
  if (pendingMove) {
    run('UPDATE messages SET uid = ?, local_copy = 0 WHERE id = ?', uid, pendingMove.id);
    return { id: pendingMove.id, isNew: false };
  }
  const existing = get('SELECT id FROM messages WHERE folder_id = ? AND uid = ?', folder.id, uid);
  if (existing) return { id: existing.id, isNew: false };

  const realAttachments = attachments.filter((a) => !a.inline);
  const date = d.date || (internalDate || new Date()).getTime();
  const key = subjectKey(d.subject);
  const threadId = resolveThreadId(account.user_id, messageId, refs, {
    key, reply: !!refs.length || isReplySubject(d.subject), date, from_addr: from.address, to_json: JSON.stringify(to), cc_json: JSON.stringify(cc), own: ownAddresses(account.user_id),
  });
  const f = flagsToCols(flags);

  const id = db.transaction(() => {
    const r = run(`INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, in_reply_to, references_json, thread_id, subject_key,
      subject, from_name, from_addr, to_json, cc_json, bcc_json, reply_to_json, date, snippet, body_text, body_html,
      has_attachments, attachments_json, size, is_read, is_flagged, is_answered, is_draft, is_forwarded, raw_path, list_unsubscribe, calendar_ics, sender_json, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      account.user_id, account.id, folder.id, uid, messageId, inReplyTo || null, JSON.stringify(refs), threadId, key,
      d.subject, from.name, from.address, JSON.stringify(to), JSON.stringify(cc), JSON.stringify(bcc), JSON.stringify(replyTo),
      date, snippet, text, html, realAttachments.length ? 1 : 0, JSON.stringify(attachments), raw.length,
      f.is_read, f.is_flagged, f.is_answered, f.is_draft, f.is_forwarded, d.rawPath, d.unsubscribe, ics, d.sender, now());
    const mid = r.lastInsertRowid;
    run('INSERT INTO messages_fts (rowid, subject, sender, recipients, body) VALUES (?, ?, ?, ?, ?)', mid, d.subject,
      `${from.name} ${from.address}`, [...to, ...cc].map((a) => `${a.name} ${a.address}`).join(' '), text.slice(0, 30000));
    return mid;
  })();
  restoreInsight(account.user_id, id, messageId);
  return { id, isNew: true };
}

/** keepAnalysis: removed by sync, not by the user — the AI analysis is kept a week in case the mail comes back. */
/** Puts back the archived analysis of a message that came back (see deleteMessages); true when restored. */
export function restoreInsight(userId, id, msgid) {
  const a = msgid && get('SELECT data_json FROM insight_archive WHERE user_id = ? AND msgid = ?', userId, msgid);
  if (!a) return false;
  const data = json(a.data_json, {});
  const cols = Object.keys(data).filter((k) => /^[a-z_]+$/.test(k));
  run(`INSERT OR REPLACE INTO ai_insights (message_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`, id, ...cols.map((k) => data[k]));
  run("UPDATE messages SET ai_status = 'done' WHERE id = ?", id);
  run('DELETE FROM insight_archive WHERE user_id = ? AND msgid = ?', userId, msgid);
  return true;
}

export function deleteMessages(ids, { keepAnalysis = false } = {}) {
  if (!ids.length) return;
  db.transaction(() => {
    for (const id of ids) {
      if (keepAnalysis) {
        const i = get('SELECT i.*, m.user_id AS uid, m.message_id AS msgid FROM ai_insights i JOIN messages m ON m.id = i.message_id WHERE i.message_id = ?', id);
        if (i?.msgid) {
          const { message_id: _m, uid: u, msgid, ...data } = i;
          run('INSERT OR REPLACE INTO insight_archive (user_id, msgid, data_json, created_at) VALUES (?, ?, ?, ?)', u, msgid, JSON.stringify(data), now());
        }
      }
      // The AI memory must not keep text of deleted mail (facts derived from it stay until the user removes them).
      const uid = get('SELECT user_id FROM messages WHERE id = ?', id)?.user_id;
      if (uid) run("DELETE FROM memory WHERE user_id = ? AND kind = 'message' AND ref_id = ?", uid, String(id));
      run('DELETE FROM messages_fts WHERE rowid = ?', id);
      run('DELETE FROM messages WHERE id = ?', id);
    }
  })();
}

export function recountFolder(folderId) {
  const c = get('SELECT COUNT(*) AS total, SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread FROM messages WHERE folder_id = ?', folderId);
  run('UPDATE folders SET total = ?, unread = ? WHERE id = ?', c.total || 0, c.unread || 0, folderId);
}

export function messageRow(id) {
  return get('SELECT * FROM messages WHERE id = ?', id);
}

export function serializeMessage(m, extra = {}) {
  if (!m) return null;
  return {
    id: m.id, accountId: m.account_id, folderId: m.folder_id, uid: m.uid, messageId: m.message_id, threadId: m.thread_id,
    subject: m.subject, from: { name: m.from_name, address: m.from_addr }, to: json(m.to_json, []), cc: json(m.cc_json, []),
    bcc: json(m.bcc_json, []), replyTo: json(m.reply_to_json, []), date: m.date, snippet: m.snippet,
    hasAttachments: !!m.has_attachments, isRead: !!m.is_read, isFlagged: !!m.is_flagged, isAnswered: !!m.is_answered, isForwarded: !!m.is_forwarded, notOnServer: !!m.local_copy && m.uid == null,
    onBehalfOf: m.sender_json ? json(m.sender_json, null) : null,
    isDraft: !!m.is_draft, snoozedUntil: m.snoozed_until, labels: json(m.labels_json, []), aiStatus: m.ai_status,
    hasInvite: !!m.calendar_ics, ...extra,
  };
}

export function allFoldersOf(accountId) {
  return all('SELECT * FROM folders WHERE account_id = ? ORDER BY path', accountId);
}

/**
 * One-time pass over mail stored before subject grouping existed: fills subject_key, then lets single-message
 * conversations join the conversation they belong to by subject. Runs in small chunks (never blocks the server).
 */
export async function regroupConversations() {
  if (get("SELECT value FROM app_state WHERE key = 'regroup:v1'")) return;
  const pause = () => new Promise((r) => setImmediate(r));
  for (;;) {
    const rows = all('SELECT id, subject FROM messages WHERE subject_key IS NULL LIMIT 2000');
    if (!rows.length) break;
    // '' marks "no usable key" so the row is not picked up again.
    db.transaction(() => { for (const r of rows) run('UPDATE messages SET subject_key = ? WHERE id = ?', subjectKey(r.subject) || '', r.id); })();
    await pause();
  }
  let joined = 0;
  for (const { user_id: userId } of all('SELECT DISTINCT user_id FROM messages')) {
    const own = ownAddresses(userId);
    const size = new Map(all('SELECT thread_id, COUNT(*) AS n FROM messages WHERE user_id = ? GROUP BY thread_id', userId).map((r) => [r.thread_id, r.n]));
    const singles = all(`SELECT id, thread_id, subject, subject_key AS key, date, from_addr, to_json, cc_json, references_json FROM messages
      WHERE user_id = ? AND subject_key != '' ORDER BY date`, userId).filter((m) => size.get(m.thread_id) === 1);
    for (let i = 0; i < singles.length; i++) {
      const m = singles[i];
      if (size.get(m.thread_id) !== 1) continue;
      const target = subjectThread(userId, { ...m, own, reply: json(m.references_json, []).length > 0 || isReplySubject(m.subject) });
      if (target && target !== m.thread_id) {
        run('UPDATE messages SET thread_id = ? WHERE id = ?', target, m.id);
        size.set(m.thread_id, 0); size.set(target, (size.get(target) || 0) + 1);
        joined++;
      }
      if (i % 300 === 299) await pause();
    }
  }
  run("INSERT OR REPLACE INTO app_state (key, value) VALUES ('regroup:v1', ?)", String(Date.now()));
  if (joined) log.info(`conversations: ${joined} messages joined their conversation by subject`);
}
