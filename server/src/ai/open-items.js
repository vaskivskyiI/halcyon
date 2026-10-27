// What counts as an open item ("needs reply", "action needed"), in one place for every list, count, search and the
// brief. The AI is sometimes wrong, so its guesses only count while they are recent and the mail matters (priority,
// not a newsletter / notification); what the user marked themselves always counts, for longer. Handled items
// (replied, done, not doing it, AI was wrong) and expired ones never do.
import { all, get, run, now, json } from '../db/index.js';
import { getSettings } from '../settings.js';
import { setFlags } from '../mail/actions.js';
import { notify } from '../util/events.js';
import { userAccounts } from '../accounts.js';

/** Categories of mail that is rarely personal (newsletters, ads, social networks, automated notices). */
export const NOISE_LIST = ['newsletter', 'promotion', 'social', 'notification'];
export const NOISE = `(${NOISE_LIST.map((c) => `'${c}'`).join(', ')})`;

export function openSettings(userId) {
  const s = getSettings(userId).ai;
  return { days: Math.max(1, Number(s.openItemsDays) || 14), min: Math.max(0, Math.min(100, Number(s.openMinPriority ?? 40))) };
}

/**
 * SQL: a newer Inbox email from the same sender with the same subject was flagged the same way (the reminder sent again,
 * the request repeated, the same email received twice): only the newest one counts as open. what: 'reply' | 'action'.
 */
export function supersededSql(what, m = 'm') {
  const flag = what === 'reply' ? '(ni.needs_reply = 1 OR ni.needs_reply_user = 1)' : 'ni.needs_action = 1';
  return `EXISTS (SELECT 1 FROM messages n JOIN ai_insights ni ON ni.message_id = n.id WHERE n.user_id = ${m}.user_id AND n.subject_key = ${m}.subject_key
    AND COALESCE(${m}.subject_key, '') != '' AND n.from_addr = ${m}.from_addr AND n.id != ${m}.id AND (n.date > ${m}.date OR (n.date = ${m}.date AND n.id > ${m}.id))
    AND ${flag} AND n.folder_id IN (SELECT id FROM folders WHERE special_use = '\\Inbox'))`;
}

/** SQL condition (aliases i = ai_insights, m = messages): a reply is still expected from the user. */
export function openReplySql(userId, i = 'i', m = 'm') {
  const { days, min } = openSettings(userId);
  const t = now();
  return `(${i}.dismissed_at IS NULL AND ${m}.is_answered = 0 AND (${i}.expires_at IS NULL OR ${i}.expires_at > ${t})
    AND ((${i}.needs_reply_user = 1 AND ${m}.date >= ${t - 2 * days * 864e5})
      OR (${i}.needs_reply = 1 AND ${i}.needs_reply_user IS NULL AND ${i}.priority >= ${min} AND COALESCE(${i}.category, '') NOT IN ${NOISE} AND ${m}.date >= ${t - days * 864e5}
        AND NOT ${supersededSql('reply', m)})))`;
}

/** SQL condition: something other than a reply is still to be done. */
export function openActionSql(userId, i = 'i', m = 'm') {
  const { days, min } = openSettings(userId);
  const t = now();
  return `(${i}.dismissed_at IS NULL AND ${i}.needs_action = 1 AND (${i}.expires_at IS NULL OR ${i}.expires_at > ${t})
    AND ${i}.priority >= ${actionMin(min)} AND COALESCE(${i}.category, '') NOT IN ${NOISE} AND ${m}.date >= ${t - days * 864e5}
    AND NOT ${supersededSql('action', m)})`;
}

// Actions (pay, sign, register…) matter even when the AI rated the mail low; newsletters & co. are excluded by
// category anyway. So they need only part of the minimum priority that replies need.
const actionMin = (min) => Math.floor(min * 0.6);

/** The user's own addresses (accounts and their aliases), lower-case. */
export const ownAddresses = (userId) => new Set(userAccounts(userId).flatMap((a) => [a.email, ...json(a.aliases_json, []).map((x) => x?.address || x)]).filter(Boolean).map((x) => String(x).toLowerCase()));

/**
 * The user wrote in a conversation (sent from here, from the phone, from webmail or from another account): earlier
 * messages from others in it no longer wait for a reply. The message replied to directly is flagged answered (also
 * on the server, unless `local`).
 */
