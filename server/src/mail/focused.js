// Focused / Other (the inbox split, and the "Mail in Focused" notifications): SQL over messages m LEFT JOIN ai_insights i.
import { all, get, run, now } from '../db/index.js';
import { NOISE as OPEN_NOISE } from '../ai/open-items.js';
import { recordFeedback, agreedFocus } from '../ai/learning.js';

// Mail the AI is about to read waits in Other, visible, and moves when the analysis says so. Mail it will not read stays in Focused.
export const analysing = (m) => `EXISTS (SELECT 1 FROM ai_jobs j WHERE j.user_id = ${m}.user_id AND j.type = 'analyze' AND j.ref_id = CAST(${m}.id AS TEXT) AND j.status IN ('queued', 'running'))`;
export const ANALYSING = analysing('m');
// Phishing never counts as focused (also not to pull its conversation in).
export const focusedOne = (i, m) => `(COALESCE(${i}.is_phishing, 0) = 0 AND ((${i}.message_id IS NULL AND NOT ${analysing(m)}) OR (${i}.priority >= 40 AND COALESCE(${i}.category, '') NOT IN ${OPEN_NOISE}) OR ${i}.priority >= 70))`;
// Focused goes by conversation: a message is focused when it or another message of its conversation in an Inbox is, so a
// conversation is never split between Focused and Other (a reply to a focused conversation stays with it).
// Always Focused: conversations the user started or replied to (a message of theirs in Sent, or answered), and senders
// on the user's Focused list (focus.js; an address or a whole @domain).
const senderIs = (v) => `EXISTS (SELECT 1 FROM focus_senders fs WHERE fs.user_id = m.user_id AND fs.focused = ${v}
  AND fs.address IN (lower(m.from_addr), '@' || substr(lower(m.from_addr), instr(m.from_addr, '@') + 1)))`;
export const FOCUS_SENDER = senderIs(1);
// Senders the user sent to Other for good (focused = -1).
export const OTHER_SENDER = senderIs(-1);
// The conversation moved by hand: 1 Focused, 0 Other, NULL not moved. Wins over everything else.
export const threadKey = (m) => `COALESCE(${m}.thread_id, 'id:' || ${m}.id)`;
export const OVERRIDE = `(SELECT fo.focused FROM focus_overrides fo WHERE fo.user_id = m.user_id AND fo.thread_key = ${threadKey('m')})`;
const PHISH = 'COALESCE(i.is_phishing, 0) = 1';
export const MINE = `(m.is_answered = 1 OR (m.thread_id IS NOT NULL AND EXISTS (SELECT 1 FROM messages s WHERE s.user_id = m.user_id AND s.thread_id = m.thread_id
  AND s.folder_id IN (SELECT id FROM folders WHERE special_use = '\\Sent'))))`;
// Built when first used: ai/open-items.js (NOISE) can still be loading when this module is (they import each other).
let focusedSql = null;
// Order: the user's move of the conversation; phishing is Other; the user's own conversations; senders always in Other;
// senders always in Focused; the AI's verdict on this or another message of the conversation.
export const FOCUSED = () => (focusedSql ||= `(COALESCE(${OVERRIDE}, CASE WHEN ${PHISH} THEN 0 WHEN ${MINE} THEN 1 WHEN ${OTHER_SENDER} THEN 0 WHEN (${focusedOne('i', 'm')} OR ${FOCUS_SENDER} OR (m.thread_id IS NOT NULL AND EXISTS (SELECT 1 FROM messages t LEFT JOIN ai_insights ti ON ti.message_id = t.id
  WHERE t.user_id = m.user_id AND t.thread_id = m.thread_id AND t.id != m.id AND t.folder_id IN (SELECT id FROM folders WHERE special_use = '\\Inbox') AND ${focusedOne('ti', 't')}))) THEN 1 ELSE 0 END) = 1)`);

/** Of these new emails, those in Focused now (mail the AI is still to read is not, until it has). */
export const focusedOf = (ids) => (ids.length ? all(`SELECT m.id FROM messages m LEFT JOIN ai_insights i ON i.message_id = m.id
  WHERE m.id IN (${ids.map(() => '?').join(',')}) AND ${FOCUSED()}`, ...ids).map((r) => r.id) : []);

/** In Focused whatever the AI says (sender, the user's own conversation, a focused conversation): told on arrival. */
export const focusedByRule = (id) => !!get(`SELECT 1 AS x FROM messages m WHERE m.id = ? AND COALESCE(${OVERRIDE}, 1) = 1 AND NOT ${OTHER_SENDER} AND (${FOCUS_SENDER} OR ${MINE} OR (m.thread_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM messages t LEFT JOIN ai_insights ti ON ti.message_id = t.id WHERE t.user_id = m.user_id AND t.thread_id = m.thread_id AND t.id != m.id
  AND t.folder_id IN (SELECT id FROM folders WHERE special_use = '\\Inbox') AND ${focusedOne('ti', 't')})))`, id);

