// AI features. Background handlers precompute insights, thread summaries, embeddings, reply drafts and the
// daily brief; on-demand functions reuse those results when available and stream otherwise.
import { get, all, run, json, now } from '../db/index.js';
import { getSettings, saveSettings } from '../settings.js';
import { chat, chatJSON, embed } from './router.js';
import { registerHandler, enqueue, notifyAI, queueMemory } from './queue.js';
import * as P from './prompts.js';
import { storeMemory, removeMemory, searchMemory, chunkText } from './memory.js';
import { applyRules } from '../rules.js';
import { parseIcs } from '../calendar/ics.js';
import { listRange } from '../calendar/repo.js';
import { userAccounts } from '../accounts.js';
import { contactByEmail } from '../contacts/service.js';
import { scope, inIds } from '../spaces.js';
import { localToEpoch, normalizeEvent } from '../util/time.js';
import { senderPreference, applyPreference, preferenceExamples } from './learning.js';
import { keywordSearch, embedQuery, messageHits } from '../search.js';
import { profileText } from './profiles.js';
import { cleanSummary } from './summary.js';
import { openReplySql, openActionSql, NOISE as OPEN_NOISE, openRequestsFor, resolveByAi, ownAddresses } from './open-items.js';
import { splitPlainQuote } from '../util/quotes.js';

const LANG_NAMES = P.LANG_NAMES;
const skip = (msg) => Object.assign(new Error(msg), { code: 'SKIP' });

function ctxFor(userId) {
  const user = get('SELECT * FROM users WHERE id = ?', userId);
  const settings = getSettings(userId);
  const accounts = userAccounts(userId);
  return { user, settings, accounts, ctx: P.userContext(user, settings, accounts), uiLanguage: LANG_NAMES[settings.ui.language] || 'English' };
}

const replyLanguage = (settings) => (settings.ai.replyLanguage && settings.ai.replyLanguage !== 'auto' ? settings.ai.replyLanguage : 'the same language as the email being replied to');
const clampInt = (n, lo, hi, d) => (Number.isFinite(Number(n)) ? Math.max(lo, Math.min(hi, Math.round(Number(n)))) : d);

export function serializeInsight(r) {
  if (!r) return null;
  return {
    summary: r.summary, category: r.category, priority: r.priority, priorityReason: r.priority_reason, needsReply: !!r.needs_reply,
    actionItems: json(r.action_items_json, []), suggestedReplies: json(r.suggested_replies_json, []), events: json(r.events_json, []),
    sentiment: r.sentiment, language: r.language, isPhishing: !!r.is_phishing, draftReply: r.draft_reply, model: r.model, createdAt: r.created_at,
    expiresAt: r.expires_at || null, expired: !!(r.expires_at && r.expires_at < now()), requests: json(r.requests_json, []),
    needsAction: !!r.needs_action, actionSummary: r.action_summary || null,
    topic: r.topic || null, dismissed: !!r.dismissed_at,
    // How a requested action was settled ('done' | 'skipped') and when.
    resolution: r.dismissed_at ? r.resolution || 'done' : null, resolvedAt: r.dismissed_at || null, resolvedBy: r.resolved_by || null,
  };
}

// One-time codes and sign-in links lose all value within minutes; models do not always notice, so look for them too.
const CODE_RE = /\b(verification|security|login|log-in|sign[- ]?in|one[- ]time|otp|2fa|authentication|potrditven\w*|prijavn\w*|varnostn\w*|enkratn\w*)\b[\s\S]{0,80}\b(code|koda|kodo|kod|passcode|pin)\b|\b(code|koda|kodo|passcode)\b[\s\S]{0,40}\b(verification|login|sign[- ]?in|one[- ]time|prijav\w*)\b/i;

function expiryOf(d, m, tz) {
  const t = d.expires ? localToEpoch(String(d.expires).slice(0, 10), String(d.expires).slice(11, 16), tz) : NaN;
  if (!Number.isNaN(t) && t > m.date) return t;
  const head = `${m.subject}\n${String(m.body_text || '').slice(0, 600)}`;
  return CODE_RE.test(head) && /\b\d{4,8}\b|\b[A-Z0-9]{6,8}\b/.test(head) ? m.date + 30 * 60e3 : null;
}

/** quiet: analysis of old mail that was most likely handled already — no "needs reply", out of brief/priority views. */
function saveInsight(m, d, model, tz, { quiet = false } = {}) {
  const messageId = m.id;
  const text = `${m.subject || ''}\n${m.body_text || ''}`;
  const events = (Array.isArray(d.events) ? d.events : []).map((e) => normalizeEvent(e, tz, { text })).filter(Boolean).slice(0, 5);
  const expires = expiryOf(d, m, tz);
  let priority = clampInt(d.priority, 0, 100, 30), needsReply = d.needs_reply && !quiet ? 1 : 0;
  let needsAction = d.needs_action && !quiet ? 1 : 0;
  if (expires && expires < now()) { priority = Math.min(priority, 10); needsReply = 0; needsAction = 0; } // analysed after it expired
  // What the user decided by hand survives re-analysis.
  const prev = get('SELECT needs_reply_user, dismissed_at, resolution, resolved_by FROM ai_insights WHERE message_id = ?', messageId);
  if (prev?.needs_reply_user != null) needsReply = prev.needs_reply_user;
  const dismissed = prev?.dismissed_at ?? (quiet ? now() : null);
  run(`INSERT OR REPLACE INTO ai_insights (message_id, summary, category, priority, priority_reason, needs_reply, action_items_json,
    suggested_replies_json, events_json, sentiment, language, is_phishing, draft_reply, model, created_at, expires_at, requests_json, topic, dismissed_at, needs_reply_user,
    needs_action, action_summary)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,(SELECT draft_reply FROM ai_insights WHERE message_id = ?),?,?,?,?,?,?,?,?,?)`,
    messageId, cleanSummary(d.summary, { fromName: m.from_name, fromAddr: m.from_addr, subject: m.subject }).slice(0, 1000), P.CATEGORIES.includes(d.category) ? d.category : 'other',
    priority, String(d.priority_reason || '').slice(0, 200), needsReply,
    JSON.stringify((Array.isArray(d.action_items) ? d.action_items : []).slice(0, 10).map((a) => (typeof a === 'string' ? { text: a, due: null } : { text: String(a.text || ''), due: a.due || null })).filter((a) => a.text)),
    JSON.stringify((Array.isArray(d.suggested_replies) ? d.suggested_replies : []).slice(0, 3).map(String)),
    JSON.stringify(events),
    ['positive', 'neutral', 'negative', 'urgent'].includes(d.sentiment) ? d.sentiment : 'neutral',
    String(d.language || '').slice(0, 5), d.is_phishing ? 1 : 0, messageId, model, now(), expires, d.requests ? JSON.stringify(d.requests) : null,
    d.topic || null, dismissed, prev?.needs_reply_user ?? null, needsAction, needsAction ? String(d.action_summary || '').slice(0, 160) || null : null);
  if (prev?.resolution) run('UPDATE ai_insights SET resolution = ?, resolved_by = ? WHERE message_id = ?', prev.resolution, prev.resolved_by, messageId);
  run("UPDATE messages SET ai_status = 'done' WHERE id = ?", messageId);
}

