// Composition (MIME build), outbox with undo-send & scheduled send, Sent-folder append, iMIP replies.
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { get, all, run, json, now } from '../db/index.js';
import { smtpTransport } from './connection.js';
import { queueOp } from './sync.js';
import { findSpecialFolder, setFlags, ensureFolder } from './actions.js';
import { afterIngest } from './pipeline.js';
import { readRaw, messageRow, recountFolder, deleteMessages, ingestMessage } from './store.js';
import { collectAddresses } from '../contacts/service.js';
import { htmlToText } from './sanitize.js';
import { notify } from '../util/events.js';
import { logger } from '../util/log.js';
import { crlf } from '../util/crlf.js';
import { parseRaw } from './store.js';

const log = logger('send');
const fmtAddr = (a) => (a.name ? `"${a.name.replace(/"/g, '')}" <${a.address}>` : a.address);
const normAddrs = (list) => (list || []).map((a) => (typeof a === 'string' ? { name: '', address: a.trim() } : a)).filter((a) => a.address);

/**
 * payload: { accountId, from?, to[], cc[], bcc[], subject, html, text, attachments:[{filename, contentType, contentBase64} | {fromMessageId, index}],
 *            inReplyToId?, forwardOfId?, icalEvent?, requestReadReceipt?, priority? }
 */
export async function buildMime(account, p) {
  // From: the account's address or one of its aliases — nothing else, whatever the client sends.
  const allowed = [account.email, ...json(account.aliases_json, []).map((x) => x?.address || x)].filter(Boolean).map((x) => String(x).toLowerCase());
  const fromAddr = allowed.includes(String(p.from?.address || '').toLowerCase()) ? p.from.address : account.email;
  const fromName = p.from?.name ?? account.display_name ?? '';
  const headers = {};
  let inReplyTo, references;
  if (p.inReplyToId) {
    const orig = messageRow(p.inReplyToId);
    if (orig) {
      inReplyTo = `<${orig.message_id}>`;
      references = [...json(orig.references_json, []), orig.message_id].map((r) => `<${r}>`).join(' ');
    }
  }
  const attachments = [];
  for (const a of p.attachments || []) {
    if (a.fromMessageId != null) {
      const m = messageRow(a.fromMessageId);
      const raw = m && readRaw(m);
      if (!raw) continue;
      const parsed = await parseRaw(raw);
      const att = parsed.attachments?.[a.index];
      if (att) attachments.push({ filename: att.filename, content: att.content, contentType: att.contentType, cid: att.cid });
    } else if (a.contentBase64) {
      attachments.push({ filename: a.filename, content: Buffer.from(a.contentBase64, 'base64'), contentType: a.contentType });
    }
  }
  if (p.requestReadReceipt) headers['Disposition-Notification-To'] = fromAddr;
  const mail = new MailComposer({
    from: fmtAddr({ name: fromName, address: fromAddr }),
    to: normAddrs(p.to).map(fmtAddr), cc: normAddrs(p.cc).map(fmtAddr), bcc: normAddrs(p.bcc).map(fmtAddr),
    subject: p.subject || '', html: p.html || undefined, text: p.text || (p.html ? htmlToText(p.html) : ''),
    inReplyTo, references, attachments, headers, priority: p.priority || 'normal',
    icalEvent: p.icalEvent ? { method: p.icalEvent.method, content: p.icalEvent.content } : undefined,
    messageId: `<${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@${fromAddr.split('@')[1] || 'halcyon.local'}>`,
  });
  return new Promise((resolve, reject) => mail.compile().build((err, msg) => (err ? reject(err) : resolve(crlf(msg)))));
}

export function queueSend(userId, payload, { delayMs = 0, sendAt = null } = {}) {
  const account = get('SELECT * FROM accounts WHERE id = ? AND user_id = ?', payload.accountId, userId);
  if (!account) throw new Error('Account not found');
  if (!normAddrs(payload.to).length && !normAddrs(payload.cc).length && !normAddrs(payload.bcc).length) throw new Error('Add at least one recipient');
  const when = sendAt || now() + delayMs;
  const r = run('INSERT INTO outbox (user_id, account_id, payload_json, send_at, created_at) VALUES (?, ?, ?, ?, ?)',
    userId, account.id, JSON.stringify(payload), when, now());
  if (payload.draftId) deleteDraft(userId, payload.draftId);
  notify(userId, 'outbox:changed', {});
  // Deliver as soon as the undo window closes rather than on the next scheduler tick.
  if (when - now() < 3600e3) setTimeout(() => processOutbox().catch((e) => log.warn(`outbox: ${e.message}`)), Math.max(0, when - now()) + 25).unref();
  return { id: r.lastInsertRowid, sendAt: when };
}

// ---- drafts: kept in Halcyon (autosave) and, when the user saves, as one copy in the account's IMAP Drafts folder.

