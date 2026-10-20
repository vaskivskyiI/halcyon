// AI features. Background handlers precompute insights, thread summaries, embeddings, reply drafts and the
// daily brief; on-demand functions reuse those results when available and stream otherwise.
import { get, all, run, json, now } from '../db/index.js';
import { getSettings } from '../settings.js';
import { chat, chatJSON, embed } from './router.js';
import { registerHandler, enqueue, notifyAI, queueMemory } from './queue.js';
import * as P from './prompts.js';
import { storeMemory, removeMemory, searchMemory, chunkText } from './memory.js';
import { applyRules } from '../rules.js';
import { listRange } from '../calendar/repo.js';
import { userAccounts } from '../accounts.js';
import { contactByEmail } from '../contacts/service.js';
import { scope, inIds } from '../spaces.js';
import { localToEpoch, normalizeEvent } from '../util/time.js';
import { senderPreference, applyPreference, preferenceExamples } from './learning.js';
import { keywordSearch, embedQuery, messageHits } from '../search.js';

const LANG_NAMES = { en: 'English', sl: 'Slovenian', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', hr: 'Croatian', sr: 'Serbian', uk: 'Ukrainian', pl: 'Polish', pt: 'Portuguese', nl: 'Dutch', cs: 'Czech', ru: 'Russian', ja: 'Japanese', zh: 'Chinese' };
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
    topic: r.topic || null, dismissed: !!r.dismissed_at,
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

function saveInsight(m, d, model, tz) {
  const messageId = m.id;
  const events = (Array.isArray(d.events) ? d.events : []).map((e) => normalizeEvent(e, tz)).filter(Boolean).slice(0, 5);
  const expires = expiryOf(d, m, tz);
  let priority = clampInt(d.priority, 0, 100, 30), needsReply = d.needs_reply ? 1 : 0;
  if (expires && expires < now()) { priority = Math.min(priority, 10); needsReply = 0; } // analysed after it expired
  run(`INSERT OR REPLACE INTO ai_insights (message_id, summary, category, priority, priority_reason, needs_reply, action_items_json,
    suggested_replies_json, events_json, sentiment, language, is_phishing, draft_reply, model, created_at, expires_at, requests_json, topic, dismissed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,(SELECT draft_reply FROM ai_insights WHERE message_id = ?),?,?,?,?,?,(SELECT dismissed_at FROM ai_insights WHERE message_id = ?))`,
    messageId, String(d.summary || '').slice(0, 1000), P.CATEGORIES.includes(d.category) ? d.category : 'other',
    priority, String(d.priority_reason || '').slice(0, 200), needsReply,
    JSON.stringify((Array.isArray(d.action_items) ? d.action_items : []).slice(0, 10).map((a) => (typeof a === 'string' ? { text: a, due: null } : { text: String(a.text || ''), due: a.due || null })).filter((a) => a.text)),
    JSON.stringify((Array.isArray(d.suggested_replies) ? d.suggested_replies : []).slice(0, 3).map(String)),
    JSON.stringify(events),
    ['positive', 'neutral', 'negative', 'urgent'].includes(d.sentiment) ? d.sentiment : 'neutral',
    String(d.language || '').slice(0, 5), d.is_phishing ? 1 : 0, messageId, model, now(), expires, d.requests ? JSON.stringify(d.requests) : null,
    d.topic || null, messageId);
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
    WHERE m.user_id = ? AND ${accIn} AND f.special_use = '\\Inbox' AND m.date >= ? AND m.snoozed_until IS NULL AND i.priority >= 60 AND ${live}
    ORDER BY i.priority DESC, m.date DESC LIMIT 12`, userId, now() - 48 * 3600e3).map(row);
  const awaiting = all(`SELECT m.id, m.from_name, m.from_addr, m.subject, m.date, m.is_read, i.summary, i.priority, i.needs_reply, i.category, i.topic
    FROM messages m JOIN folders f ON f.id = m.folder_id JOIN ai_insights i ON i.message_id = m.id
    WHERE m.user_id = ? AND ${accIn} AND f.special_use = '\\Inbox' AND i.needs_reply = 1 AND m.is_answered = 0 AND m.date >= ? AND ${live}
    ORDER BY i.priority DESC, m.date DESC LIMIT 12`, userId, now() - 7 * 864e5).map(row).filter((m) => !attention.some((a) => a.id === m.id));
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const events = sc && !sc.calendarIds.length ? [] : listRange(userId, start.getTime(), start.getTime() + 864e5, sc?.calendarIds)
    .map((e) => ({ id: e.id, title: e.title, start: e.start, end: e.end, allDay: e.allDay, location: e.location, onlineMeeting: e.onlineMeeting, color: e.color }));
  const tasks = all(`SELECT id, title, due, priority, source_message_id FROM tasks WHERE user_id = ? AND done = 0 AND (due IS NULL OR due < ?)
    AND (source_message_id IS NULL OR source_message_id IN (SELECT m.id FROM messages m WHERE m.user_id = ? AND ${accIn}))
    ORDER BY due IS NULL, due, priority DESC LIMIT 30`, userId, start.getTime() + 2 * 864e5, userId)
    .map((t) => ({ id: t.id, title: t.title, due: t.due, priority: t.priority, sourceMessageId: t.source_message_id, overdue: !!(t.due && t.due < now()) }));
  return { attention, awaiting, events, tasks };
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
  return run('UPDATE ai_insights SET priority = MIN(priority, 10), needs_reply = 0 WHERE expires_at IS NOT NULL AND expires_at < ? AND (priority > 10 OR needs_reply = 1)', now()).changes;
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

export async function analyzeMessage(userId, messageId, { interactive = false } = {}) {
  const m = get('SELECT * FROM messages WHERE id = ? AND user_id = ?', messageId, userId);
  if (!m) throw skip('message gone');
  // Same message seen in another folder (e.g. Gmail labels) → reuse the analysis.
  const dup = get('SELECT i.* FROM ai_insights i JOIN messages x ON x.id = i.message_id WHERE x.user_id = ? AND x.message_id = ? AND x.id != ? LIMIT 1', userId, m.message_id, m.id);
  let model;
  if (dup) {
    run(`INSERT OR REPLACE INTO ai_insights (message_id, summary, category, priority, priority_reason, needs_reply, action_items_json, suggested_replies_json, events_json,
      sentiment, language, is_phishing, draft_reply, model, created_at, expires_at, requests_json, topic, dismissed_at)
      SELECT ?, summary, category, priority, priority_reason, needs_reply, action_items_json, suggested_replies_json, events_json,
      sentiment, language, is_phishing, draft_reply, model, created_at, expires_at, requests_json, topic, dismissed_at FROM ai_insights WHERE message_id = ?`, m.id, dup.message_id);
    run("UPDATE messages SET ai_status = 'done' WHERE id = ?", m.id);
  } else {
    const { ctx, settings, accounts, uiLanguage } = ctxFor(userId);
    const fromMe = accounts.some((a) => a.email.toLowerCase() === m.from_addr);
    const addressing = fromMe ? null : addressingOf(m, accounts);
    const contact = contactByEmail(userId, m.from_addr);
    const senderInfo = fromMe ? 'Sender: the user themself.' : contact
      ? `Sender is a known contact (${contact.contact_count} previous exchanges${contact.favorite ? ', marked as favorite/VIP' : ''}).`
      : 'Sender is not in the user\'s contacts.';
    const recipientInfo = addressing ? `\n${addressing.text}` : '';
    const tz = settings.calendar.timezone;
    const pref = fromMe ? { importance: null, category: null } : senderPreference(userId, m.from_addr);
    const topics = recentTopics(userId);
    const prompt = P.analyzePrompt({ ctx, message: P.messageForPrompt(m, 6000, tz), senderInfo: senderInfo + recipientInfo, timezone: tz, fromMe, topics, preferences: fromMe ? '' : preferenceExamples(userId, m.from_addr),
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
    if (fromMe) { res.data.needs_reply = false; res.data.suggested_replies = []; res.data.requested_items = []; res.data.priority = Math.min(Number(res.data.priority) || 0, 40); }
    if (Array.isArray(res.data.requested_items) && res.data.requested_items.length) {
      res.data.requests = await findRequestedEmails(userId, m, res.data.requested_items).catch(() => null);
    }
    saveInsight(m, res.data, model, tz);
    if (settings.ai.embeddings) saveFacts(userId, m, res.data.facts, res.data.category);
  }
  const ins = get('SELECT * FROM ai_insights WHERE message_id = ?', m.id);
  notifyAI(userId, 'ai:insight', { messageId: m.id, threadId: m.thread_id, insight: serializeInsight(ins) });
  const settings = getSettings(userId);
  if (ins.priority >= 80 && !m.is_read && now() - m.date < 864e5 && !(ins.expires_at && ins.expires_at < now())) notifyAI(userId, 'mail:important', { id: m.id, from: m.from_name || m.from_addr, subject: m.subject, summary: ins.summary });
  if (ins.needs_reply && ins.priority >= 50 && now() - m.date < 7 * 864e5 && !ins.draft_reply) enqueue(userId, 'draft', m.id, 35);
  if (ins.priority >= 60 && now() - m.date < 36 * 3600e3) scheduleBriefRefresh(userId);
  const count = get('SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND thread_id = ?', userId, m.thread_id).n;
  if (settings.ai.threadSummaries && count >= 3) enqueue(userId, 'thread', m.thread_id, 30, { force: true });
  await applyRules(userId, [m.id], 'ai');
}

export async function summarizeThreadJob(userId, threadId) {
  const msgs = all('SELECT * FROM messages WHERE user_id = ? AND thread_id = ? ORDER BY date', userId, threadId);
  const unique = [...new Map(msgs.map((m) => [m.message_id, m])).values()];
  if (unique.length < 2) throw skip('single message');
  const cached = get('SELECT * FROM thread_summaries WHERE user_id = ? AND thread_id = ?', userId, threadId);
  if (cached && cached.message_count === unique.length) return cached;
  const { ctx, uiLanguage } = ctxFor(userId);
  const parts = unique.slice(-12).map((m) => P.messageForPrompt(m, 2500));
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
    const when = e.all_day ? day(e.start) : `${new Date(e.start).toString().slice(0, 21)} – ${new Date(e.end).toTimeString().slice(0, 5)}`;
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
  const msgs = all('SELECT * FROM messages WHERE user_id = ? AND thread_id = ? AND date <= ? ORDER BY date DESC LIMIT ?', userId, m.thread_id, m.date, max).reverse();
  return msgs.map((x) => P.messageForPrompt(x, 2500)).join('\n\n---\n\n');
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

registerHandler('analyze', analyzeMessage);
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
  const prompt = P.draftReplyPrompt({ ctx, style: settings.ai.writingStyle, thread: threadText(userId, m), intent, language: replyLanguage(settings), signatureName: acc?.display_name || user.name });
  const res = await chat(userId, task, { ...prompt, temperature: 0.5, maxTokens: 900, onToken });
  return res.text.trim();
}

export async function composeNew(userId, { instruction, to }, onToken) {
  const { ctx, settings, user, uiLanguage } = ctxFor(userId);
  const lang = settings.ai.replyLanguage !== 'auto' ? settings.ai.replyLanguage : `${uiLanguage} (unless the instruction implies another language)`;
  const res = await chat(userId, 'compose', { ...P.composePrompt({ ctx, style: settings.ai.writingStyle, instruction, recipients: to, language: lang, signatureName: user.name }), temperature: 0.6, maxTokens: 1200, onToken });
  const m = res.text.match(/^\s*Subject:\s*(.+)\n+([\s\S]*)$/i);
  return m ? { subject: m[1].trim(), body: m[2].trim() } : { subject: '', body: res.text.trim() };
}

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
  const { ctx } = ctxFor(userId);
  const tz = getSettings(userId).calendar.timezone;
  const { data } = await chatJSON(userId, 'compose', { ...P.extractEventPrompt({ ctx, message: P.messageForPrompt(m, 4000, tz), timezone: tz }), temperature: 0.1, maxTokens: 500 });
  const ev = normalizeEvent(data, tz);
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
  const events = (sc && !sc.calendarIds.length ? [] : listRange(userId, start.getTime(), end.getTime(), sc?.calendarIds)).map((e) => ({ title: e.title, start: new Date(e.start).toString(), end: new Date(e.end).toString(), allDay: e.allDay, location: e.location }));
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
