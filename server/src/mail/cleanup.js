// Tidy-up suggestions: senders whose mail the user keeps deleting, reporting as spam or leaving unread (≥ 4 emails in 90
// days, never answered, never written to), each with what can be done — unsubscribe (when their mail says how), always to
// Other, or keep as it is (remembered: sender_habits.keep, which also stops the "rarely read" habit). Listed in
// Mail → More → Senders, and told once a week when there are any.
import { all, get, run, now } from '../db/index.js';
import { ownAddresses } from '../ai/open-items.js';
import { unsubscribePlan } from './lists.js';
import { notifyUser } from '../notifications.js';

const DAY = 864e5;

export function cleanupSuggestions(userId, { limit = 20 } = {}) {
  const t = now();
  const rows = all(`SELECT lower(m.from_addr) AS address, MAX(m.from_name) AS name, COUNT(*) AS total, SUM(m.is_read) AS seen, SUM(m.is_answered) AS answered,
      SUM(f.special_use = '\\Trash') AS trash, SUM(f.special_use = '\\Trash' AND m.is_read = 0) AS trashUnread, SUM(f.special_use = '\\Junk') AS junk,
      SUM(f.special_use = '\\Inbox') AS inbox, MAX(m.date) AS last,
      MAX(CASE WHEN m.list_unsubscribe IS NOT NULL AND COALESCE(li.list_post, 0) = 0 THEN m.id END) AS unsubscribeId
    FROM messages m JOIN folders f ON f.id = m.folder_id LEFT JOIN list_info li ON li.message_id = m.id
    WHERE m.user_id = ? AND m.date > ? AND m.from_addr IS NOT NULL AND COALESCE(f.special_use, '') NOT IN ('\\Sent', '\\Drafts')
    GROUP BY lower(m.from_addr) HAVING COUNT(*) >= 4 AND SUM(m.is_answered) = 0 ORDER BY COUNT(*) DESC LIMIT 400`, userId, t - 90 * DAY);
  const own = ownAddresses(userId);
  const skip = new Set([
    ...all('SELECT address FROM sender_habits WHERE user_id = ? AND keep = 1', userId).map((r) => r.address),
    ...all('SELECT address FROM focus_senders WHERE user_id = ? AND focused != 0', userId).map((r) => r.address),
    ...all('SELECT address FROM unsubscribed WHERE user_id = ?', userId).map((r) => r.address),
    ...all('SELECT email AS address FROM contact_emails WHERE user_id = ?', userId).map((r) => r.address),
  ]);
  const stats = new Map(all('SELECT address, deleted, deleted_unread, spam FROM sender_stats WHERE user_id = ?', userId).map((r) => [r.address, r]));
  const wrote = (a) => !!get(`SELECT 1 AS x FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.user_id = ? AND f.special_use = '\\Sent'
    AND (lower(m.to_json) LIKE ? OR lower(m.cc_json) LIKE ?) LIMIT 1`, userId, `%"${a}"%`, `%"${a}"%`);
  const msg = (id) => get('SELECT id, account_id, from_addr, list_unsubscribe FROM messages WHERE id = ?', id);
  const out = [];
  for (const r of rows) {
    if (out.length >= limit) break;
    if (own.has(r.address) || skip.has(r.address) || skip.has(`@${r.address.split('@')[1]}`)) continue;
    const s = stats.get(r.address) || {};
    // Deletions also count from sender_stats (mail gone from Trash), but only those of this period's size at most.
    const deleted = Math.min(r.total, Math.max(r.trash || 0, s.deleted || 0)), unread = Math.min(r.total, Math.max(r.trashUnread || 0, s.deleted_unread || 0));
    const spam = Math.max(r.junk || 0, Math.min(r.total, s.spam || 0));
    let reason = null;
    if (deleted + spam >= 0.7 * r.total) reason = `You deleted ${deleted}${spam ? ` and reported ${spam} as spam` : ''} of their last ${r.total} emails${unread ? ` (${unread} without reading)` : ''}.`;
    else if ((r.seen || 0) * 10 <= r.total && r.total >= 5) reason = `You opened ${r.seen || 0} of their last ${r.total} emails.`;
    if (!reason || wrote(r.address)) continue;
    out.push({ address: r.address, name: r.name, total: r.total, inbox: r.inbox || 0, last: r.last, reason, plan: r.unsubscribeId ? unsubscribePlan(msg(r.unsubscribeId)) : null, unsubscribeId: r.unsubscribeId });
  }
  return out;
}

/** Once a week per user: a notification when there is something to tidy up. */
export function weeklyCleanupNotice() {
  for (const u of all('SELECT id FROM users')) {
    const key = `cleanup_told:${u.id}`;
    const at = Number(get('SELECT value FROM app_state WHERE key = ?', key)?.value || 0);
    if (now() - at < 7 * DAY) continue;
    run('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)', key, String(now()));
    if (!at) continue; // not on the first start: a week of use first
    const list = cleanupSuggestions(u.id, { limit: 50 });
    if (!list.length) continue;
    notifyUser(u.id, 'cleanup', { title: 'Tidy up your inbox', tag: 'cleanup', url: '#/mail/senders',
      body: `${list.length} sender${list.length === 1 ? '' : 's'} you always delete or never read: ${list.slice(0, 3).map((x) => x.name || x.address).join(', ')}${list.length > 3 ? '…' : ''}` });
  }
}