/**
 * The live part of the daily brief, always computed fresh (so done tasks and dismissed or expired items disappear at
 * once and new mail shows up immediately). Scoped to the space.
 */
export function briefLive(userId, space = '') {
  const sc = scope(userId, space);
  const accIn = inIds('m.account_id', sc?.accountIds);
  const live = `i.dismissed_at IS NULL AND (i.expires_at IS NULL OR i.expires_at > ${now()})`;
  const row = (m) => ({ id: m.id, from: m.from_name || m.from_addr, subject: m.subject, summary: m.summary, date: m.date, priority: m.priority, isRead: !!m.is_read, needsReply: !!m.needs_reply, category: m.category, topic: m.topic });
  const attention = all(`SELECT m.id, m.from_name, m.from_addr, m.subject, m.date, m.is_read, i.summary, i.priority, i.needs_reply, i.category, i.topic
    FROM messages m JOIN folders f ON f.id = m.folder_id JOIN ai_insights i ON i.message_id = m.id
    WHERE m.user_id = ? AND ${accIn} AND f.special_use = '\\Inbox' AND m.date >= ? AND m.snoozed_until IS NULL AND i.priority >= 60 AND COALESCE(i.category, '') NOT IN ${OPEN_NOISE} AND ${live}
    ORDER BY i.priority DESC, m.date DESC LIMIT 12`, userId, now() - 48 * 3600e3).map(row);
  const awaiting = all(`SELECT m.id, m.from_name, m.from_addr, m.subject, m.date, m.is_read, i.summary, i.priority, i.needs_reply, i.category, i.topic
    FROM messages m JOIN folders f ON f.id = m.folder_id JOIN ai_insights i ON i.message_id = m.id
    WHERE m.user_id = ? AND ${accIn} AND f.special_use = '\\Inbox' AND ${openReplySql(userId)} AND m.date >= ? AND m.snoozed_until IS NULL
    ORDER BY i.priority DESC, m.date DESC LIMIT 12`, userId, now() - 7 * 864e5).map(row).filter((m) => !attention.some((a) => a.id === m.id));
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const events = sc && !sc.calendarIds.length ? [] : listRange(userId, start.getTime(), start.getTime() + 864e5, sc?.calendarIds, { includeInfo: false })
    .map((e) => ({ id: e.id, title: e.title, start: e.start, end: e.end, allDay: e.allDay, location: e.location, onlineMeeting: e.onlineMeeting, color: e.color }));
  const actions = all(`SELECT m.id, m.from_name, m.from_addr, m.subject, m.date, m.is_read, i.summary, i.priority, i.needs_reply, i.category, i.topic, i.action_summary
    FROM messages m JOIN folders f ON f.id = m.folder_id JOIN ai_insights i ON i.message_id = m.id
    WHERE m.user_id = ? AND ${accIn} AND f.special_use = '\\Inbox' AND ${openActionSql(userId)} AND m.date >= ? AND m.snoozed_until IS NULL
    ORDER BY i.priority DESC, m.date DESC LIMIT 12`, userId, now() - 21 * 864e5).map((m) => ({ ...row(m), action: m.action_summary }))
    .filter((m) => !attention.some((a) => a.id === m.id));
  const tasks = all(`SELECT id, title, due, priority, source_message_id FROM tasks WHERE user_id = ? AND done = 0 AND (due IS NULL OR due < ?)
    AND (source_message_id IS NULL OR source_message_id IN (SELECT m.id FROM messages m WHERE m.user_id = ? AND ${accIn}))
    ORDER BY due IS NULL, due, priority DESC LIMIT 30`, userId, start.getTime() + 2 * 864e5, userId)
    .map((t) => ({ id: t.id, title: t.title, due: t.due, priority: t.priority, sourceMessageId: t.source_message_id, overdue: !!(t.due && t.due < now()) }));
  return { attention, awaiting, actions, events, tasks };
}

/**
 * Re-writes today's brief overview in the background after something relevant changed (important new mail, task
 * changes): at most every 15 minutes, a few minutes after the last change, and only once today's brief exists.
 */
export function scheduleBriefRefresh(userId) {
  const s = getSettings(userId);
  if (!s.ai.enabled || !s.ai.dailyBrief) return;
  const day = new Date().toISOString().slice(0, 10);
  for (const b of all("SELECT day, created_at FROM briefs WHERE user_id = ? AND (day = ? OR day LIKE ?)", userId, day, `${day}@%`)) {
    if (get("SELECT 1 AS x FROM ai_jobs WHERE user_id = ? AND type = 'brief' AND ref_id = ? AND status IN ('queued', 'running')", userId, b.day)) continue;
    enqueue(userId, 'brief', b.day, 40, { delayMs: Math.max(3 * 60e3, b.created_at + 15 * 60e3 - now()), force: true });
  }
}

/**
 * How the user is addressed: sole recipient, one of several in To, only in CC, or not at all (mailing list / BCC).
 * The user's addresses are the account addresses plus their aliases.
 */