export function saveDraft(userId, b) {
  const payload = JSON.stringify({ ...b, quoteHtml: undefined });
  const replyTo = Number(b.inReplyToId) || null;
  if (b.id && get('SELECT id FROM drafts WHERE id = ? AND user_id = ?', b.id, userId)) {
    run('UPDATE drafts SET account_id = ?, payload_json = ?, in_reply_to = ?, updated_at = ? WHERE id = ?', b.accountId || null, payload, replyTo, now(), b.id);
    return { id: Number(b.id) };
  }
  const r = run('INSERT INTO drafts (user_id, account_id, payload_json, in_reply_to, updated_at) VALUES (?, ?, ?, ?, ?)', userId, b.accountId || null, payload, replyTo, now());
  return { id: Number(r.lastInsertRowid) };
}

// Removes the server copy of a draft. Only the message with this draft's own Message-ID (generated by Halcyon) in the
// Drafts folder is affected, so no other mail can be touched.
function dropServerCopy(userId, d) {
  const account = d?.server_msgid && get('SELECT * FROM accounts WHERE id = ? AND user_id = ?', d.account_id, userId);
  const folder = account && mailFolder(account.id, '\\Drafts');
  if (!folder) return;
  queueOp(account.id, 'deleteByMessageId', { folder: folder.path, messageId: d.server_msgid });
  const local = all('SELECT id FROM messages WHERE folder_id = ? AND message_id = ?', folder.id, d.server_msgid.replace(/^<|>$/g, '')).map((r) => r.id);
  if (local.length) { deleteMessages(local); recountFolder(folder.id); }
}

/** Stores the draft in the IMAP Drafts folder, replacing its previous copy there. */
export async function saveDraftToServer(userId, id) {
  const d = get('SELECT * FROM drafts WHERE id = ? AND user_id = ?', id, userId);
  const p = d && json(d.payload_json, {});
  const account = p && get('SELECT * FROM accounts WHERE id = ? AND user_id = ?', p.accountId || d.account_id, userId);
  if (!account) throw new Error('The draft needs a sending account');
  const folder = mailFolder(account.id, '\\Drafts') || ensureFolder(account.id, '\\Drafts', 'Drafts');
  const raw = await buildMime(account, p);
  const msgid = (raw.toString('utf8', 0, 8192).match(/^Message-ID:\s*(<[^>\r\n]+>)/mi) || [])[1] || null;
  // New copy first, then the previous one is removed: if storing fails, the server keeps the older version.
  queueOp(account.id, 'append', { folder: folder.path, raw: raw.toString('base64'), flags: ['\\Draft', '\\Seen'], kind: 'draft' });
  dropServerCopy(userId, { ...d, account_id: account.id });
  run('UPDATE drafts SET server_msgid = ?, account_id = ?, server_saved_at = ? WHERE id = ?', msgid, account.id, d.updated_at, d.id);
  return { ok: true, folder: folder.name };
}

/** Drafts are kept on the server too (other mail clients see them): each changed draft is stored there once it has
 *  not been edited for half a minute. Called by the scheduler. */
export async function syncDraftsToServer() {
  const due = all(`SELECT id, user_id FROM drafts WHERE account_id IS NOT NULL AND updated_at > COALESCE(server_saved_at, 0) AND updated_at < ?`, now() - 30e3);
  for (const d of due) {
    try { await saveDraftToServer(d.user_id, d.id); } catch (e) {
      log.warn(`draft ${d.id} to server: ${e.message}`);
      run('UPDATE drafts SET server_saved_at = updated_at WHERE id = ?', d.id); // not retried until edited again
    }
  }
}

export function deleteDraft(userId, id) {
  const d = get('SELECT * FROM drafts WHERE id = ? AND user_id = ?', id, userId);
  if (!d) return;
  dropServerCopy(userId, d);
  run('DELETE FROM drafts WHERE id = ?', d.id);
}

export function cancelSend(userId, id) {
  const row = get("SELECT * FROM outbox WHERE id = ? AND user_id = ? AND status IN ('queued', 'failed')", id, userId);
  if (!row) return null;
  run('DELETE FROM outbox WHERE id = ?', id);
  notify(userId, 'outbox:changed', {});
  return json(row.payload_json);
}

