// Senders whose mail always goes to Focused (Settings → Mail). Halcyon fills the list itself from the people the user
// writes to (two or more emails sent to them in a year); the user adds senders or whole domains (@example.org) and
// takes out what does not belong — taken out stays out, so it is not added again.
import { get, all, run, json, now } from './db/index.js';
import { ownAddresses } from './ai/open-items.js';

const MACHINE = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|bounces?)[@+.-]/i;
const WRITTEN = 2, YEAR = 365 * 864e5;

export const normalizeSender = (a) => {
  a = String(a || '').trim().toLowerCase();
  return /^[^\s@]*@[^\s@]+\.[^\s@]+$/.test(a) ? a : null;
};

/** People the user wrote to at least twice in a year come in by themselves (once each; what was taken out stays out). */
export function learnFocusSenders(userId) {
  const own = ownAddresses(userId);
  const count = new Map();
  for (const m of all(`SELECT m.to_json, m.cc_json FROM messages m JOIN folders f ON f.id = m.folder_id
    WHERE m.user_id = ? AND f.special_use = '\\Sent' AND m.date > ?`, userId, now() - YEAR)) {
    const to = new Set([...json(m.to_json, []), ...json(m.cc_json, [])].map((x) => String(x?.address || '').toLowerCase()));
    for (const a of to) if (a.includes('@') && !own.has(a) && !MACHINE.test(a)) count.set(a, (count.get(a) || 0) + 1);
  }
  let added = 0;
  for (const [a, n] of count) if (n >= WRITTEN) added += run('INSERT OR IGNORE INTO focus_senders (user_id, address, auto, focused, created_at) VALUES (?, ?, 1, 1, ?)', userId, a, now()).changes;
  run("INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)", `focus_learned:${userId}`, String(now()));
  return added;
}

/** Learned again once a day at most (asked by the scheduler and by the settings page). */
export function learnFocusSendersSoon(userId) {
  const at = Number(get('SELECT value FROM app_state WHERE key = ?', `focus_learned:${userId}`)?.value || 0);
  if (now() - at > 864e5) learnFocusSenders(userId);
}

export function focusSenders(userId) {
  learnFocusSendersSoon(userId);
  return all(`SELECT s.address, s.auto, s.focused, s.created_at AS createdAt,
      (SELECT MAX(m.from_name) FROM messages m WHERE m.user_id = s.user_id AND lower(m.from_addr) = s.address) AS name
    FROM focus_senders s WHERE s.user_id = ? ORDER BY s.focused DESC, s.address`, userId)
    .map((r) => ({ ...r, auto: !!r.auto, focused: !!r.focused }));
}

/** on = true: always Focused (added by the user); false: taken out (an entry learned again is not brought back). */
export function setFocusSender(userId, address, on) {
  const a = normalizeSender(address);
  if (!a) throw new Error('An email address or a domain (@example.org) is needed');
  run(`INSERT INTO focus_senders (user_id, address, auto, focused, created_at) VALUES (?, ?, 0, ?, ?)
    ON CONFLICT(user_id, address) DO UPDATE SET focused = excluded.focused`, userId, a, on ? 1 : 0, now());
  return a;
}

/** Removed from the list entirely (a learned one may come back on the next learning). */
export const forgetFocusSender = (userId, address) => run('DELETE FROM focus_senders WHERE user_id = ? AND address = ?', userId, String(address || '').toLowerCase()).changes;
