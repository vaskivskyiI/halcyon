// What the AI knows when it writes for the user: the whole relationship with the people involved — not only the
// conversation at hand. Earlier conversations (summaries), the passages of past mail that matter for this email (the
// semantic index, filtered to mail with these people), what is still open between them, facts, upcoming meetings and,
// when time is discussed, free slots. One place for replies, new emails and the check of a draft.
// Budgeted in characters: small local models have short context windows.
import { get, all, json, now } from '../db/index.js';
import { getSettings } from '../settings.js';
import { embedQuery } from '../search.js';
import { searchMemory, memoryText } from './memory.js';
import { scope, spaceMap, inIds } from '../spaces.js';
import { listRange, findFreeSlots } from '../calendar/repo.js';
import { profileText } from './profiles.js';
import { ownAddresses, openReplySql, openActionSql } from './open-items.js';
import { localStamp, stripQuoted } from './prompts.js';

const DAY = 864e5;
const TIME_TALK = /meet|meeting|call|appointment|schedule|when|time|date|available|free|tomorrow|next week|monday|tuesday|wednesday|thursday|friday|sestan|termin|kdaj|jutri|prost|klic/i;
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const lower = (a) => String(a || '').toLowerCase();

/** SQL (alias m): the message involves one of these addresses as sender or recipient, in the accounts of the space. */
function withPeople(people, accountIds = null) {
  return { sql: `(${people.map(() => '(lower(m.from_addr) = ? OR lower(m.to_json) LIKE ? OR lower(m.cc_json) LIKE ?)').join(' OR ')}) AND ${inIds('m.account_id', accountIds)}`,
    params: people.flatMap((p) => [p, `%"${p}"%`, `%"${p}"%`]) };
}

/**
 * Earlier conversations with these people, newest first, one line each (its summary when there is one), and how
 * long and how much they have written — so a reply does not ask again what was settled or contradict what was said.
 */
function history(userId, people, { threadId, tz, own, budget, accountIds = null }) {
  const w = withPeople(people, accountIds);
  const stats = get(`SELECT COUNT(*) AS n, MIN(m.date) AS first FROM messages m WHERE m.user_id = ? AND m.is_draft = 0 AND ${w.sql}`, userId, ...w.params);
  if (!stats?.n) return '';
  const rows = all(`SELECT m.thread_id AS t, MAX(m.date) AS last, MIN(m.date) AS first, COUNT(*) AS n, MAX(m.subject) AS subject,
      SUM(lower(m.from_addr) IN (${[...own].map(() => '?').join(',') || "''"})) AS mine
    FROM messages m WHERE m.user_id = ? AND m.is_draft = 0 AND COALESCE(m.thread_id, '') != ? AND ${w.sql}
    GROUP BY COALESCE(m.thread_id, m.id) ORDER BY last DESC LIMIT 14`, ...own, userId, threadId || '', ...w.params);
  const lines = [];
  let used = 0;
  for (const r of rows) {
    const sum = r.t && get('SELECT summary FROM thread_summaries WHERE user_id = ? AND thread_id = ?', userId, r.t)?.summary;
    // Without a conversation summary: what the newest message of it says (its analysis, else its start).
    const last = sum ? null : get(`SELECT m.from_addr, m.body_text, i.summary FROM messages m LEFT JOIN ai_insights i ON i.message_id = m.id
      WHERE m.user_id = ? AND COALESCE(m.thread_id, m.id) = COALESCE(?, m.id) AND m.date = ? LIMIT 1`, userId, r.t, r.last);
    const what = sum || (last && `${own.has(lower(last.from_addr)) ? 'the user wrote' : 'they wrote'}: ${last.summary || stripQuoted(last.body_text)}`) || '';
    const line = `- ${localStamp(r.last, tz).slice(4, 14)} · ${clip(r.subject, 80)} (${r.n} email${r.n === 1 ? '' : 's'}${r.mine ? `, ${r.mine} by the user` : ''}) — ${clip(what, 260)}`;
    if (used + line.length > budget) break;
    lines.push(line); used += line.length;
  }
  return `${stats.n} emails since ${localStamp(stats.first, tz).slice(4, 14)}.${lines.length ? `\nEarlier conversations (newest first):\n${lines.join('\n')}` : ''}`;
}