export function addressingOf(m, accounts) {
  const mine = new Set(accounts.flatMap((a) => [a.email, ...json(a.aliases_json, []).map((x) => (typeof x === 'string' ? x : x?.address))]).filter(Boolean).map((x) => x.toLowerCase()));
  const to = json(m.to_json, []), cc = json(m.cc_json, []);
  const isMine = (r) => mine.has(String(r.address || '').toLowerCase());
  const others = to.length + cc.length - to.filter(isMine).length - cc.filter(isMine).length;
  const bulk = m.list_unsubscribe ? ' The email has a List-Unsubscribe header (newsletter / mailing list).' : '';
  if (to.some(isMine)) {
    return others === 0 ? { role: 'sole', text: `Recipients: the user is the ONLY recipient (directly addressed).${bulk}` }
      : { role: 'to', text: `Recipients: the user is in To together with ${others} other recipient(s).${bulk}` };
  }
  if (cc.some(isMine)) return { role: 'cc', text: `Recipients: the user is only in CC (${to.length} in To, ${cc.length} in CC) — usually for information unless the user is named or asked something.${bulk}` };
  return { role: 'none', text: `Recipients: the user is NOT listed in To or CC (mailing list, distribution list or BCC; ${to.length + cc.length} visible recipients).${bulk}` };
}

/** Topics used in the last 90 days, most frequent first (the model is asked to reuse them for consistency). */
export function recentTopics(userId, limit = 30) {
  return all(`SELECT i.topic, COUNT(*) AS n FROM ai_insights i JOIN messages m ON m.id = i.message_id
    WHERE m.user_id = ? AND i.topic IS NOT NULL AND m.date > ? GROUP BY lower(i.topic) ORDER BY n DESC LIMIT ?`, userId, now() - 90 * 864e5, limit).map((r) => r.topic);
}

