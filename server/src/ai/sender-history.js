// What the user has done with a sender's mail so far, for the analysis: how long and how much they have written, how
// much of it the user opened, answered, deleted (also unread), archived or called spam, and how often the user wrote
// to them. Deletions and spam verdicts are also counted in sender_stats when they happen, so they are remembered after
// the mail itself is gone from Trash. Given to the AI as evidence; a sender whose mail the user keeps deleting is also
// held low here, and a person the user writes to is never sorted out of Focused for a low score alone.
import { get, run, now } from '../db/index.js';
import { localStamp } from './prompts.js';

const lower = (a) => String(a || '').toLowerCase();

/** Counts what the user does with mail (an action of routes/mail.js) per sender; msgs: rows with from_addr, is_read, special_use. */
export function countSenderAction(userId, msgs, action) {
  const col = { trash: 'deleted', delete: 'deleted', archive: 'archived', spam: 'spam' }[action];
  if (!col) return;
  for (const m of msgs) {
    const a = lower(m.from_addr);
    if (!a.includes('@') || (action === 'delete' && ['\\Trash', '\\Junk'].includes(m.special_use))) continue; // counted when trashed
    run(`INSERT INTO sender_stats (user_id, address, ${col}, deleted_unread, updated_at) VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(user_id, address) DO UPDATE SET ${col} = ${col} + 1, deleted_unread = deleted_unread + excluded.deleted_unread, updated_at = excluded.updated_at`,
    userId, a, col === 'deleted' && !m.is_read ? 1 : 0, now());
  }
}

/** Numbers about the sender (whole mailbox, all time), excluding the email m itself. */
export function senderStats(userId, m) {
  const from = lower(m.from_addr);
  const r = get(`SELECT COUNT(*) AS received, MIN(x.date) AS first, SUM(x.is_read) AS opened, SUM(x.is_answered) AS answered,
      SUM(f.special_use = '\\Trash') AS inTrash, SUM(f.special_use = '\\Trash' AND x.is_read = 0) AS trashUnread, SUM(f.special_use = '\\Junk') AS inJunk,
      SUM(f.special_use = '\\Archive') AS inArchive
    FROM messages x JOIN folders f ON f.id = x.folder_id WHERE x.user_id = ? AND lower(x.from_addr) = ? AND x.id != ? AND x.is_draft = 0`, userId, from, m.id) || {};
  const sent = get(`SELECT COUNT(*) AS n, MAX(x.date) AS last FROM messages x JOIN folders f ON f.id = x.folder_id
    WHERE x.user_id = ? AND f.special_use = '\\Sent' AND (lower(x.to_json) LIKE ? OR lower(x.cc_json) LIKE ?)`, userId, `%"${from}"%`, `%"${from}"%`) || {};
  const s = get('SELECT deleted, deleted_unread, archived, spam FROM sender_stats WHERE user_id = ? AND address = ?', userId, from) || {};
  // Mail deleted for good (Trash emptied) is no longer in messages but was received.
  const gone = Math.max(0, (s.deleted || 0) - (r.inTrash || 0)) + Math.max(0, (s.spam || 0) - (r.inJunk || 0));
  return {
    received: (r.received || 0) + gone, first: r.first || null, opened: r.opened || 0, answered: r.answered || 0,
    deleted: Math.max(s.deleted || 0, r.inTrash || 0), deletedUnread: Math.max(s.deleted_unread || 0, r.trashUnread || 0),
    archived: Math.max(s.archived || 0, r.inArchive || 0), spam: Math.max(s.spam || 0, r.inJunk || 0),
    sentTo: sent.n || 0, lastSent: sent.last || null,
  };
}

/** The numbers as a prompt paragraph. */
export function senderHistoryText(st, tz) {
  if (!st.received && !st.sentTo) return 'SENDER HISTORY: this is the first email from this address; the user has never written to it.';
  const day = (t) => localStamp(t, tz).slice(4, 14);
  const parts = [];
  if (st.received) {
    parts.push(`${st.received} earlier email${st.received === 1 ? '' : 's'} from this address${st.first ? ` since ${day(st.first)}` : ''}: the user opened ${st.opened}, replied to ${st.answered}`
      + `, deleted ${st.deleted}${st.deletedUnread ? ` (${st.deletedUnread} without reading)` : ''}, archived ${st.archived}${st.spam ? `, reported ${st.spam} as spam` : ''}.`);
  } else parts.push('First email received from this address.');
  parts.push(st.sentTo ? `The user has written to them ${st.sentTo} time${st.sentTo === 1 ? '' : 's'} (last ${day(st.lastSent)}).` : 'The user has never written to them.');
  return `SENDER HISTORY (what the user did with mail from this sender — strong evidence of how much it matters to them):\n${parts.join(' ')}`;
}

/** The user keeps deleting this sender's mail (at least 4 and most of it) and never answered: unwanted. */
export const mostlyDeleted = (st) => st.received >= 4 && st.answered === 0 && st.sentTo === 0 && (st.deleted + st.spam) >= 0.7 * st.received;

/**
 * Applied to fresh analysis output (mutates d): mostly-deleted senders are held low; people the user writes to are kept
 * at least at the Focused level (40) unless the mail is bulk or suspicious. pref/contact: explicit wishes win.
 */
export function applyHistory(d, st, m, { pref, favorite } = {}) {
  if (pref?.importance || favorite) return d;
  if (mostlyDeleted(st)) {
    d.priority = Math.min(Number(d.priority) || 0, 15);
    d.needs_reply = false;
    d.suggested_replies = [];
    d.priority_reason = d.priority_reason || 'You usually delete mail from this sender';
  } else if (st.sentTo > 0 && !m.list_unsubscribe && !d.is_phishing) d.priority = Math.max(Number(d.priority) || 0, 40);
  return d;
}