/**
 * Moves the conversations of these emails to Focused (on) or Other by hand. With always, every future email of their
 * senders goes there too; without, it is learned once the user moved a sender's mail the same way twice in a row.
 * Returns { moved, senders: [addresses now always there] }.
 */
export function setFocusOverride(userId, ids, on, { always = false } = {}) {
  const msgs = all(`SELECT m.*, ${threadKey('m')} AS tkey FROM messages m WHERE m.user_id = ? AND m.id IN (${ids.map(() => '?').join(',')})`, userId, ...ids);
  const senders = new Set();
  for (const m of msgs) {
    run(`INSERT INTO focus_overrides (user_id, thread_key, focused, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, thread_key) DO UPDATE SET focused = excluded.focused, created_at = excluded.created_at`, userId, m.tkey, on ? 1 : 0, now());
    const from = String(m.from_addr || '').toLowerCase();
    if (!from.includes('@')) continue;
    recordFeedback(userId, m, on ? 'focus' : 'other');
    const learned = !always && agreedFocus(userId, from) === (on ? 'focus' : 'other');
    if (!always && !learned) continue;
    // A sender the user put on the list or took off by hand keeps that choice against what is learned.
    const own = get('SELECT auto, focused FROM focus_senders WHERE user_id = ? AND address = ?', userId, from);
    if (!always && own && !own.auto) continue;
    run(`INSERT INTO focus_senders (user_id, address, auto, focused, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, address) DO UPDATE SET focused = excluded.focused, auto = excluded.auto`, userId, from, always ? 0 : 1, on ? 1 : -1, now());
    senders.add(from);
  }
  return { moved: msgs.length, senders: [...senders] };
}

/**
 * Where an email of the Inbox is and why, in the same order as FOCUSED: { focused, reason }. For the reader's "Why is
 * this in Focused / Other?" line.
 */
export function placementOf(id) {
  const thread = `(m.thread_id IS NOT NULL AND EXISTS (SELECT 1 FROM messages t LEFT JOIN ai_insights ti ON ti.message_id = t.id
    WHERE t.user_id = m.user_id AND t.thread_id = m.thread_id AND t.id != m.id AND t.folder_id IN (SELECT id FROM folders WHERE special_use = '\Inbox') AND ${focusedOne('ti', 't')}))`;
  const r = get(`SELECT ${OVERRIDE} AS ov, ${PHISH} AS phish, ${MINE} AS mine, ${OTHER_SENDER} AS otherSender, ${FOCUS_SENDER} AS focusSender,
      ${focusedOne('i', 'm')} AS ai, ${thread} AS thread, ${ANALYSING} AS analysing, i.message_id AS analysed, i.priority, i.category, i.priority_reason AS why,
      (SELECT fs.auto FROM focus_senders fs WHERE fs.user_id = m.user_id AND fs.address IN (lower(m.from_addr), '@' || substr(lower(m.from_addr), instr(m.from_addr, '@') + 1)) LIMIT 1) AS auto
    FROM messages m LEFT JOIN ai_insights i ON i.message_id = m.id WHERE m.id = ?`, id);
  if (!r) return null;
  const ai = r.priority != null ? ` (priority ${r.priority}${r.why ? `: ${r.why}` : ''})` : '';
  if (r.ov != null) return { focused: !!r.ov, reason: `You moved this conversation to ${r.ov ? 'Focused' : 'Other'}.` };
  if (r.phish) return { focused: false, reason: 'It looks like phishing.' };
  if (r.mine) return { focused: true, reason: 'You wrote in this conversation.' };
  if (r.otherSender) return { focused: false, reason: r.auto ? 'You moved this sender\'s mail to Other twice, so it always goes there.' : 'This sender is set to always go to Other.' };
  if (r.focusSender) return { focused: true, reason: r.auto ? 'You write to this sender (or moved their mail to Focused twice).' : 'This sender is set to always go to Focused.' };
  if (!r.analysed) return { focused: !r.analysing, reason: r.analysing ? 'The AI has not read it yet.' : 'Not analysed by the AI.' };
  if (r.ai) return { focused: true, reason: `The AI rated it as worth your attention${ai}.` };
  if (r.thread) return { focused: true, reason: 'Another email of this conversation is in Focused.' };
  return { focused: false, reason: r.priority >= 40 ? `The AI filed it as ${r.category}${ai}.` : `The AI rated it as low priority${ai}.` };
}
