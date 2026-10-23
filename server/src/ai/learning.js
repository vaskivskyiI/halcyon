// Learning from the user's corrections: "important", "not important", spam / not spam and category changes.
// Corrections are stored per message (table ai_feedback) and applied two ways to new mail:
//  - deterministic sender preferences (exact address; whole domain once two corrections agree, never for
//    public mail providers), which clamp priority / fix the category / file spam;
//  - examples in the analysis prompt, so the model generalises to similar mail from other senders.
// A correction with the user's reason ("only the fake conferences — they …") is a rule for the AI instead: no blanket
// sender preference is made from it (the next, genuine mail from that sender must not be caught), and the reason is
// given to the model for similar mail, from any sender (reasonedRules).
import { get, all, run, now } from '../db/index.js';

const PUBLIC_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com', 'gmx.net', 'gmx.de', 'web.de', 'proton.me', 'protonmail.com', 'siol.net', 't-2.net', 'amis.net', 'aol.com', 'mail.com']);
const KINDS = new Set(['important', 'unimportant', 'spam', 'notspam', 'category', 'reply', 'noreply', 'action', 'noaction']);
const DIMS = { category: ['category'], spam: ['spam', 'notspam'], notspam: ['spam', 'notspam'], reply: ['reply', 'noreply'], noreply: ['reply', 'noreply'], action: ['action', 'noaction'], noaction: ['action', 'noaction'] };
const domainOf = (addr) => String(addr || '').toLowerCase().split('@')[1] || '';