export async function deliver(row) {
  const account = get('SELECT * FROM accounts WHERE id = ?', row.account_id);
  const p = json(row.payload_json);
  const raw = await buildMime(account, p);
  const transport = await smtpTransport(account);
  const envelope = {
    from: account.email,
    to: [...normAddrs(p.to), ...normAddrs(p.cc), ...normAddrs(p.bcc)].map((a) => a.address),
  };
  try {
    await transport.sendMail({ envelope, raw });
  } finally { transport.close(); }
  // The original shows as replied / forwarded at once; storing the sent copy below can take a moment.
  if (p.inReplyToId) setFlags(row.user_id, [p.inReplyToId], { answered: true });
  if (p.forwardOfId) setFlags(row.user_id, [p.forwardOfId], { forwarded: true });
  notify(row.user_id, 'mail:sent', { outboxId: row.id, inReplyToId: p.inReplyToId || null });
  // Gmail and Microsoft store sent copies automatically.
  const autoSaves = /gmail\.com|googlemail\.com|office365\.com|outlook\.com/i.test(account.smtp_host || '');
  const sent = sentFolder(account.id) || (autoSaves ? null : ensureFolder(account.id, '\\Sent', 'Sent'));
  // Show the sent message right away (in Sent and in its conversation). It is a local copy until the server's copy is
  // synced and matched by Message-ID; until then it is never cleaned up, and the user can see it is not on the server.
  let localId = null;
  if (sent) {
    try {
      const r = await ingestMessage({ account, folder: sent, uid: null, flags: ['\\Seen'], raw });
      localId = r.id;
      run('UPDATE messages SET local_copy = 1 WHERE id = ? AND uid IS NULL', r.id);
      if (r.isNew) { recountFolder(sent.id); await afterIngest(account, sent, [r.id]); notify(row.user_id, 'mail:changed', { ids: [r.id] }); }
    } catch (e) { log.warn(`local sent copy: ${e.message}`); }
  }
  if (sent && !autoSaves) queueOp(account.id, 'append', { folder: sent.path, raw: raw.toString('base64'), flags: ['\\Seen'], localId, kind: 'sent' });
  collectAddresses(row.user_id, [...normAddrs(p.to), ...normAddrs(p.cc)], now(), true, row.account_id);
}

// Sent folder: special-use flag, else the usual names (servers without SPECIAL-USE, localised names).
// Matched against the folder's own name (last path part), so "INBOX.Sent" and "Sent" both match "Sent".
const FOLDER_NAMES = {
  '\\Sent': ['Sent', 'Sent Items', 'Sent Messages', 'Sent Mail', 'Poslano', 'Poslani elementi', 'Poslana pošta', 'Poslani', 'Gesendet',
    'Gesendete Elemente', 'Gesendete Objekte', 'Elementos enviados', 'Enviados', 'Éléments envoyés', 'Envoyés', 'Posta inviata',
    'Inviati', 'Verzonden items', 'Verzonden', 'Skickat', 'Wysłane', 'Odeslaná pošta', 'Elküldött elemek'],
  '\\Drafts': ['Drafts', 'Draft', 'Osnutki', 'Entwürfe', 'Borradores', 'Brouillons', 'Bozze', 'Concepten', 'Utkast', 'Kopie robocze', 'Koncepty', 'Piszkozatok'],
};
/** The account's Sent / Drafts folder: special-use flag, else a usual (localised) name; null when there is none. */
export function mailFolder(accountId, special) {
  return findSpecialFolder(accountId, special) || (FOLDER_NAMES[special] || []).map((n) => findSpecialFolder(accountId, null, n)).find(Boolean) || null;
}
const sentFolder = (accountId) => mailFolder(accountId, '\\Sent');

/** Last SMTP result per account (shown in Settings → Accounts). */
export const smtpStatus = new Map();

let busy = false;
export async function processOutbox() {
  if (busy) return;
  busy = true;
  try {
    // Interrupted while sending (server restarted): not resent automatically (it may have gone out) — the user decides.
    // (Only one run at a time, so a row still marked 'sending' here was left by a previous server process.)
    run("UPDATE outbox SET status = 'failed', error = ? WHERE status = 'sending'",
      'Sending was interrupted (server restart); it is not known whether the message went out. Check Sent, then send again or save as draft.');
    const due = all("SELECT * FROM outbox WHERE status = 'queued' AND send_at <= ? AND attempts < 5 ORDER BY send_at LIMIT 20", now());
    for (const row of due) {
      run("UPDATE outbox SET status = 'sending' WHERE id = ?", row.id);
      try {
        await deliver(row);
        smtpStatus.set(row.account_id, { ok: true, at: now() });
        run("UPDATE outbox SET status = 'sent', sent_at = ?, error = NULL WHERE id = ?", now(), row.id);
      } catch (e) {
        log.warn(`send failed (${row.id}): ${e.message}`);
        smtpStatus.set(row.account_id, { ok: false, at: now(), error: e.message });
        const attempts = row.attempts + 1;
        run("UPDATE outbox SET status = ?, attempts = ?, error = ?, send_at = ? WHERE id = ?",
          attempts >= 5 ? 'failed' : 'queued', attempts, e.message, now() + attempts * 60e3, row.id);
        notify(row.user_id, 'mail:sendError', { outboxId: row.id, error: e.message });
      }
      notify(row.user_id, 'outbox:changed', {});
    }
    // Keep sent outbox entries for a day for the UI, then clear.
    run("DELETE FROM outbox WHERE status = 'sent' AND sent_at < ?", now() - 864e5);
  } finally { busy = false; }
}
