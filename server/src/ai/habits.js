// Learning from what the user does, not only from corrections: a sender whose mail the user keeps leaving unread
// (or deletes / archives unopened) is treated as not important — held low, out of Important / Focused, no
// notification, no reply suggestions. Looks at the sender's last 10 emails of 90 days (a day old at least, so mail
// not yet seen does not count): 5 or more, at most 1 in 10 opened, none answered. It switches off by itself once the
// user opens their mail again. Never for people in the contacts (saved or written to), never against the user's own
// "important" correction, and the user can stop it per sender (sender_habits.keep, Mail → More → Senders).
import { all, run, now } from '../db/index.js';
import { ownAddresses } from './open-items.js';

const TTL = 10 * 60e3;
const cache = new Map();

/** Map address → { total, seen } of the senders the user rarely reads (cached for a few minutes). */
export function rareSenders(userId) {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL) return hit.map;
  const t = Date.now();
  const rows = all(`SELECT address, COUNT(*) AS total, SUM(is_read) AS seen, SUM(is_answered) AS answered FROM (
      SELECT lower(m.from_addr) AS address, m.is_read, m.is_answered, ROW_NUMBER() OVER (PARTITION BY lower(m.from_addr) ORDER BY m.date DESC) AS rn
      FROM messages m JOIN folders f ON f.id = m.folder_id
      WHERE m.user_id = ? AND m.date BETWEEN ? AND ? AND m.from_addr IS NOT NULL
        AND COALESCE(f.special_use, '') NOT IN ('\\Sent', '\\Drafts', '\\Junk'))
    WHERE rn <= 10 GROUP BY address HAVING COUNT(*) >= 5 AND SUM(is_read) * 10 <= COUNT(*) AND SUM(is_answered) = 0`,
  userId, t - 90 * 864e5, t - 864e5);
  const own = ownAddresses(userId);
  const kept = new Set(all('SELECT address FROM sender_habits WHERE user_id = ? AND keep = 1', userId).map((r) => r.address));
  const known = new Set(all('SELECT email FROM contact_emails WHERE user_id = ?', userId).map((r) => r.email));
  const map = new Map(rows.filter((r) => !own.has(r.address) && !kept.has(r.address) && !known.has(r.address)).map((r) => [r.address, { total: r.total, seen: r.seen || 0 }]));
  cache.set(userId, { at: Date.now(), map });
  return map;
}

export const rarelyRead = (userId, addr) => rareSenders(userId).has(String(addr || '').toLowerCase());
export const forgetHabits = (userId) => cache.delete(userId);

/** keep = true: treat the sender normally whatever the habit; false: let it learn again. */
export function keepSender(userId, address, keep) {
  const a = String(address || '').toLowerCase();
  if (keep) run('INSERT OR REPLACE INTO sender_habits (user_id, address, keep, created_at) VALUES (?, ?, 1, ?)', userId, a, now());
  else run('DELETE FROM sender_habits WHERE user_id = ? AND address = ?', userId, a);
  forgetHabits(userId);
}

export const keptSenders = (userId) => new Set(all('SELECT address FROM sender_habits WHERE user_id = ? AND keep = 1', userId).map((r) => r.address));

/** Applies the habit to fresh analysis output (mutates d); pref is the sender's explicit preference. */
export function applyHabit(userId, d, m, pref, contact) {
  if (pref?.importance || contact || !rarelyRead(userId, m.from_addr)) return d;
  d.priority = Math.min(Number(d.priority) || 0, 20);
  d.needs_reply = false;
  d.suggested_replies = [];
  return d;
}