/** What is still open between the user and these people (in other conversations too), and meetings with them. */
function openBetween(userId, people, { tz, own, threadId, accountIds = null }) {
  const w = withPeople(people, accountIds);
  const t = now();
  const out = [];
  const theirs = all(`SELECT m.id, m.date, m.subject, i.action_summary, i.summary, i.needs_action FROM messages m JOIN ai_insights i ON i.message_id = m.id
    WHERE m.user_id = ? AND COALESCE(m.thread_id, '') != ? AND ${w.sql} AND (${openReplySql(userId)} OR ${openActionSql(userId)}) ORDER BY m.date DESC LIMIT 4`, userId, threadId || '', ...w.params);
  for (const r of theirs) out.push(`- They are waiting for the user (${localStamp(r.date, tz).slice(4, 14)}, "${clip(r.subject, 60)}"): ${clip(r.action_summary || r.summary, 160)}`);
  const mine = all(`SELECT m.date, m.subject, i.summary FROM messages m JOIN ai_insights i ON i.message_id = m.id
    WHERE m.user_id = ? AND i.expects_reply = 1 AND i.dismissed_at IS NULL AND m.date > ? AND lower(m.from_addr) IN (${[...own].map(() => '?').join(',') || "''"}) AND ${w.sql}
      AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.user_id = m.user_id AND r.thread_id = m.thread_id AND r.date > m.date AND lower(r.from_addr) != lower(m.from_addr))
    ORDER BY m.date DESC LIMIT 3`, userId, t - 30 * DAY, ...own, ...w.params);
  for (const r of mine) out.push(`- The user is waiting for their answer (${localStamp(r.date, tz).slice(4, 14)}, "${clip(r.subject, 60)}"): ${clip(r.summary, 160)}`);
  const tasks = all(`SELECT t.title, t.due FROM tasks t JOIN messages m ON m.id = t.source_message_id WHERE t.user_id = ? AND t.done = 0 AND ${w.sql} LIMIT 4`, userId, ...w.params);
  for (const r of tasks) out.push(`- Open task of the user: ${clip(r.title, 120)}${r.due ? ` (due ${localStamp(r.due, tz).slice(4, 14)})` : ''}`);
  const events = all(`SELECT e.title, e.start, e.all_day FROM events e JOIN calendars c ON c.id = e.calendar_id WHERE c.user_id = ? AND e.deleted = 0 AND e.start BETWEEN ? AND ?
    AND (${people.map(() => 'lower(e.attendees_json) LIKE ? OR lower(e.organizer_json) LIKE ?').join(' OR ')}) ORDER BY e.start LIMIT 4`,
  userId, t - 14 * DAY, t + 60 * DAY, ...people.flatMap((p) => [`%${p}%`, `%${p}%`]));
  for (const e of events) out.push(`- ${e.start < t ? 'Recent' : 'Upcoming'} meeting with them: ${clip(e.title, 100)} — ${e.all_day ? localStamp(e.start, tz).slice(0, 14) : localStamp(e.start, tz)}`);
  return out.join('\n');
}

/**
 * Passages of past mail that matter for what is being written (by meaning: "the quote we agreed on", "the dates
 * they proposed"), only from mail with these people and outside the current conversation; and remembered facts.
 */
async function recall(userId, people, { query, threadId, sc, tz, own, budget, interactive = true }) {
  if (!query) return { passages: '', facts: '' };
  const q = await embedQuery(userId, query.slice(0, 2000), { timeoutMs: interactive ? 8000 : 30000, interactive });
  if (!q) return { passages: '', facts: '' };
  const hits = searchMemory(userId, q.vector, q.model, { k: 300, owners: sc?.owners || null, kinds: new Set(['message', 'thread', 'fact']), minScore: 0.15 });
  const w = withPeople(people, sc?.accountIds);
  const msgIds = [...new Set(hits.filter((h) => h.kind === 'message').map((h) => Number(h.ref)))];
  const ok = new Map(msgIds.length && people.length ? all(`SELECT m.id, m.date, m.from_addr, m.subject, m.thread_id FROM messages m WHERE m.id IN (${msgIds.join(',')}) AND m.user_id = ?
    AND COALESCE(m.thread_id, '') != ? AND ${w.sql}`, userId, threadId || '', ...w.params).map((r) => [r.id, r]) : []);
  const best = [];
  for (const h of hits) {
    if (h.kind !== 'message' || !ok.has(Number(h.ref)) || best.some((b) => b.ref === h.ref)) continue;
    best.push(h);
    if (best.length >= 5) break;
  }
  const texts = memoryText(best.map((h) => h.id));
  let used = 0;
  const passages = [];
  for (const h of best) {
    const m = ok.get(Number(h.ref));
    const body = String(texts.get(h.id) || '').split('\n\n').slice(1).join('\n\n') || texts.get(h.id);
    const line = `[${localStamp(m.date, tz).slice(4, 14)}] ${own.has(lower(m.from_addr)) ? 'The user wrote' : `${m.from_addr} wrote`} ("${clip(m.subject, 60)}"):\n${clip(body, 700)}`;
    if (used + line.length > budget) break;
    passages.push(line); used += line.length;
  }
  const owners = sc ? [...sc.owners] : null;
  const ownerIn = owners ? `owner IN (${owners.map(() => '?').join(',')})` : '1';
  const factRows = [
    ...all(`SELECT id, text, created_at FROM facts WHERE user_id = ? AND origin = 'user' AND ${ownerIn} ORDER BY created_at DESC LIMIT 8`, userId, ...(owners || [])),
    ...hits.filter((h) => h.kind === 'fact').slice(0, 6).map((h) => get('SELECT id, text, created_at FROM facts WHERE id = ? AND user_id = ?', Number(h.ref), userId)).filter(Boolean),
  ];
  const seen = new Set();
  const facts = factRows.filter((f) => !seen.has(f.id) && seen.add(f.id)).slice(0, 10).map((f) => `- ${clip(f.text, 200)} (noted ${localStamp(f.created_at, tz).slice(4, 14)})`).join('\n');
  return { passages: passages.join('\n\n'), facts };
}

