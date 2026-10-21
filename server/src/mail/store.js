// Ingestion of fetched messages into the local store: parsing, threading, full-text index, hooks.
import fs from 'node:fs';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import { db, get, run, all, json, now } from '../db/index.js';
import { config } from '../config.js';
import { sha1 } from '../util/crypto.js';
import { htmlToText } from './sanitize.js';
import { parseIcs } from '../calendar/ics.js';
import { subjectKey, isReplySubject } from '../util/subject.js';
import { logger } from '../util/log.js';

const log = logger('store');

const addrList = (a) => (a ? (Array.isArray(a) ? a : [a]).flatMap((x) => x.value || []).map((v) => ({ name: v.name || '', address: (v.address || '').toLowerCase() })).filter((v) => v.address) : []);
const cleanId = (s) => (s || '').trim().replace(/^<|>$/g, '');

// The Sender header names who actually sent a message when that is not the From address ("Ana on behalf of the
// Director"). Mailing lists and bulk-mail services set it to list / bounce addresses: those are not worth showing.
const SYSTEM_SENDER = /(^|[-_.+])(bounces?|owner|request|noreply|no-reply|donotreply|mailer-daemon|postmaster|listserv|mailman|majordomo)([-_.+@]|$)/i;
function actingSender(headers, from) {
  const s = addrList(headers.get('sender'))[0];
  if (!s || s.address === String(from.address || '').toLowerCase()) return '';
  if (headers.has('list-id') || headers.has('list-post') || SYSTEM_SENDER.test(s.address)) return '';
  return JSON.stringify(s);
}

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

// Calendar data in a message: a text/calendar or .ics part (any type name senders use), calendar data recognised by its
// content in other text parts, or inside a forwarded message (the original invitation attached as message/rfc822).
const ICS_BLOCK = /BEGIN:VCALENDAR[\s\S]*?END:VCALENDAR/;
export async function findIcs(parsed, depth = 0) {
  const atts = parsed.attachments || [];
  const typed = atts.find((a) => /^(text\/calendar|text\/x-vcalendar|application\/ics|application\/x-ics)/i.test(a.contentType || '') || /\.(ics|vcs)$/i.test(a.filename || ''));
  const block = (s) => { const m = String(s || '').match(ICS_BLOCK); return m && /BEGIN:VEVENT/.test(m[0]) ? m[0] : null; };
  if (typed) return block(typed.content.toString('utf8')) || typed.content.toString('utf8');
  for (const a of atts) {
    if (a.size > 5e6) continue;
    if (/^message\/rfc822/i.test(a.contentType || '') && depth < 2) {
      const inner = await findIcs(await parseRaw(a.content), depth + 1).catch(() => null);
      if (inner) return inner;
    } else if (/^(text\/|application\/octet-stream)/i.test(a.contentType || '')) {
      const b = block(a.content.toString('utf8'));
      if (b) return b;
    }
  }
  // Some clients put the invitation in a text body part.
  return block(parsed.text);
}

/** Invitations in older mail (stored before detection improved): looked for once when the message is opened. */
export async function icsOf(m) {
  if (m.calendar_ics != null) return m.calendar_ics;
  let ics = '';
  const raw = readRaw(m);
  if (raw) { try { ics = (await findIcs(await parseRaw(raw))) || ''; } catch { /* unreadable */ } }
  run('UPDATE messages SET calendar_ics = ? WHERE id = ?', ics, m.id);
  m.calendar_ics = ics;
  if (ics && !String(m.body_text || '').trim() && !m.body_html) run('UPDATE messages SET body_text = ? WHERE id = ?', (m.body_text = inviteText(ics)), m.id);
  return ics;
}

/** Text of an invitation that has no body of its own (only calendar data): its description and location. */
export function inviteText(ics) {
  try {
    const e = parseIcs(ics).events[0];
    return e ? [e.description, e.location && `Location: ${e.location}`].filter(Boolean).join('\n\n') : '';
  } catch { return ''; }
}

export function rawPathFor(accountId, raw) {
  const dir = path.join(config.mailStoreDir, String(accountId));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, sha1(raw) + '.eml');
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
export const ownAddresses = (userId) => new Set(all('SELECT email, aliases_json FROM accounts WHERE user_id = ?', userId)
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
  return simpleParser(raw, { skipImageLinks: true, skipTextToHtml: false, keepCidLinks: true });
}