/** Cleans a model-proposed topic and maps it onto an existing one when only the spelling differs. */
export function normalizeTopic(topic, existing = []) {
  const t = String(topic || '').replace(/["'`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!t || /^(null|none|n\/a|other|general|misc)$/i.test(t)) return null;
  const key = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return existing.find((e) => key(e) === key(t)) || t;
}

/** Expired insights (login codes, past deadlines…) drop out of priority views and "needs reply". */
export function expireInsights() {
  return run(`UPDATE ai_insights SET priority = MIN(priority, 10), needs_reply = CASE WHEN needs_reply_user = 1 THEN 1 ELSE 0 END, needs_action = 0
    WHERE expires_at IS NOT NULL AND expires_at < ? AND (priority > 10 OR needs_action = 1 OR (needs_reply = 1 AND needs_reply_user IS NOT 1))`, now()).changes;
}

/**
 * "Please forward me the email with the shipping documents": finds candidate messages for each requested item,
 * in the same space as the request, older than it. Keyword and semantic matches are fused; attachments rank higher.
 */
export async function findRequestedEmails(userId, m, items) {
  const acc = get('SELECT space FROM accounts WHERE id = ?', m.account_id);
  const sc = scope(userId, acc?.space || '');
  const out = [];
  for (const it of (Array.isArray(items) ? items : []).slice(0, 2)) {
    const description = String(it?.description || '').slice(0, 200);
    const keywords = (Array.isArray(it?.keywords) ? it.keywords : []).map((k) => String(k).trim()).filter((k) => k.length > 2).slice(0, 8);
    if (!description && !keywords.length) continue;
    const score = new Map();
    const add = (id, i, w = 1) => score.set(id, (score.get(id) || 0) + w / (20 + i));
    for (const k of keywords) keywordSearch(userId, k, { limit: 15, sc }).forEach((id, i) => add(id, i));
    const q = await embedQuery(userId, `${description} ${keywords.join(' ')}`, { interactive: false, timeoutMs: 60e3 });
    messageHits(userId, q, 15, sc).forEach((h, i) => add(h.id, i, 2));
    const rows = [...score.keys()].map((id) => get(`SELECT id, subject, from_name, from_addr, date, has_attachments, thread_id FROM messages WHERE id = ? AND user_id = ? AND date <= ? AND ${inIds('account_id', sc?.accountIds)}`, id, userId, m.date))
      .filter((r) => r && r.id !== m.id && r.thread_id !== m.thread_id);
    rows.sort((a, b) => (score.get(b.id) + (b.has_attachments ? 0.05 : 0)) - (score.get(a.id) + (a.has_attachments ? 0.05 : 0)));
    out.push({ description, candidates: rows.slice(0, 3).map((r) => ({ id: r.id, subject: r.subject, from: r.from_name || r.from_addr, date: r.date, hasAttachments: !!r.has_attachments })) });
  }
  return out;
}

// ---------- background handlers ----------

/** Up to 4 recent emails with the same person in OTHER conversations (last 30 days), with their summaries. */
function relatedMail(userId, m, fromMe) {
  const people = (fromMe ? json(m.to_json, []).map((a) => a.address) : [m.from_addr]).filter(Boolean).map((a) => String(a).toLowerCase()).slice(0, 3);
  if (!people.length) return [];
  const mine = ownAddresses(userId);
  const like = people.map(() => '(lower(x.from_addr) = ? OR lower(x.to_json) LIKE ?)').join(' OR ');
  return all(`SELECT x.id, x.date, x.subject, x.from_name, x.from_addr, i.summary FROM messages x LEFT JOIN ai_insights i ON i.message_id = x.id
    WHERE x.user_id = ? AND x.thread_id != ? AND x.date BETWEEN ? AND ? AND (${like}) ORDER BY x.date DESC LIMIT 4`,
  userId, m.thread_id || '', m.date - 30 * 864e5, m.date + 864e5, ...people.flatMap((p) => [p, `%"${p}"%`])).map((r) => ({ ...r, mine: mine.has(String(r.from_addr || '').toLowerCase()) }));
}

/**
 * Earlier messages of the conversation, labelled with who wrote to whom, so the AI can tell who asked whom (a reply
 * alone — "yes, Tuesday works" — is easily read the wrong way round). When none is stored here (only the reply
 * arrived), the history quoted inside the email instead.
 */
export function conversationContext(userId, m, own, tz) {
  const seen = new Set([m.message_id]);
  const earlier = (m.thread_id ? all('SELECT * FROM messages WHERE user_id = ? AND thread_id = ? AND date <= ? AND id != ? ORDER BY date DESC LIMIT 15', userId, m.thread_id, m.date, m.id) : [])
    .filter((x) => !x.is_draft && (seen.has(x.message_id) ? false : seen.add(x.message_id))).slice(0, 5).reverse();
  if (earlier.length) return P.conversationForPrompt(earlier, own, tz);
  const q = splitPlainQuote(m.body_text);
  return q ? `(only as quoted inside THE EMAIL)\n${q.quoted.slice(0, 2500)}` : '';
}

export async function analyzeMessage(userId, messageId, { interactive = false, quiet = false } = {}) {
  const m = get('SELECT * FROM messages WHERE id = ? AND user_id = ?', messageId, userId);
  if (!m) throw skip('message gone');
  // Same message seen in another folder (e.g. Gmail labels) → reuse the analysis (not when analysing it again).
  const dup = !get('SELECT 1 AS x FROM ai_insights WHERE message_id = ?', m.id) && get('SELECT i.* FROM ai_insights i JOIN messages x ON x.id = i.message_id WHERE x.user_id = ? AND x.message_id = ? AND x.id != ? LIMIT 1', userId, m.message_id, m.id);
  let model;
  if (dup) {
    run(`INSERT OR REPLACE INTO ai_insights (message_id, summary, category, priority, priority_reason, needs_reply, action_items_json, suggested_replies_json, events_json,
      sentiment, language, is_phishing, draft_reply, model, created_at, expires_at, requests_json, topic, dismissed_at, needs_action, action_summary)
      SELECT ?, summary, category, priority, priority_reason, needs_reply, action_items_json, suggested_replies_json, events_json,
      sentiment, language, is_phishing, draft_reply, model, created_at, expires_at, requests_json, topic, dismissed_at, needs_action, action_summary FROM ai_insights WHERE message_id = ?`, m.id, dup.message_id);
    run("UPDATE messages SET ai_status = 'done' WHERE id = ?", m.id);
  } else {
    const { ctx, settings, accounts, uiLanguage } = ctxFor(userId);
    const own = ownAddresses(userId);
    const fromMe = own.has(String(m.from_addr || '').toLowerCase());
    const addressing = fromMe ? null : addressingOf(m, accounts);
    const contact = contactByEmail(userId, m.from_addr);
    const senderInfo = fromMe ? 'Sender: the user themself.' : contact
      ? `Sender is a known contact (${contact.contact_count} previous exchanges${contact.favorite ? ', marked as favorite/VIP' : ''}).`
      : 'Sender is not in the user\'s contacts.';
    const recipientInfo = addressing ? `\n${addressing.text}` : '';
    const about = (fromMe ? json(m.to_json, []).slice(0, 2).map((a) => a.address) : [m.from_addr]).map((a) => profileText(userId, a)).filter(Boolean);
    const peopleInfo = about.length ? `\n${fromMe ? 'About the recipients' : 'About the sender'} (from earlier mail): ${about.join('\n')}` : '';
    const tz = settings.calendar.timezone;
    const pref = fromMe ? { importance: null, category: null } : senderPreference(userId, m.from_addr);
    const topics = recentTopics(userId);
    // Broader than the conversation: requests the user's email may close (fromMe), and recent mail with the same
    // people in other conversations (a reply may come as a new email, with another subject or more people).
    const candidates = fromMe && !quiet ? openRequestsFor(userId, m) : [];
    const openRequests = candidates.map((c) => `[${c.id}] ${P.localStamp(c.date, tz).slice(0, 10)} from ${c.from_name || c.from_addr} · ${c.subject}${c.action_summary ? ` → ${c.action_summary}` : ''}${c.summary ? ` — ${c.summary}` : ''}`).join('\n');
    const related = relatedMail(userId, m, fromMe).map((r) => `- ${P.localStamp(r.date, tz).slice(0, 10)} ${r.mine ? 'the user →' : `${r.from_name || r.from_addr} →`} ${r.subject}${r.summary ? ` — ${r.summary}` : ''}`).join('\n');
    const prompt = P.analyzePrompt({ ctx, message: P.messageForPrompt(m, 6000, tz, own), conversation: conversationContext(userId, m, own, tz), senderInfo: senderInfo + recipientInfo + peopleInfo, timezone: tz, fromMe, topics, openRequests, related, preferences: fromMe ? '' : preferenceExamples(userId, m.from_addr),
      language: settings.ai.replyLanguage !== 'auto' ? settings.ai.replyLanguage : uiLanguage });
    const res = await chatJSON(userId, 'background', { ...prompt, temperature: 0.1, maxTokens: 1000, interactive });
    model = res.model;
    if (contact?.favorite && res.data.priority < 70) res.data.priority = 70;
    // Not addressed to the user at all (mailing list, BCC, bulk): nobody expects a reply and it is rarely urgent.
    if (addressing?.role === 'none' && pref.importance !== 'important' && !contact?.favorite) {
      res.data.needs_reply = false;
      res.data.priority = Math.min(Number(res.data.priority) || 0, 55);
    }
    applyPreference(res.data, pref);
    res.data.topic = normalizeTopic(res.data.topic, topics);
    if (fromMe) { res.data.needs_reply = false; res.data.needs_action = false; res.data.suggested_replies = []; res.data.requested_items = []; res.data.priority = Math.min(Number(res.data.priority) || 0, 40); }
    if (!quiet && Array.isArray(res.data.requested_items) && res.data.requested_items.length) {
      res.data.requests = await findRequestedEmails(userId, m, res.data.requested_items).catch(() => null);
    }
    saveInsight(m, res.data, model, tz, { quiet });
    if (candidates.length && Array.isArray(res.data.resolves) && res.data.resolves.length) resolveByAi(userId, m, res.data.resolves, candidates);
    if (settings.ai.embeddings) saveFacts(userId, m, res.data.facts, res.data.category);
  }
  const ins = get('SELECT * FROM ai_insights WHERE message_id = ?', m.id);
  notifyAI(userId, 'ai:insight', { messageId: m.id, threadId: m.thread_id, insight: serializeInsight(ins) });
  const settings = getSettings(userId);
  if (ins.priority >= 80 && !m.is_read && now() - m.date < 864e5 && !(ins.expires_at && ins.expires_at < now())) notifyAI(userId, 'mail:important', { id: m.id, from: m.from_name || m.from_addr, subject: m.subject, summary: ins.summary });
  if (!quiet && ins.needs_reply && ins.priority >= 50 && now() - m.date < 7 * 864e5 && !ins.draft_reply) enqueue(userId, 'draft', m.id, 35);
  if (ins.priority >= 60 && now() - m.date < 36 * 3600e3) scheduleBriefRefresh(userId);
  const count = get('SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND thread_id = ?', userId, m.thread_id).n;
  if (settings.ai.threadSummaries && count >= 3) enqueue(userId, 'thread', m.thread_id, 30, { force: true });
  await applyRules(userId, [m.id], 'ai');
}

/**
 * Once after an update that changes what the analysis sees (version key): the mail that is open now ("needs reply",
 * "action needed") is analysed again, in the background and after new mail. What the user marked stays as it was.
 */
export function reanalyzeOpen(version = 'context:v1') {
  if (get('SELECT value FROM app_state WHERE key = ?', `reanalyze:${version}`)) return 0;
  let n = 0;
  for (const u of all('SELECT id FROM users')) {
    const rows = all(`SELECT m.id FROM messages m JOIN ai_insights i ON i.message_id = m.id WHERE m.user_id = ? AND i.model != 'user'
      AND (${openReplySql(u.id)} OR ${openActionSql(u.id)}) ORDER BY m.date DESC LIMIT 300`, u.id);
    for (const r of rows) { enqueue(u.id, 'analyze', r.id, 15, { force: true }); n++; }
  }
  run('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)', `reanalyze:${version}`, String(now()));
  return n;
}

export async function summarizeThreadJob(userId, threadId) {
  const msgs = all('SELECT * FROM messages WHERE user_id = ? AND thread_id = ? ORDER BY date', userId, threadId);
  const unique = [...new Map(msgs.map((m) => [m.message_id, m])).values()];
  if (unique.length < 2) throw skip('single message');
  const cached = get('SELECT * FROM thread_summaries WHERE user_id = ? AND thread_id = ?', userId, threadId);
  if (cached && cached.message_count === unique.length) return cached;
  const { ctx, uiLanguage, settings } = ctxFor(userId);
  const own = ownAddresses(userId);
  const parts = unique.filter((m) => !m.is_draft).slice(-12).map((m) => P.messageForPrompt(m, 2500, settings.calendar.timezone, own));
  const res = await chat(userId, 'background', { ...P.threadSummaryPrompt({ ctx, messages: parts, language: uiLanguage }), temperature: 0.2, maxTokens: 600 });
  run('INSERT OR REPLACE INTO thread_summaries (user_id, thread_id, summary, message_count, model, updated_at) VALUES (?, ?, ?, ?, ?, ?)', userId, threadId, res.text.trim(), unique.length, res.model, now());
  notifyAI(userId, 'ai:thread', { threadId, summary: res.text.trim() });
  queueMemory(userId, 'thread', threadId);
  return get('SELECT * FROM thread_summaries WHERE user_id = ? AND thread_id = ?', userId, threadId);
}

// ---------- memory (semantic index for search and the assistant) ----------

const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : '');
const NOISE = ['newsletter', 'promotion', 'social', 'notification'];

/** What to embed for one memory item, or null when the item is gone / not worth remembering. */
function memoryItem(userId, kind, ref) {
  if (kind === 'message') {
    const m = get('SELECT * FROM messages WHERE id = ? AND user_id = ?', Number(ref), userId);
    if (!m) return null;
    const to = json(m.to_json, []).map((a) => a.name || a.address).slice(0, 5).join(', ');
    const atts = json(m.attachments_json, []).filter((a) => !a.inline).map((a) => a.filename);
    // Every chunk repeats the header so it can be understood (and matched on sender/date) on its own.
    const head = `Email · ${day(m.date)} · From: ${m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr} · To: ${to}\nSubject: ${m.subject}${atts.length ? `\nAttachments: ${atts.join(', ')}` : ''}\n`;
    const body = P.stripQuoted(m.body_text) || String(m.body_text || '');
    return { kind, ref: m.id, owner: `a:${m.account_id}`, date: m.date, texts: chunkText(body).map((c) => `${head}\n${c}`) };
  }
  if (kind === 'thread') {
    const t = get('SELECT * FROM thread_summaries WHERE user_id = ? AND thread_id = ?', userId, ref);
    const last = get('SELECT account_id, subject, date FROM messages WHERE user_id = ? AND thread_id = ? ORDER BY date DESC LIMIT 1', userId, ref);
    if (!t || !last) return null;
    return { kind, ref, owner: `a:${last.account_id}`, date: last.date, texts: [`Conversation summary · "${last.subject}" · ${t.message_count} messages, last ${day(last.date)}\n${t.summary}`] };
  }
  if (kind === 'event') {
    const e = get('SELECT e.* FROM events e JOIN calendars c ON c.id = e.calendar_id WHERE e.id = ? AND c.user_id = ? AND e.deleted = 0', Number(ref), userId);
    if (!e) return null;
    const who = json(e.attendees_json, []).map((a) => a.name || a.email).slice(0, 10).join(', ');
    const tz = getSettings(userId).calendar.timezone;
    const when = e.all_day ? day(e.start) : `${P.localStamp(e.start, tz)} – ${P.localStamp(e.end, tz).slice(-5)}`;
    return { kind, ref: e.id, owner: `c:${e.calendar_id}`, date: e.start, texts: [`Calendar event: ${e.title} · ${when}${e.rrule ? ` (repeats: ${e.rrule})` : ''}${e.location ? ` · ${e.location}` : ''}${who ? `\nAttendees: ${who}` : ''}${e.description ? `\n${String(e.description).slice(0, 1500)}` : ''}`] };
  }
  if (kind === 'contact') {
    const c = get('SELECT * FROM contacts WHERE id = ? AND user_id = ? AND deleted = 0', Number(ref), userId);
    if (!c || (c.auto_collected && !c.favorite)) return null;
    const emails = json(c.emails_json, []).map((x) => x.value).join(', ');
    const phones = json(c.phones_json, []).map((x) => x.value).join(', ');
    const groups = json(c.groups_json, []).join(', ');
    return { kind, ref: c.id, owner: `b:${c.address_book_id}`, date: c.updated_at, texts: [`Contact: ${c.display_name}${c.title ? `, ${c.title}` : ''}${c.org ? ` at ${c.org}` : ''}\nEmail: ${emails}${phones ? `\nPhone: ${phones}` : ''}${groups ? `\nGroups: ${groups}` : ''}${c.notes ? `\nNotes: ${String(c.notes).slice(0, 1000)}` : ''}`] };
  }
  if (kind === 'fact') {
    const f = get('SELECT * FROM facts WHERE id = ? AND user_id = ?', Number(ref), userId);
    return f && { kind, ref: f.id, owner: f.owner, date: f.created_at, texts: [`Fact: ${f.text}`] };
  }
  return null;
}

const jobKind = (type, ref) => (type === 'embed' ? ['message', ref] : [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)]);

