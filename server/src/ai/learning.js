// Learning from the user's corrections: "important", "not important", spam / not spam and category changes.
// Corrections are stored per message (table ai_feedback) and applied two ways to new mail:
//  - deterministic sender preferences (exact address; whole domain once two corrections agree, never for
//    public mail providers), which clamp priority / fix the category / file spam;
//  - examples in the analysis prompt, so the model generalises to similar mail from other senders.
import { get, all, run, now } from '../db/index.js';

const PUBLIC_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com', 'gmx.net', 'gmx.de', 'web.de', 'proton.me', 'protonmail.com', 'siol.net', 't-2.net', 'amis.net', 'aol.com', 'mail.com']);
const KINDS = new Set(['important', 'unimportant', 'spam', 'notspam', 'category', 'reply', 'noreply', 'action', 'noaction']);
const DIMS = { category: ['category'], spam: ['spam', 'notspam'], notspam: ['spam', 'notspam'], reply: ['reply', 'noreply'], noreply: ['reply', 'noreply'], action: ['action', 'noaction'], noaction: ['action', 'noaction'] };
const domainOf = (addr) => String(addr || '').toLowerCase().split('@')[1] || '';

export function recordFeedback(userId, m, kind, value = null) {
  if (!KINDS.has(kind) || !m) return;
  const from = String(m.from_addr || '').toLowerCase();
  // Only the latest opinion per message and dimension counts.
  const dim = DIMS[kind] || ['important', 'unimportant'];
  run(`DELETE FROM ai_feedback WHERE user_id = ? AND message_id = ? AND kind IN (${dim.map(() => '?').join(',')})`, userId, m.id, ...dim);
  run('INSERT INTO ai_feedback (user_id, message_id, from_addr, domain, subject, kind, value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    userId, m.id, from, domainOf(from), String(m.subject || '').slice(0, 200), kind, value, now());
}

function latest(userId, col, val, kinds) {
  return get(`SELECT kind, value FROM ai_feedback WHERE user_id = ? AND ${col} = ? AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY created_at DESC, id DESC LIMIT 1`, userId, val, ...kinds);
}

// Domain preference: the two most recent corrections from the domain agree (and the domain is not a public provider).
function domainPref(userId, domain, kinds) {
  if (!domain || PUBLIC_DOMAINS.has(domain)) return null;
  const rows = all(`SELECT kind, value FROM ai_feedback WHERE user_id = ? AND domain = ? AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY created_at DESC, id DESC LIMIT 2`, userId, domain, ...kinds);
  return rows.length === 2 && rows[0].kind === rows[1].kind && rows[0].value === rows[1].value ? rows[0] : null;
}

/** { importance: 'important'|'unimportant'|null, category, spam: bool } learned for a sender. */
export function senderPreference(userId, fromAddr) {
  const from = String(fromAddr || '').toLowerCase(), domain = domainOf(from);
  const imp = latest(userId, 'from_addr', from, ['important', 'unimportant']) || domainPref(userId, domain, ['important', 'unimportant']);
  const cat = latest(userId, 'from_addr', from, ['category']) || domainPref(userId, domain, ['category']);
  const spam = latest(userId, 'from_addr', from, ['spam', 'notspam']);
  return { importance: imp?.kind || null, category: cat?.value || null, spam: spam?.kind === 'spam', reply: agreed(userId, from, ['reply', 'noreply']), action: agreed(userId, from, ['action', 'noaction']) };
}

// "Needs no reply" / "not an action" from a sender: only once the user said so twice in a row (one correction may be
// about that one email; a colleague's next question still deserves a reply).
function agreed(userId, from, kinds) {
  const rows = all(`SELECT kind FROM ai_feedback WHERE user_id = ? AND from_addr = ? AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY created_at DESC, id DESC LIMIT 2`, userId, from, ...kinds);
  return rows.length === 2 && rows[0].kind === rows[1].kind ? rows[0].kind : null;
}

/** Applies learned sender preferences to fresh analysis output (mutates and returns d). */
export function applyPreference(d, pref) {
  if (pref.importance === 'important') d.priority = Math.max(Number(d.priority) || 0, 75);
  if (pref.importance === 'unimportant') { d.priority = Math.min(Number(d.priority) || 0, 20); }
  if (pref.category) d.category = pref.category;
  if (pref.reply === 'noreply') d.needs_reply = false;
  if (pref.action === 'noaction') { d.needs_action = false; d.action_summary = ''; }
  return d;
}

/** Up to 8 past corrections as prompt lines: same sender/domain first, then the most recent ones. */
export function preferenceExamples(userId, fromAddr) {
  const from = String(fromAddr || '').toLowerCase();
  const rows = all(`SELECT from_addr, subject, kind, value FROM ai_feedback WHERE user_id = ? AND kind != 'notspam'
    ORDER BY (from_addr = ?) DESC, (domain = ?) DESC, created_at DESC LIMIT 8`, userId, from, domainOf(from));
  const label = (r) => ({ important: 'marked IMPORTANT', unimportant: 'marked NOT important', spam: 'marked SPAM', category: `category set to "${r.value}"`,
    reply: 'the user said it NEEDS a reply', noreply: 'the user said it needs NO reply', action: 'the user said it needs an action', noaction: 'the user said it is NOT an action for them' }[r.kind]);
  return rows.map((r) => `- Email from ${r.from_addr} with subject "${r.subject}": ${label(r)}`).join('\n');
}

/** Immediate effect of a correction on the message's own insight. */
export function correctInsight(messageId, kind, value) {
  if (kind === 'important') run('UPDATE ai_insights SET priority = MAX(priority, 85) WHERE message_id = ?', messageId);
  if (kind === 'unimportant') run('UPDATE ai_insights SET priority = MIN(priority, 15), needs_reply = 0 WHERE message_id = ?', messageId);
  if (kind === 'category') run('UPDATE ai_insights SET category = ? WHERE message_id = ?', value, messageId);
}

export function listPreferences(userId) {
  return all(`SELECT f.from_addr AS fromAddr, f.kind, f.value, f.subject, f.created_at AS createdAt FROM ai_feedback f
    WHERE f.user_id = ? AND f.id IN (SELECT MAX(id) FROM ai_feedback WHERE user_id = ? GROUP BY from_addr, CASE WHEN kind IN ('spam','notspam') THEN 's' WHEN kind = 'category' THEN 'c' ELSE 'i' END)
    ORDER BY f.created_at DESC LIMIT 300`, userId, userId);
}

export function forgetSender(userId, fromAddr) {
  run('DELETE FROM ai_feedback WHERE user_id = ? AND from_addr = ?', userId, String(fromAddr || '').toLowerCase());
}