export function markReplied(userId, msgId, { local = false } = {}) {
  const s = get('SELECT id, thread_id, date, from_addr, in_reply_to FROM messages WHERE id = ? AND user_id = ?', msgId, userId);
  if (!s?.thread_id) return 0;
  const mine = ownAddresses(userId);
  if (!mine.has(String(s.from_addr || '').toLowerCase())) return 0;
  const earlier = all('SELECT m.id, m.from_addr, m.message_id, m.is_answered FROM messages m WHERE m.user_id = ? AND m.thread_id = ? AND m.date < ? AND m.id != ?', userId, s.thread_id, s.date, s.id)
    .filter((m) => !mine.has(String(m.from_addr || '').toLowerCase()));
  let n = 0;
  for (const m of earlier) {
    n += run(`UPDATE ai_insights SET dismissed_at = ?, resolution = 'replied', resolved_by = ? WHERE message_id = ? AND dismissed_at IS NULL AND (needs_reply = 1 OR needs_reply_user = 1)`, s.date, s.id, m.id).changes;
  }
  const direct = s.in_reply_to && earlier.find((m) => m.message_id === s.in_reply_to && !m.is_answered);
  if (direct) {
    if (local) run('UPDATE messages SET is_answered = 1 WHERE id = ?', direct.id);
    else setFlags(userId, [direct.id], { answered: true });
  }
  if (n || direct) notify(userId, 'mail:changed', { ids: earlier.map((m) => m.id) });
  return n;
}

/** One-time pass over mail already stored: replies of the last two months clear what they answered. */
export function markRepliedHistory() {
  if (get("SELECT value FROM app_state WHERE key = 'replied:v1'")) return;
  for (const u of all('SELECT id FROM users')) {
    const mine = [...ownAddresses(u.id)];
    if (!mine.length) continue;
    const rows = all(`SELECT id FROM messages WHERE user_id = ? AND date > ? AND lower(from_addr) IN (${mine.map(() => '?').join(',')}) ORDER BY date`, u.id, now() - 60 * 864e5, ...mine);
    for (const r of rows) markReplied(u.id, r.id, { local: true });
  }
  run("INSERT OR REPLACE INTO app_state (key, value) VALUES ('replied:v1', ?)", String(now()));
}

/** The same rules for one list row (columns as in routes/mail.js LIST_COLS): { reply, action } still open. */
export function openChecker(userId) {
  const { days, min } = openSettings(userId);
  const t = now();
  return (r) => {
    const live = !r.ai_dismissed && (!r.ai_expires_at || r.ai_expires_at > t);
    const relevant = (r.ai_priority ?? 0) >= min && !NOISE_LIST.includes(r.ai_category || '');
    const reply = live && !r.is_answered && ((r.ai_needs_reply_user === 1 && r.date >= t - 2 * days * 864e5)
      || (!!r.ai_needs_reply && r.ai_needs_reply_user == null && relevant && r.date >= t - days * 864e5 && !r.ai_superseded_reply));
    const action = live && !!r.ai_needs_action && !r.ai_superseded_action && (r.ai_priority ?? 0) >= actionMin(min) && !NOISE_LIST.includes(r.ai_category || '') && r.date >= t - days * 864e5;
    return { reply, action };
  };
}

/**
 * Open requests the user's email may answer or complete although it is not a reply in the same conversation: from its
 * recipients, or in its conversation — for the AI to judge when it analyses the sent mail (resolveByAi).
 */
export function openRequestsFor(userId, sent, limit = 8) {
  const rcpt = [...json(sent.to_json, []), ...json(sent.cc_json, [])].map((a) => String(a.address || '').toLowerCase()).filter(Boolean);
  if (!rcpt.length && !sent.thread_id) return [];
  return all(`SELECT m.id, m.from_name, m.from_addr, m.subject, m.date, i.summary, i.action_summary,
      CASE WHEN ${openReplySql(userId)} THEN 1 ELSE 0 END AS reply, CASE WHEN ${openActionSql(userId)} THEN 1 ELSE 0 END AS action
    FROM messages m JOIN ai_insights i ON i.message_id = m.id JOIN folders f ON f.id = m.folder_id
    WHERE m.user_id = ? AND f.special_use = '\\Inbox' AND m.date < ? AND m.date > ? AND m.id != ?
      AND (${rcpt.length ? `lower(m.from_addr) IN (${rcpt.map(() => '?').join(',')}) OR ` : ''}m.thread_id = ?)
      AND (${openReplySql(userId)} OR ${openActionSql(userId)})
    ORDER BY m.date DESC LIMIT ?`, userId, sent.date, sent.date - 30 * 864e5, sent.id, ...rcpt, sent.thread_id || '', limit);
}

/** The AI said the user's email answers / completes these requests (ids from openRequestsFor): close them, undoably. */
export function resolveByAi(userId, sent, ids, candidates) {
  let n = 0;
  for (const c of candidates.filter((x) => ids.map(Number).includes(x.id))) {
    n += run(`UPDATE ai_insights SET dismissed_at = ?, resolution = ?, resolved_by = ? WHERE message_id = ? AND dismissed_at IS NULL`,
      sent.date, c.reply ? 'replied' : 'done', sent.id, c.id).changes;
  }
  if (n) notify(userId, 'mail:changed', { ids: candidates.map((c) => c.id) });
  return n;
}