/**
 * Inserts (or updates the uid of) a message. Returns { id, isNew }.
 */
export async function ingestMessage({ account, folder, uid, flags, raw, internalDate }) {
  const parsed = await parseRaw(raw);
  const messageId = cleanId(parsed.messageId) || `${sha1(raw).slice(0, 24)}@halcyon.local`;
  const inReplyTo = cleanId(parsed.inReplyTo);
  let refs = parsed.references ? (Array.isArray(parsed.references) ? parsed.references : String(parsed.references).split(/\s+/)) : [];
  refs = refs.map(cleanId).filter(Boolean);
  if (inReplyTo && !refs.includes(inReplyTo)) refs.push(inReplyTo);

  // Message moved locally (uid unknown) and now re-discovered → just attach the uid.
  const pendingMove = get('SELECT id FROM messages WHERE folder_id = ? AND uid IS NULL AND message_id = ?', folder.id, messageId);
  if (pendingMove) {
    run('UPDATE messages SET uid = ?, local_copy = 0 WHERE id = ?', uid, pendingMove.id);
    return { id: pendingMove.id, isNew: false };
  }
  const existing = get('SELECT id FROM messages WHERE folder_id = ? AND uid = ?', folder.id, uid);
  if (existing) return { id: existing.id, isNew: false };

  const rawPath = rawPathFor(account.id, raw);
  if (!fs.existsSync(rawPath)) fs.writeFileSync(rawPath, raw);

  const from = addrList(parsed.from)[0] || { name: '', address: '' };
  const to = addrList(parsed.to), cc = addrList(parsed.cc), bcc = addrList(parsed.bcc), replyTo = addrList(parsed.replyTo);
  const html = parsed.html || null;
  let text = parsed.text || (html ? htmlToText(html) : '');
  const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 240);
  const attachments = (parsed.attachments || []).map((a, i) => (
    { index: i, filename: a.filename || `attachment-${i + 1}`, contentType: a.contentType, size: a.size, cid: a.cid || null, inline: a.contentDisposition === 'inline' && !!a.cid }));
  const ics = await findIcs(parsed);
  // An invitation sent as calendar data only: its description is the message.
  if (!html && !text.trim() && ics) text = inviteText(ics);
  const realAttachments = attachments.filter((a) => !a.inline);
  const unsub = parsed.headers.get('list-unsubscribe');
  const unsubStr = unsub ? (typeof unsub === 'string' ? unsub : JSON.stringify(unsub)) : null;
  const date = (parsed.date || internalDate || new Date()).getTime();
  const key = subjectKey(parsed.subject);
  const threadId = resolveThreadId(account.user_id, messageId, refs, {
    key, reply: !!refs.length || isReplySubject(parsed.subject), date, from_addr: from.address, to_json: JSON.stringify(to), cc_json: JSON.stringify(cc), own: ownAddresses(account.user_id),
  });
  const f = flagsToCols(flags);

  const id = db.transaction(() => {
    const r = run(`INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, in_reply_to, references_json, thread_id, subject_key,
      subject, from_name, from_addr, to_json, cc_json, bcc_json, reply_to_json, date, snippet, body_text, body_html,
      has_attachments, attachments_json, size, is_read, is_flagged, is_answered, is_draft, is_forwarded, raw_path, list_unsubscribe, calendar_ics, sender_json, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      account.user_id, account.id, folder.id, uid, messageId, inReplyTo || null, JSON.stringify(refs), threadId, key,
      parsed.subject || '', from.name, from.address, JSON.stringify(to), JSON.stringify(cc), JSON.stringify(bcc), JSON.stringify(replyTo),
      date, snippet, text, html, realAttachments.length ? 1 : 0, JSON.stringify(attachments), raw.length,
      f.is_read, f.is_flagged, f.is_answered, f.is_draft, f.is_forwarded, rawPath, unsubStr, ics || '', actingSender(parsed.headers, from), now());
    const mid = r.lastInsertRowid;
    run('INSERT INTO messages_fts (rowid, subject, sender, recipients, body) VALUES (?, ?, ?, ?, ?)', mid, parsed.subject || '',
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
