// Ingestion of fetched messages into the local store: parsing, threading, full-text index, hooks.
import fs from 'node:fs';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import { db, get, run, all, json, now } from '../db/index.js';
import { config } from '../config.js';
import { sha1 } from '../util/crypto.js';
import { htmlToText } from './sanitize.js';

const addrList = (a) => (a ? (Array.isArray(a) ? a : [a]).flatMap((x) => x.value || []).map((v) => ({ name: v.name || '', address: (v.address || '').toLowerCase() })).filter((v) => v.address) : []);
const cleanId = (s) => (s || '').trim().replace(/^<|>$/g, '');

export function rawPathFor(accountId, raw) {
  const dir = path.join(config.mailStoreDir, String(accountId));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, sha1(raw) + '.eml');
}

export function readRaw(message) {
  if (!message?.raw_path || !fs.existsSync(message.raw_path)) return null;
  return fs.readFileSync(message.raw_path);
}

function resolveThreadId(userId, messageId, refs) {
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
  return sha1(refs[0] || messageId || String(Math.random())).slice(0, 20);
}

export function flagsToCols(flags) {
  const f = new Set(flags || []);
  return { is_read: f.has('\\Seen') ? 1 : 0, is_flagged: f.has('\\Flagged') ? 1 : 0, is_answered: f.has('\\Answered') ? 1 : 0, is_draft: f.has('\\Draft') ? 1 : 0 };
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
    run('UPDATE messages SET uid = ? WHERE id = ?', uid, pendingMove.id);
    return { id: pendingMove.id, isNew: false };
  }
  const existing = get('SELECT id FROM messages WHERE folder_id = ? AND uid = ?', folder.id, uid);
  if (existing) return { id: existing.id, isNew: false };

  const rawPath = rawPathFor(account.id, raw);
  if (!fs.existsSync(rawPath)) fs.writeFileSync(rawPath, raw);

  const from = addrList(parsed.from)[0] || { name: '', address: '' };
  const to = addrList(parsed.to), cc = addrList(parsed.cc), bcc = addrList(parsed.bcc), replyTo = addrList(parsed.replyTo);
  const html = parsed.html || null;
  const text = parsed.text || (html ? htmlToText(html) : '');
  const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 240);
  let ics = null;
  const attachments = (parsed.attachments || []).map((a, i) => {
    if (a.contentType === 'text/calendar' || /\.ics$/i.test(a.filename || '')) ics = a.content.toString('utf8');
    return { index: i, filename: a.filename || `attachment-${i + 1}`, contentType: a.contentType, size: a.size, cid: a.cid || null, inline: a.contentDisposition === 'inline' && !!a.cid };
  });
  // Some clients put the invitation in an alternative body part rather than an attachment.
  if (!ics && /BEGIN:VCALENDAR/.test(text) && /METHOD:/.test(text)) ics = text.slice(text.indexOf('BEGIN:VCALENDAR'));
  const realAttachments = attachments.filter((a) => !a.inline);
  const unsub = parsed.headers.get('list-unsubscribe');
  const unsubStr = unsub ? (typeof unsub === 'string' ? unsub : JSON.stringify(unsub)) : null;
  const date = (parsed.date || internalDate || new Date()).getTime();
  const threadId = resolveThreadId(account.user_id, messageId, refs);
  const f = flagsToCols(flags);

  const id = db.transaction(() => {
    const r = run(`INSERT INTO messages (user_id, account_id, folder_id, uid, message_id, in_reply_to, references_json, thread_id,
      subject, from_name, from_addr, to_json, cc_json, bcc_json, reply_to_json, date, snippet, body_text, body_html,
      has_attachments, attachments_json, size, is_read, is_flagged, is_answered, is_draft, raw_path, list_unsubscribe, calendar_ics, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      account.user_id, account.id, folder.id, uid, messageId, inReplyTo || null, JSON.stringify(refs), threadId,
      parsed.subject || '', from.name, from.address, JSON.stringify(to), JSON.stringify(cc), JSON.stringify(bcc), JSON.stringify(replyTo),
      date, snippet, text, html, realAttachments.length ? 1 : 0, JSON.stringify(attachments), raw.length,
      f.is_read, f.is_flagged, f.is_answered, f.is_draft, rawPath, unsubStr, ics, now());
    const mid = r.lastInsertRowid;
    run('INSERT INTO messages_fts (rowid, subject, sender, recipients, body) VALUES (?, ?, ?, ?, ?)', mid, parsed.subject || '',
      `${from.name} ${from.address}`, [...to, ...cc].map((a) => `${a.name} ${a.address}`).join(' '), text.slice(0, 30000));
    return mid;
  })();
  return { id, isNew: true };
}

export function deleteMessages(ids) {
  if (!ids.length) return;
  db.transaction(() => {
    for (const id of ids) {
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
    hasAttachments: !!m.has_attachments, isRead: !!m.is_read, isFlagged: !!m.is_flagged, isAnswered: !!m.is_answered,
    isDraft: !!m.is_draft, snoozedUntil: m.snoozed_until, labels: json(m.labels_json, []), aiStatus: m.ai_status,
    hasInvite: !!m.calendar_ics, ...extra,
  };
}

export function allFoldersOf(accountId) {
  return all('SELECT * FROM folders WHERE account_id = ? ORDER BY path', accountId);
}