/** Indexes memory items; claims other queued memory jobs of the user so embeddings go out in batches. */
export async function memoryJob(userId, ref, job) {
  const others = all("SELECT id, type, ref_id FROM ai_jobs WHERE user_id = ? AND type IN ('embed', 'memory') AND status = 'queued' AND id != ? ORDER BY priority DESC, id DESC LIMIT 31", userId, job?.id || 0);
  for (const o of others) run("UPDATE ai_jobs SET status = 'running' WHERE id = ?", o.id);
  try {
    const items = [jobKind(job?.type || 'embed', String(ref)), ...others.map((o) => jobKind(o.type, o.ref_id))].map(([k, r]) => {
      const it = memoryItem(userId, k, r);
      if (!it) removeMemory(userId, k, [r]);
      return it;
    }).filter((it) => it?.texts.length);
    const texts = items.flatMap((it) => it.texts);
    const vectors = [];
    let model;
    // Small batches: each background request to the model server stays short, so user requests are not held up.
    for (let i = 0; i < texts.length; i += 16) {
      const res = await embed(userId, texts.slice(i, i + 16));
      vectors.push(...res.vectors);
      model = res.model;
    }
    let n = 0;
    for (const it of items) {
      const chunks = it.texts.map((text) => ({ text, vector: vectors[n++] })).filter((c) => c.vector?.length);
      if (it.kind === 'fact' && isDuplicateFact(userId, it, chunks[0]?.vector, model)) continue;
      storeMemory(userId, { ...it, model, chunks });
    }
    for (const o of others) run("UPDATE ai_jobs SET status = 'done', error = NULL, updated_at = ? WHERE id = ?", now(), o.id);
  } catch (e) {
    for (const o of others) run("UPDATE ai_jobs SET status = 'queued' WHERE id = ?", o.id);
    throw e;
  }
}