/**
 * Context for writing to `people` (addresses), as prompt text. query: what is being written about (the email being
 * answered, the user's instruction); threadId: the conversation already given in full (left out here).
 */
export async function writingContext(userId, { people = [], query = '', threadId = null, accountId = null, budget = 7000, interactive = true } = {}) {
  const own = ownAddresses(userId);
  const ppl = [...new Set(people.map(lower).filter((p) => p.includes('@') && !own.has(p)))].slice(0, 4);
  const tz = getSettings(userId).calendar.timezone;
  const space = accountId ? spaceMap(userId).accounts.get(Number(accountId)) || '' : '';
  const sc = space ? scope(userId, space) : null;
  const profiles = ppl.map((p) => profileText(userId, p, { writing: true })).filter(Boolean);
  const hist = ppl.length ? ppl.map((p) => { const h = history(userId, [p], { threadId, tz, own, budget: Math.floor(budget * 0.35 / ppl.length), accountIds: sc?.accountIds }); return h && `With ${p}: ${h}`; }).filter(Boolean) : [];
  const open = ppl.length ? openBetween(userId, ppl, { tz, own, threadId, accountIds: sc?.accountIds }) : '';
  const { passages, facts } = await recall(userId, ppl, { query, threadId, sc, tz, own, budget: Math.floor(budget * 0.35), interactive }).catch(() => ({ passages: '', facts: '' }));
  let cal = '';
  if (TIME_TALK.test(query)) {
    const t = now();
    const busy = listRange(userId, t, t + 10 * DAY, null, { includeInfo: false }).filter((e) => e.showAs !== 'free').slice(0, 12);
    const slots = findFreeSlots(userId, t, t + 10 * DAY, 30).slice(0, 8);
    cal = `${busy.length ? `Busy:\n${busy.map((e) => `- ${e.allDay ? `${localStamp(e.start, tz).slice(0, 14)} all day` : `${localStamp(e.start, tz)}–${localStamp(e.end, tz).slice(-5)}`} ${clip(e.title, 60)}`).join('\n')}\n` : ''}Free 30-minute slots (working hours): ${slots.map((s) => localStamp(s.start, tz)).join('; ') || 'none found'}`;
  }
  return [
    profiles.length && `WHO THEY ARE (from the user's mail; the user's own notes are authoritative):\n${profiles.map((p) => `- ${p}`).join('\n')}`,
    hist.length && `HISTORY WITH THEM:\n${hist.join('\n')}`,
    open && `STILL OPEN BETWEEN THEM AND THE USER:\n${open}`,
    passages && `RELEVANT PASSAGES FROM EARLIER MAIL WITH THEM:\n${passages}`,
    facts && `FACTS THE USER'S MAIL ESTABLISHED (with when they were noted):\n${facts}`,
    cal && `THE USER'S CALENDAR (next 10 days):\n${cal}`,
  ].filter(Boolean).join('\n\n');
}

/** The history with each of these people, for the assistant (questions that name someone). */
export function historyWith(userId, people, { budget = 2400, sc = null } = {}) {
  const own = ownAddresses(userId);
  const tz = getSettings(userId).calendar.timezone;
  const ppl = [...new Set(people.map(lower))].filter((p) => !own.has(p)).slice(0, 3);
  return ppl.map((p) => { const h = history(userId, [p], { threadId: null, tz, own, budget: Math.floor(budget / ppl.length), accountIds: sc?.accountIds }); return h && `With ${p}: ${h}`; }).filter(Boolean).join('\n');
}

/** Addresses a reply goes to (sender / Reply-To, then the others of the conversation for a reply to all). */
export function replyPeople(m) {
  const first = json(m.reply_to_json, [])[0]?.address || m.from_addr;
  return [first, ...json(m.to_json, []).map((a) => a.address), ...json(m.cc_json, []).map((a) => a.address)].filter(Boolean);
}
