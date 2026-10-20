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
  };
}

function saveInsight(messageId, d, model) {
  run(`INSERT OR REPLACE INTO ai_insights (message_id, summary, category, priority, priority_reason, needs_reply, action_items_json,
    suggested_replies_json, events_json, sentiment, language, is_phishing, draft_reply, model, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,(SELECT draft_reply FROM ai_insights WHERE message_id = ?),?,?)`,
    messageId, String(d.summary || '').slice(0, 1000), P.CATEGORIES.includes(d.category) ? d.category : 'other',
    clampInt(d.priority, 0, 100, 30), String(d.priority_reason || '').slice(0, 200), d.needs_reply ? 1 : 0,
    JSON.stringify((Array.isArray(d.action_items) ? d.action_items : []).slice(0, 10).map((a) => (typeof a === 'string' ? { text: a, due: null } : { text: String(a.text || ''), due: a.due || null })).filter((a) => a.text)),
    JSON.stringify((Array.isArray(d.suggested_replies) ? d.suggested_replies : []).slice(0, 3).map(String)),
    JSON.stringify((Array.isArray(d.events) ? d.events : []).filter((e) => e?.start && !Number.isNaN(Date.parse(e.start))).slice(0, 5)),
    ['positive', 'neutral', 'negative', 'urgent'].includes(d.sentiment) ? d.sentiment : 'neutral',
    String(d.language || '').slice(0, 5), d.is_phishing ? 1 : 0, messageId, model, now());
  run("UPDATE messages SET ai_status = 'done' WHERE id = ?", messageId);
}

// ---------- background handlers ----------

export async function analyzeMessage(userId, messageId) {
  const m = get('SELECT * FROM messages WHERE id = ? AND user_id = ?', messageId, userId);
  if (!m) throw skip('message gone');
  // Same message seen in another folder (e.g. Gmail labels) → reuse the analysis.
  const dup = get('SELECT i.* FROM ai_insights i JOIN messages x ON x.id = i.message_id WHERE x.user_id = ? AND x.message_id = ? AND x.id != ? LIMIT 1', userId, m.message_id, m.id);
  let model;
  if (dup) {
    run(`INSERT OR REPLACE INTO ai_insights SELECT ?, summary, category, priority, priority_reason, needs_reply, action_items_json, suggested_replies_json, events_json, sentiment, language, is_phishing, draft_reply, model, created_at FROM ai_insights WHERE message_id = ?`, m.id, dup.message_id);
    run("UPDATE messages SET ai_status = 'done' WHERE id = ?", m.id);
  } else {
    const { ctx, settings, accounts, uiLanguage } = ctxFor(userId);
    const fromMe = accounts.some((a) => a.email.toLowerCase() === m.from_addr);
    const contact = contactByEmail(userId, m.from_addr);
    const senderInfo = fromMe ? 'Sender: the user themself.' : contact
      ? `Sender is a known contact (${contact.contact_count} previous exchanges${contact.favorite ? ', marked as favorite/VIP' : ''}).`
      : 'Sender is not in the user\'s contacts.';
    const prompt = P.analyzePrompt({ ctx, message: P.messageForPrompt(m), senderInfo, language: settings.ai.replyLanguage !== 'auto' ? settings.ai.replyLanguage : uiLanguage });
    const res = await chatJSON(userId, 'background', { ...prompt, temperature: 0.1, maxTokens: 900 });
    model = res.model;
    if (contact?.favorite && res.data.priority < 70) res.data.priority = 70;
    if (fromMe) { res.data.needs_reply = false; res.data.suggested_replies = []; }
    saveInsight(m.id, res.data, model);
    if (settings.ai.embeddings) saveFacts(userId, m, res.data.facts, res.data.category);
  }
  const ins = get('SELECT * FROM ai_insights WHERE message_id = ?', m.id);
  notifyAI(userId, 'ai:insight', { messageId: m.id, threadId: m.thread_id, insight: serializeInsight(ins) });
  const settings = getSettings(userId);
  if (ins.priority >= 80 && !m.is_read && now() - m.date < 864e5) notifyAI(userId, 'mail:important', { id: m.id, from: m.from_name || m.from_addr, subject: m.subject, summary: ins.summary });
  if (ins.needs_reply && ins.priority >= 50 && now() - m.date < 7 * 864e5 && !ins.draft_reply) enqueue(userId, 'draft', m.id, 35);
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
    for (let i = 0; i < texts.length; i += 64) {
      const res = await embed(userId, texts.slice(i, i + 64));
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
    await analyzeMessage(userId, messageId);
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
  const { data } = await chatJSON(userId, 'compose', { ...P.extractEventPrompt({ ctx, message: P.messageForPrompt(m, 4000) }), temperature: 0.1, maxTokens: 500 });
  const start = Date.parse(data.start);
  const end = Date.parse(data.end) || (start + 3600e3);
  return {
    title: data.title || m.subject, start: Number.isNaN(start) ? null : start, end, allDay: !!data.all_day, location: data.location || '',
    description: data.description || '', attendees: (data.attendees || []).filter((x) => typeof x === 'string' && x.includes('@')).map((email) => ({ email, name: '', status: 'needs-action' })),
    sourceMessageId: m.id,
  };
}

export async function dailyBrief(userId, { day, force = false, space = '' } = {}) {
  const today = day || new Date().toISOString().slice(0, 10);
  const sc = scope(userId, space);
  const key = sc ? `${today}@${sc.space}` : today; // one brief per day and space
  const cached = get('SELECT * FROM briefs WHERE user_id = ? AND day = ?', userId, key);
  if (cached && !force) return { day: today, space: sc?.space || '', content: cached.content_json, createdAt: cached.created_at, model: cached.model };
  const { ctx, uiLanguage } = ctxFor(userId);
  const accIn = inIds('m.account_id', sc?.accountIds);
  const since = now() - 36 * 3600e3;
  const important = all(`SELECT m.id, m.from_name, m.from_addr, m.subject, m.date, m.is_read, i.summary, i.priority, i.needs_reply, i.action_items_json
    FROM messages m JOIN folders f ON f.id = m.folder_id LEFT JOIN ai_insights i ON i.message_id = m.id
    WHERE m.user_id = ? AND ${accIn} AND f.special_use = '\\Inbox' AND m.date >= ? AND m.snoozed_until IS NULL
    ORDER BY COALESCE(i.priority, 40) DESC, m.date DESC LIMIT 25`, userId, since);
  const awaiting = all(`SELECT m.id, m.from_name, m.from_addr, m.subject, m.date, i.summary FROM messages m JOIN ai_insights i ON i.message_id = m.id
    WHERE m.user_id = ? AND ${accIn} AND i.needs_reply = 1 AND m.is_answered = 0 AND m.date >= ? ORDER BY i.priority DESC LIMIT 10`, userId, now() - 7 * 864e5);
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
  const res = await chat(userId, 'background', { ...P.briefPrompt({ ctx, language: uiLanguage, data }), temperature: 0.3, maxTokens: 1200 });
  run('INSERT OR REPLACE INTO briefs (user_id, day, content_json, model, created_at) VALUES (?, ?, ?, ?, ?)', userId, key, res.text.trim(), res.model, now());
  notifyAI(userId, 'ai:brief', { day: today, space: sc?.space || '' });
  return { day: today, space: sc?.space || '', content: res.text.trim(), createdAt: now(), model: res.model };
}