// A fact that says the same as one already remembered (in the same scope) is dropped.
function isDuplicateFact(userId, it, vector, model) {
  if (!vector) return false;
  const dup = searchMemory(userId, vector, model, { k: 2, owners: new Set([it.owner]), kinds: new Set(['fact']), minScore: 0.93 }).find((h) => h.ref !== String(it.ref));
  if (!dup) return false;
  run('DELETE FROM facts WHERE id = ? AND user_id = ?', it.ref, userId);
  return true;
}

/** Facts proposed by the analysis of a message (durable knowledge, e.g. roles, commitments, deadlines). */
function saveFacts(userId, m, facts, category) {
  const old = all("SELECT id FROM facts WHERE user_id = ? AND source_message_id = ? AND origin = 'auto'", userId, m.id).map((f) => f.id);
  if (old.length) { run(`DELETE FROM facts WHERE id IN (${old.join(',')})`); removeMemory(userId, 'fact', old); }
  if (NOISE.includes(category) || !Array.isArray(facts)) return;
  for (const f of facts.slice(0, 3)) {
    const text = String(typeof f === 'string' ? f : f?.text || '').trim().slice(0, 240);
    if (text.length < 8) continue;
    const r = run("INSERT INTO facts (user_id, owner, text, origin, source_message_id, created_at) VALUES (?, ?, ?, 'auto', ?, ?)", userId, `a:${m.account_id}`, text, m.id, now());
    queueMemory(userId, 'fact', r.lastInsertRowid);
  }
}

/** A fact the user asked to remember. space '' = shared by all spaces. */
export function rememberFact(userId, text, space = '') {
  const r = run("INSERT INTO facts (user_id, owner, text, origin, created_at) VALUES (?, ?, ?, 'user', ?)", userId, `s:${space}`, String(text).trim().slice(0, 500), now());
  queueMemory(userId, 'fact', r.lastInsertRowid, 70);
  return r.lastInsertRowid;
}

function threadText(userId, m, max = 6) {
  const seen = new Set();
  const msgs = all('SELECT * FROM messages WHERE user_id = ? AND thread_id = ? AND date <= ? ORDER BY date DESC LIMIT ?', userId, m.thread_id, m.date, max * 2)
    .filter((x) => !x.is_draft && (seen.has(x.message_id) ? false : seen.add(x.message_id))).slice(0, max).reverse();
  const own = ownAddresses(userId);
  return msgs.map((x) => P.messageForPrompt(x, 2500, getSettings(userId).calendar.timezone, own)).join('\n\n---\n\n');
}

export async function draftJob(userId, messageId) {
  const m = get('SELECT * FROM messages WHERE id = ? AND user_id = ?', messageId, userId);
  if (!m) throw skip('gone');
  const text = await draftReply(userId, Number(messageId), null, null, 'background');
  run('UPDATE ai_insights SET draft_reply = ? WHERE message_id = ?', text, m.id);
  notifyAI(userId, 'ai:draft', { messageId: m.id });
}

// ref: 'YYYY-MM-DD' or 'YYYY-MM-DD@<space>'
export async function briefJob(userId, ref) {
  const [day, space = ''] = String(ref).split('@');
  return dailyBrief(userId, { day, space, force: true });
}

registerHandler('analyze', (userId, ref, job) => analyzeMessage(userId, ref, { quiet: !!json(job?.options_json, {})?.quiet }));
registerHandler('thread', summarizeThreadJob);
registerHandler('embed', memoryJob);
registerHandler('memory', memoryJob);
registerHandler('draft', draftJob);
registerHandler('brief', briefJob);

// ---------- on-demand ----------