export function recordFeedback(userId, m, kind, value = null, reason = null) {
  if (!KINDS.has(kind) || !m) return;
  const from = String(m.from_addr || '').toLowerCase();
  // Only the latest opinion per message and dimension counts.
  const dim = DIMS[kind] || ['important', 'unimportant'];
  run(`DELETE FROM ai_feedback WHERE user_id = ? AND message_id = ? AND kind IN (${dim.map(() => '?').join(',')})`, userId, m.id, ...dim);
  const r = run('INSERT INTO ai_feedback (user_id, message_id, from_addr, domain, subject, kind, value, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    userId, m.id, from, domainOf(from), String(m.subject || '').slice(0, 200), kind, value, String(reason || '').trim().slice(0, 500) || null, now());
  return Number(r.lastInsertRowid);
}

// Corrections with a reason are rules for the AI, not sender preferences (see above): left out here.
const PLAIN = "COALESCE(reason, '') = ''";
function latest(userId, col, val, kinds) {
  const r = get(`SELECT kind, value, reason FROM ai_feedback WHERE user_id = ? AND ${col} = ? AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY created_at DESC, id DESC LIMIT 1`, userId, val, ...kinds);
  return r && !r.reason ? r : null;
}

// Domain preference: the two most recent corrections from the domain agree (and the domain is not a public provider).
function domainPref(userId, domain, kinds) {
  if (!domain || PUBLIC_DOMAINS.has(domain)) return null;
  const rows = all(`SELECT kind, value FROM ai_feedback WHERE user_id = ? AND domain = ? AND ${PLAIN} AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY created_at DESC, id DESC LIMIT 2`, userId, domain, ...kinds);
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

const label = (r) => ({ important: 'marked IMPORTANT', unimportant: 'marked NOT important', spam: 'marked SPAM', category: `category set to "${r.value}"`,
  reply: 'the user said it NEEDS a reply', noreply: 'the user said it needs NO reply', action: 'the user said it needs an action', noaction: 'the user said it is NOT an action for them' }[r.kind]);

const STOP = new Set('the and for with that this from your you are was were have has not but all any can will our their they them about into only also than then there what when which who why how more most some such very just like dear best regards thanks thank please email mail message'.split(' '));
const words = (s) => new Set((String(s || '').toLowerCase().match(/\p{L}{4,}/gu) || []).filter((w) => !STOP.has(w)));

/**
 * The user's rules from their comments that fit this email best (same sender / domain, shared words with the
 * corrected email and the reason, recency) — given to the model whatever the sender.
 */
export function reasonedRules(userId, m, limit = 6) {
  const from = String(m.from_addr || '').toLowerCase(), domain = domainOf(from);
  const text = words(`${m.subject || ''} ${String(m.body_text || '').slice(0, 1500)}`);
  const rows = all("SELECT id, from_addr, domain, subject, kind, value, reason, created_at FROM ai_feedback WHERE user_id = ? AND COALESCE(reason, '') != '' ORDER BY created_at DESC LIMIT 300", userId);
  return rows.map((r) => {
    const w = words(`${r.subject} ${r.reason}`);
    let shared = 0;
    for (const x of w) if (text.has(x)) shared++;
    return { r, score: (r.from_addr === from ? 6 : 0) + (domain && r.domain === domain ? 3 : 0) + Math.min(shared, 6) + (now() - r.created_at < 90 * 864e5 ? 0.5 : 0) };
  }).sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.r);
}

/**
 * Prompt text: the user's rules from their comments (follow them) and up to 8 plain past corrections (same
 * sender/domain first, then the most recent ones).
 */
export function preferenceExamples(userId, m) {
  if (typeof m === 'string') m = { from_addr: m };
  const from = String(m.from_addr || '').toLowerCase();
  const rules = reasonedRules(userId, m).map((r) => `- ${label(r)} — "${r.subject}" from ${r.from_addr}. The user's reason: "${r.reason}"`);
  const rows = all(`SELECT from_addr, subject, kind, value FROM ai_feedback WHERE user_id = ? AND kind != 'notspam' AND ${PLAIN}
    ORDER BY (from_addr = ?) DESC, (domain = ?) DESC, created_at DESC LIMIT 8`, userId, from, domainOf(from));
  const plain = rows.map((r) => `- Email from ${r.from_addr} with subject "${r.subject}": ${label(r)}`);
  return [
    rules.length ? `RULES THE USER EXPLAINED (apply each to any email it fits, whoever sent it; they win over your own judgement, and do not apply them where they do not fit):\n${rules.join('\n')}` : '',
    plain.length ? `Corrections without a reason:\n${plain.join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

/** Recent inbox mail the reason / corrected email could be about: analysed again, so the change shows at once. */
export function similarRecent(userId, fb, limit = 30) {
  const key = words(`${fb.subject} ${fb.reason}`);
  if (!key.size) return [];
  const rows = all(`SELECT m.id, m.subject, m.from_addr, substr(m.body_text, 1, 1500) AS body FROM messages m JOIN folders f ON f.id = m.folder_id
    WHERE m.user_id = ? AND f.special_use = '\\Inbox' AND m.date > ? AND m.id != ? ORDER BY m.date DESC LIMIT 400`, userId, now() - 14 * 864e5, fb.message_id || 0);
  return rows.filter((r) => {
    if (domainOf(r.from_addr) === fb.domain && fb.domain && !PUBLIC_DOMAINS.has(fb.domain)) return true;
    const w = words(`${r.subject} ${r.body}`);
    let n = 0;
    for (const x of key) if (w.has(x)) n++;
    return n >= Math.min(3, key.size);
  }).slice(0, limit).map((r) => r.id);
}

export function listRules(userId) {
  return all("SELECT id, message_id AS messageId, from_addr AS fromAddr, subject, kind, value, reason, created_at AS createdAt FROM ai_feedback WHERE user_id = ? AND COALESCE(reason, '') != '' ORDER BY created_at DESC LIMIT 200", userId);
}
export function updateRule(userId, id, reason) {
  const t = String(reason || '').trim().slice(0, 500);
  if (t) run('UPDATE ai_feedback SET reason = ? WHERE id = ? AND user_id = ?', t, id, userId);
  else run('DELETE FROM ai_feedback WHERE id = ? AND user_id = ?', id, userId);
}

/** Immediate effect of a correction on the message's own insight. */
export function correctInsight(messageId, kind, value) {
  if (kind === 'important') run('UPDATE ai_insights SET priority = MAX(priority, 85) WHERE message_id = ?', messageId);
  if (kind === 'unimportant') run('UPDATE ai_insights SET priority = MIN(priority, 15), needs_reply = 0 WHERE message_id = ?', messageId);
  if (kind === 'category') run('UPDATE ai_insights SET category = ? WHERE message_id = ?', value, messageId);
}

export function listPreferences(userId) {
  return all(`SELECT f.from_addr AS fromAddr, f.kind, f.value, f.subject, f.created_at AS createdAt FROM ai_feedback f
    WHERE f.user_id = ? AND f.id IN (SELECT MAX(id) FROM ai_feedback WHERE user_id = ? AND ${PLAIN} GROUP BY from_addr, CASE WHEN kind IN ('spam','notspam') THEN 's' WHEN kind = 'category' THEN 'c' ELSE 'i' END)
    ORDER BY f.created_at DESC LIMIT 300`, userId, userId);
}

export function forgetSender(userId, fromAddr) {
  run('DELETE FROM ai_feedback WHERE user_id = ? AND from_addr = ?', userId, String(fromAddr || '').toLowerCase());
}