export async function draftReply(userId, messageId, intent, onToken, task = 'compose') {
  const m = get('SELECT * FROM messages WHERE id = ? AND user_id = ?', messageId, userId);
  if (!m) throw new Error('Message not found');
  if (!intent && !onToken) {
    const pre = get('SELECT draft_reply FROM ai_insights WHERE message_id = ?', messageId)?.draft_reply;
    if (pre && task === 'compose') return pre;
  }
  const { ctx, settings, user, accounts } = ctxFor(userId);
  const acc = accounts.find((a) => a.id === m.account_id);
  const to = m.reply_to_json && json(m.reply_to_json, [])[0]?.address || m.from_addr;
  const prompt = P.draftReplyPrompt({ ctx, style: settings.ai.writingStyle, learned: settings.ai.learnedStyle, examples: styleExamples(userId, [to]),
    people: profileText(userId, to, { writing: true }), thread: threadText(userId, m), intent, language: replyLanguage(settings), signatureName: acc?.display_name || user.name });
  const res = await chat(userId, task, { ...prompt, temperature: 0.5, maxTokens: 900, onToken });
  return res.text.trim();
}

export async function composeNew(userId, { instruction, to }, onToken) {
  const { ctx, settings, user, uiLanguage } = ctxFor(userId);
  const lang = settings.ai.replyLanguage !== 'auto' ? settings.ai.replyLanguage : `${uiLanguage} (unless the instruction implies another language)`;
  const addrs = String(to || '').match(/[^\s<>,;"]+@[^\s<>,;"]+/g) || [];
  const res = await chat(userId, 'compose', { ...P.composePrompt({ ctx, style: settings.ai.writingStyle, learned: settings.ai.learnedStyle, examples: styleExamples(userId, addrs),
    instruction, recipients: to, language: lang, signatureName: user.name, people: addrs.slice(0, 3).map((a) => profileText(userId, a, { writing: true })).filter(Boolean).join('\n') }), temperature: 0.6, maxTokens: 1200, onToken });
  const m = res.text.match(/^\s*Subject:\s*(.+)\n+([\s\S]*)$/i);
  return m ? { subject: m[1].trim(), body: m[2].trim() } : { subject: '', body: res.text.trim() };
}

/** Task title and due date from free text, by the AI (used when the rules in util/dates.js found no date). */
export async function aiParseTask(userId, text, tz) {
  const { ctx } = ctxFor(userId);
  const { data } = await chatJSON(userId, 'compose', { system: `You turn a to-do note into a task. ${ctx}
Return JSON {"title": short task title without the date words, "date": "YYYY-MM-DD" or null, "time": "HH:MM" or null}. Times are wall-clock in ${tz}. Resolve relative dates from today.`,
  messages: [{ role: 'user', content: String(text).slice(0, 500) }], temperature: 0, maxTokens: 120 });
  const due = data?.date ? localToEpoch(data.date, data.time || '09:00', tz) : null;
  return { title: String(data?.title || text).trim().slice(0, 200), due: Number.isNaN(due) ? null : due };
}

// ---------- writing style learned from sent mail ----------

const PUBLIC_MAIL = /@(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|gmx|web|proton|protonmail|siol|t-2|amis|aol|mail)\.[a-z.]+$/i;
const sentRows = (userId, where, params, limit) => all(`SELECT m.to_json, m.body_text, m.date FROM messages m JOIN folders f ON f.id = m.folder_id
  WHERE m.user_id = ? AND f.special_use = '\\Sent' AND ${where} ORDER BY m.date DESC LIMIT ?`, userId, ...params, limit);

/** Up to three of the user's own recent emails to these recipients (else to their organisation) as style examples. */
export function styleExamples(userId, recipients) {
  const addrs = (recipients || []).filter(Boolean).map((a) => String(a).toLowerCase()).slice(0, 3);
  if (!addrs.length) return '';
  let rows = [];
  for (const a of addrs) if (rows.length < 3) rows.push(...sentRows(userId, 'lower(m.to_json) LIKE ?', [`%"${a}"%`], 3 - rows.length));
  if (!rows.length) {
    const domains = [...new Set(addrs.filter((a) => !PUBLIC_MAIL.test(a)).map((a) => a.split('@')[1]))];
    for (const d of domains) if (rows.length < 2) rows.push(...sentRows(userId, 'lower(m.to_json) LIKE ?', [`%@${d}"%`], 2 - rows.length));
  }
  return rows.map((r) => P.stripQuoted(r.body_text).slice(0, 700)).filter((t) => t.length > 20).map((t, i) => `--- example ${i + 1} ---\n${t}`).join('\n');
}

/** Background job: a short description of how the user writes, from ~25 recent sent emails (refreshed weekly). */
export async function learnStyleJob(userId) {
  const rows = sentRows(userId, '1', [], 40).map((r) => ({ to: json(r.to_json, []).map((a) => a.address.split('@')[1]).join(', '), text: P.stripQuoted(r.body_text).slice(0, 600) }))
    .filter((r) => r.text.length > 40).slice(0, 25);
  if (rows.length < 5) throw skip('not enough sent mail yet');
  const res = await chat(userId, 'background', { ...P.stylePrompt({ samples: rows }), temperature: 0.2, maxTokens: 500 });
  saveSettings(userId, { ai: { learnedStyle: res.text.trim().slice(0, 1500), learnedStyleAt: now() } });
}
registerHandler('style', learnStyleJob);

export async function rewrite(userId, { text, mode, instruction, language }, onToken) {
  const res = await chat(userId, 'compose', { ...P.rewritePrompt({ text, mode, instruction, language: language || 'English' }), temperature: 0.3, maxTokens: 1500, onToken });
  return res.text.trim();
}

export async function insightFor(userId, messageId, { wait = true } = {}) {
  let ins = get('SELECT * FROM ai_insights WHERE message_id = ?', messageId);
  // The background queue is already on it: wait for that result instead of analysing twice.
  for (let i = 0; !ins && wait && i < 360 && get("SELECT status FROM ai_jobs WHERE user_id = ? AND type = 'analyze' AND ref_id = ?", userId, String(messageId))?.status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 500));
    ins = get('SELECT * FROM ai_insights WHERE message_id = ?', messageId);
  }
  if (!ins && wait) {
    await analyzeMessage(userId, messageId, { interactive: true });
    run("UPDATE ai_jobs SET status = 'done' WHERE user_id = ? AND type = 'analyze' AND ref_id = ?", userId, String(messageId));
    ins = get('SELECT * FROM ai_insights WHERE message_id = ?', messageId);
  }
  return serializeInsight(ins);
}

export async function threadSummary(userId, threadId) {
  const r = await summarizeThreadJob(userId, threadId).catch((e) => { if (e.code === 'SKIP') return null; throw e; });
  return r?.summary || null;
}

export async function extractEvent(userId, messageId) {
  const m = get('SELECT * FROM messages WHERE id = ? AND user_id = ?', messageId, userId);
  if (!m) throw new Error('Message not found');
  // An invitation carries exact times (with its zone): no need to ask the AI.
  if (m.calendar_ics) {
    try {
      const ev = parseIcs(m.calendar_ics, getSettings(userId).calendar.timezone).events.find((e) => e.start);
      if (ev) {
        return { title: ev.title || m.subject, start: ev.start, end: ev.end, allDay: ev.allDay, location: ev.location || '', description: ev.description || '',
          attendees: ev.attendees.map((a) => ({ email: a.email, name: a.name, status: 'needs-action' })), sourceMessageId: m.id };
      }
    } catch { /* malformed invitation: fall back to reading the text */ }
  }
  const { ctx } = ctxFor(userId);
  const tz = getSettings(userId).calendar.timezone;
  const { data } = await chatJSON(userId, 'compose', { ...P.extractEventPrompt({ ctx, message: P.messageForPrompt(m, 4000, tz), timezone: tz }), temperature: 0.1, maxTokens: 500 });
  const ev = normalizeEvent(data, tz, { text: `${m.subject || ''}\n${m.body_text || ''}` });
  const start = ev ? Date.parse(ev.start) : NaN;
  const end = ev ? Date.parse(ev.end) : NaN;
  return {
    title: data.title || m.subject, start: Number.isNaN(start) ? null : start, end: Number.isNaN(end) ? null : end, allDay: !!ev?.all_day, location: data.location || '',
    description: data.description || '', attendees: (data.attendees || []).filter((x) => typeof x === 'string' && x.includes('@')).map((email) => ({ email, name: '', status: 'needs-action' })),
    sourceMessageId: m.id,
  };
}

/** cacheOnly: return the stored overview or queue it for the background (never makes the caller wait for the AI). */
export async function dailyBrief(userId, { day, force = false, space = '', interactive = false, cacheOnly = false } = {}) {
  const today = day || new Date().toISOString().slice(0, 10);
  const sc = scope(userId, space);
  const key = sc ? `${today}@${sc.space}` : today; // one brief per day and space
  const cached = get('SELECT * FROM briefs WHERE user_id = ? AND day = ?', userId, key);
  if (cached && !force) return { day: today, space: sc?.space || '', content: cached.content_json, createdAt: cached.created_at, model: cached.model };
  if (cacheOnly) { enqueue(userId, 'brief', key, 60); return { day: today, space: sc?.space || '', content: null, pending: true }; }
  const { ctx, uiLanguage } = ctxFor(userId);
  const accIn = inIds('m.account_id', sc?.accountIds);
  const since = now() - 36 * 3600e3;
  const important = all(`SELECT m.id, m.from_name, m.from_addr, m.subject, m.date, m.is_read, i.summary, i.priority, i.needs_reply, i.action_items_json
    FROM messages m JOIN folders f ON f.id = m.folder_id LEFT JOIN ai_insights i ON i.message_id = m.id
    WHERE m.user_id = ? AND ${accIn} AND f.special_use = '\\Inbox' AND m.date >= ? AND m.snoozed_until IS NULL
      AND (i.message_id IS NULL OR (i.dismissed_at IS NULL AND (i.expires_at IS NULL OR i.expires_at > ${now()})))
    ORDER BY COALESCE(i.priority, 40) DESC, m.date DESC LIMIT 25`, userId, since);
  const awaiting = all(`SELECT m.id, m.from_name, m.from_addr, m.subject, m.date, i.summary FROM messages m JOIN ai_insights i ON i.message_id = m.id
    WHERE m.user_id = ? AND ${accIn} AND i.needs_reply = 1 AND i.dismissed_at IS NULL AND m.is_answered = 0 AND m.date >= ? ORDER BY i.priority DESC LIMIT 10`, userId, now() - 7 * 864e5);
  const start = new Date(today + 'T00:00:00'); const end = new Date(start.getTime() + 864e5);
  const tz = getSettings(userId).calendar.timezone;
  const events = (sc && !sc.calendarIds.length ? [] : listRange(userId, start.getTime(), end.getTime(), sc?.calendarIds, { includeInfo: false })).map((e) => ({ title: e.title, start: P.localStamp(e.start, tz), end: P.localStamp(e.end, tz), allDay: e.allDay, location: e.location }));
  const tasks = all(`SELECT title, due FROM tasks WHERE user_id = ? AND done = 0 AND (due IS NULL OR due < ?)
    AND (source_message_id IS NULL OR source_message_id IN (SELECT m.id FROM messages m WHERE m.user_id = ? AND ${accIn})) ORDER BY due LIMIT 15`, userId, end.getTime(), userId)
    .map((t) => ({ title: t.title, due: t.due ? new Date(t.due).toDateString() : null, overdue: t.due && t.due < start.getTime() }));
  const data = {
    date: today,
    recentEmails: important.map((m) => ({ ID: m.id, from: m.from_name || m.from_addr, subject: m.subject, summary: m.summary, priority: m.priority, needsReply: !!m.needs_reply, unread: !m.is_read })),
    awaitingYourReply: awaiting.map((m) => ({ ID: m.id, from: m.from_name || m.from_addr, subject: m.subject, summary: m.summary, receivedDaysAgo: Math.round((now() - m.date) / 864e5) })),
    events, tasks,
  };
  const res = await chat(userId, 'background', { ...P.briefPrompt({ ctx, language: uiLanguage, data }), temperature: 0.3, maxTokens: 1200, interactive });
  run('INSERT OR REPLACE INTO briefs (user_id, day, content_json, model, created_at) VALUES (?, ?, ?, ?, ?)', userId, key, res.text.trim(), res.model, now());
  notifyAI(userId, 'ai:brief', { day: today, space: sc?.space || '' });
  return { day: today, space: sc?.space || '', content: res.text.trim(), createdAt: now(), model: res.model };
}
