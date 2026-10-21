// "Ask your inbox": retrieval-augmented chat over the AI memory (email chunks, conversation summaries, events,
// contacts, facts) plus keyword search, calendar and tasks. A chat is bound to the space it was started in and
// only ever retrieves data visible in that space.
import { get, all, run, json, now } from '../db/index.js';
import { getSettings } from '../settings.js';
import { chat } from './router.js';
import { askPrompt, stripQuoted, userContext, localStamp } from './prompts.js';
import { keywordSearch, embedQuery } from '../search.js';
import { searchMemory, memoryText } from './memory.js';
import { listRange, findFreeSlots } from '../calendar/repo.js';
import { userAccounts } from '../accounts.js';
import { scope, inIds, cleanSpace } from '../spaces.js';
import { rememberFact, briefLive } from './tasks.js';
import { profileText, profilesMentioned } from './profiles.js';

const STOP = new Set('a an the and or but of to in on at for with from by about what which who whom when where why how is are was were be been do does did have has had i me my we our you your it this that these those any some all can could would should will shall may might please tell show find give list email emails mail mails message messages me us last recent recently latest'.split(' '));
const REMEMBER = /^\s*(?:please\s+)?(?:remember|note)(?:\s+that)?\s*[:,]?\s+([\s\S]{4,})$/i;

function keywords(q) {
  return (q.toLowerCase().match(/[\p{L}\p{N}@.\-]{2,}/gu) || []).filter((w) => !STOP.has(w)).slice(0, 8);
}

// Memory chunks start with a header line(s) we print ourselves; keep only the content part.
const chunkBody = (t) => String(t || '').split('\n\n').slice(1).join('\n\n') || String(t || '');

// How far a moment is from now, so the model never has to do date arithmetic ("3 days ago", "in 2 days").
const relDays = (t) => {
  const d = Math.round((t - Date.now()) / 864e5);
  return d === 0 ? (t < Date.now() ? 'earlier today' : 'later today') : d < 0 ? `${-d} day${d === -1 ? '' : 's'} ago` : `in ${d} day${d === 1 ? '' : 's'}`;
};
// "What should I do / what needs attention" is about the current state, not about old mail.
const OPEN_ITEMS_Q = /attention|important|urgent|to-?do|act on|action|reply|respond|pending|open|outstanding|today|tomorrow|this week|need to|should i|upcoming|next|nujn|odgovor|nalog|pomembn|danes|jutri/i;
const PAST_Q = /last (year|month|week)|ago|history|earlier|previous|in 20\d\d|lani|prejšnj|zgodovin/i;

export async function buildContext(userId, question, sc) {
  const tz = getSettings(userId).calendar.timezone;
  const when = (t) => `${localStamp(t, tz)} (${relDays(t)})`;
  const openQ = OPEN_ITEMS_Q.test(question) && !PAST_Q.test(question);
  const accIn = inIds('m.account_id', sc?.accountIds);
  const query = await embedQuery(userId, question);
  // Ranking matters more than absolute scores (embedding models differ in their similarity baseline).
  const hits = query ? searchMemory(userId, query.vector, query.model, { k: 80, owners: sc?.owners || null, minScore: 0.1 }) : [];
  const byKind = (k) => hits.filter((h) => h.kind === k);

  // Emails: reciprocal-rank fusion of keyword matches and the best semantic chunk per message, weighted by age
  // (for questions about what to do now, mail older than three weeks is left out).
  const kw = keywords(question);
  const kwIds = kw.length ? [...new Set([...keywordSearch(userId, kw.join(' '), { limit: 10, sc }), ...kw.slice(0, 4).flatMap((w) => keywordSearch(userId, w, { limit: 6, sc }))])] : [];
  const bestChunk = new Map();
  for (const h of byKind('message')) if (!bestChunk.has(Number(h.ref))) bestChunk.set(Number(h.ref), h.id);
  const score = new Map();
  kwIds.forEach((id, i) => score.set(id, (score.get(id) || 0) + 1 / (60 + i)));
  [...bestChunk.keys()].forEach((id, i) => score.set(id, (score.get(id) || 0) + 1 / (60 + i)));
  const dateOf = new Map(score.size ? all(`SELECT id, date FROM messages WHERE id IN (${[...score.keys()].map(Number).join(',')})`).map((r) => [r.id, r.date]) : []);
  for (const [id, v] of score) {
    const age = (Date.now() - (dateOf.get(id) || 0)) / 864e5;
    score.set(id, openQ ? (age > 21 ? 0 : v) : age > 365 ? v * 0.6 : v);
  }
  let ids = [...score].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([id]) => id);
  if (ids.length < 4) {
    const recent = all(`SELECT m.id FROM messages m WHERE m.user_id = ? AND ${accIn} AND m.date >= ? ORDER BY m.date DESC LIMIT 8`, userId, openQ ? Date.now() - 21 * 864e5 : 0);
    ids = [...new Set([...ids, ...recent.map((r) => r.id)])];
  }
  const texts = memoryText([...bestChunk.values(), ...hits.filter((h) => h.kind !== 'message').map((h) => h.id)]);
  // The scope check is repeated here: memory hits are only candidates, the database decides what is visible.
  // Small local models have short context windows (often 8k tokens): keep the prompt compact.
  const msgs = ids.map((id) => get(`SELECT m.*, i.summary AS ai_summary FROM messages m LEFT JOIN ai_insights i ON i.message_id = m.id WHERE m.id = ? AND m.user_id = ? AND ${accIn}`, id, userId)).filter(Boolean).slice(0, 8);
  const emailPart = msgs.map((m) => {
    // The matching passage is kept whole (it is what answers the question); otherwise the start of the email.
    const excerpt = bestChunk.has(m.id) && texts.get(bestChunk.get(m.id)) ? chunkBody(texts.get(bestChunk.get(m.id))).slice(0, 1500) : stripQuoted(m.body_text).slice(0, 1000);
    return `[#${m.id}] ${when(m.date)} From: ${m.from_name || ''} <${m.from_addr}> To: ${json(m.to_json, []).map((a) => a.address).join(', ')}${m.is_answered ? ' · the user has replied' : ''}
Subject: ${m.subject}
${m.ai_summary ? `Summary: ${m.ai_summary}\n` : ''}${excerpt}`;
  });

  // Facts: everything the user explicitly asked to remember (in scope) plus the most relevant learned ones, dated.
  const owners = sc ? [...sc.owners] : null;
  const ownerIn = owners ? `owner IN (${owners.map(() => '?').join(',')})` : '1';
  const userFacts = all(`SELECT id, text, created_at FROM facts WHERE user_id = ? AND origin = 'user' AND ${ownerIn} ORDER BY created_at DESC LIMIT 15`, userId, ...(owners || []));
  const factIds = new Set(userFacts.map((f) => f.id));
  const learned = byKind('fact').slice(0, 10).map((h) => get(`SELECT id, text, created_at FROM facts WHERE id = ? AND user_id = ? AND ${ownerIn}`, Number(h.ref), userId, ...(owners || []))).filter((f) => f && !factIds.has(f.id));
  const facts = [...userFacts, ...learned];

  const threads = byKind('thread').slice(0, 4).map((h) => texts.get(h.id)).filter(Boolean);
  // Events found by meaning, labelled past / upcoming from their real date (past ones are dropped for "what's next").
  const events = byKind('event').slice(0, 8).map((h) => {
    const e = get('SELECT start, rrule FROM events WHERE id = ? AND deleted = 0', Number(h.ref));
    if (!e || !texts.get(h.id)) return null;
    const label = e.rrule ? 'REPEATING' : e.start < Date.now() ? `PAST, ${relDays(e.start)}` : `UPCOMING, ${relDays(e.start)}`;
    if (openQ && label.startsWith('PAST')) return null;
    return `[${label}] ${texts.get(h.id)}`;
  }).filter(Boolean).slice(0, 6);
  const contacts = byKind('contact').slice(0, 4).filter((h) => get('SELECT 1 AS x FROM contacts WHERE id = ? AND user_id = ? AND deleted = 0', Number(h.ref), userId)).map((h) => texts.get(h.id)).filter(Boolean);

  let cal = '';
  if (/calendar|schedule|meeting|event|today|tomorrow|week|free|busy|available|appointment|when|koledar|sestan|termin|danes|jutri/i.test(question)) {
    const from = Date.now() - 12 * 3600e3;
    const list = sc && !sc.calendarIds.length ? [] : listRange(userId, from, Date.now() + 21 * 864e5, sc?.calendarIds);
    cal = `\nCALENDAR (from now until 3 weeks ahead):\n${list.map((e) => `- ${e.allDay ? `${localStamp(e.start, tz).slice(0, 14)} all day` : `${when(e.start)} → ${localStamp(e.end, tz).slice(-5)}`}${e.end < Date.now() ? ' [already over]' : ''}${e.showAs === 'info' ? ' [for information only — not the user\'s own commitment]' : e.showAs === 'free' ? ' [does not block time]' : ''} ${e.title}${e.location ? ` @ ${e.location}` : ''}`).join('\n') || '(no events)'}`;
    if (/free|available|slot|when can|prost/i.test(question)) {
      // Busy time counts across all calendars (one person, one schedule); only the free slots are shown.
      const slots = findFreeSlots(userId, Date.now(), Date.now() + 10 * 864e5, 30);
      cal += `\nFREE 30-MIN SLOTS (working hours): ${slots.slice(0, 10).map((s) => localStamp(s.start, tz)).join('; ')}`;
    }
  }
  let tasks = '';
  if (/task|todo|to-do|to do|due|deadline|naloge|rok/i.test(question) && !openQ) {
    const rows = all(`SELECT title, due FROM tasks WHERE user_id = ? AND done = 0 AND (source_message_id IS NULL OR source_message_id IN (SELECT m.id FROM messages m WHERE m.user_id = ? AND ${accIn}))
      ORDER BY due IS NULL, due LIMIT 30`, userId, userId);
    tasks = `\nOPEN TASKS:\n${rows.map((t) => `- ${t.title}${t.due ? ` (due ${when(t.due)}${t.due < Date.now() ? ', OVERDUE' : ''})` : ''}`).join('\n')}`;
  }

  // "What needs my attention?": the current, authoritative state (same as the brief) — not the AI's guess from old mail.
  let open = '';
  if (openQ) {
    const live = briefLive(userId, sc?.space || '');
    const line = (m) => `- [#${m.id}] ${m.from}: ${m.subject} (${relDays(m.date)})${m.summary ? ` — ${m.summary}` : ''}`;
    open = `OPEN ITEMS RIGHT NOW (already filtered: not handled, not expired, recent):
Needs attention:\n${live.attention.map(line).join('\n') || '- none'}
Waiting for the user's reply:\n${live.awaiting.map(line).join('\n') || '- none'}
Action needed (other than replying):\n${live.actions.map((m) => `${line(m)}${m.action ? ` → ${m.action}` : ''}`).join('\n') || '- none'}
Open tasks:\n${live.tasks.map((t) => `- ${t.title}${t.due ? ` (due ${when(t.due)}${t.overdue ? ', OVERDUE' : ''})` : ''}`).join('\n') || '- none'}
Today's events:\n${live.events.map((e) => `- ${e.allDay ? 'all day' : `${localStamp(e.start, tz).slice(-5)}–${localStamp(e.end, tz).slice(-5)}`}${e.end < Date.now() ? ' [over]' : ''} ${e.title}`).join('\n') || '- none'}`;
    for (const m of [...live.attention, ...live.awaiting, ...live.actions]) if (!msgs.some((x) => x.id === m.id)) msgs.push({ id: m.id, subject: m.subject, from_name: m.from, from_addr: '', date: m.date });
  }

  // People: those the question names, then the senders of the emails found — who they are and how the user writes
  // with them (contact profiles, ai/profiles.js).
  const people = [...new Set([...profilesMentioned(userId, question, 3),
    ...[...new Set(msgs.map((m) => m.from_addr).filter(Boolean))].slice(0, 4).map((a) => profileText(userId, a, { writing: true }))].filter(Boolean))].slice(0, 5);

  const sections = [
    open,
    people.length && `PEOPLE (what the user's mail shows about them; the user's own notes are authoritative):\n${people.map((p) => `- ${p}`).join('\n')}`,
    facts.length && `THINGS YOU REMEMBER ABOUT THE USER'S WORLD (with the date they were noted):\n${facts.map((f) => `- ${f.text} (noted ${localStamp(f.created_at, tz).slice(4, 14)})`).join('\n')}`,
    `EMAILS:\n${emailPart.join('\n\n') || '(none found)'}`,
    threads.length && `CONVERSATION SUMMARIES:\n${threads.join('\n\n')}`,
    events.length && `RELATED CALENDAR EVENTS:\n${events.join('\n')}`,
    contacts.length && `RELATED CONTACTS:\n${contacts.join('\n\n')}`,
  ].filter(Boolean);
  return { text: sections.join('\n\n') + cal + tasks, sources: msgs.map((m) => ({ id: m.id, subject: m.subject, from: m.from_name || m.from_addr, date: m.date })) };
}

const FIRST_TOKEN_MS = 90e3;

export async function ask(userId, { chatId, question, space = '' }, onToken, { signal, onStatus } = {}) {
  let chatRow = chatId && get('SELECT * FROM chats WHERE id = ? AND user_id = ?', chatId, userId);
  if (!chatRow) {
    const r = run('INSERT INTO chats (user_id, title, space, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', userId, question.slice(0, 80), cleanSpace(space), now(), now());
    chatRow = get('SELECT * FROM chats WHERE id = ?', r.lastInsertRowid);
  }
  run('INSERT INTO chat_messages (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)', chatRow.id, 'user', question, now());
  const finish = (answer, sources = []) => {
    run('INSERT INTO chat_messages (chat_id, role, content, sources_json, created_at) VALUES (?, ?, ?, ?, ?)', chatRow.id, 'assistant', answer, JSON.stringify(sources), now());
    run('UPDATE chats SET updated_at = ? WHERE id = ?', now(), chatRow.id);
    return { chatId: chatRow.id, answer, sources, space: chatRow.space || '' };
  };

  // "Remember that …" is stored verbatim (no model involved) in the chat's space; it can be reviewed/deleted in Settings.
  const rem = question.match(REMEMBER);
  if (rem && !/\?\s*$/.test(question)) {
    const text = rem[1].trim().replace(/\.$/, '');
    rememberFact(userId, text, chatRow.space || '');
    const answer = `Noted. I'll remember: “${text}”${chatRow.space ? ` (in ${chatRow.space})` : ''}. You can review or delete what I remember in Settings → AI → Memory.`;
    onToken?.(answer);
    return finish(answer);
  }

  const sc = scope(userId, chatRow.space);
  const history = all('SELECT role, content FROM chat_messages WHERE chat_id = ? ORDER BY id DESC LIMIT 10', chatRow.id).reverse();
  onStatus?.('Searching your mail…');
  const { text, sources } = await buildContext(userId, question, sc);
  onStatus?.(`Reading ${sources.length} email${sources.length === 1 ? '' : 's'}…`);
  const user = get('SELECT * FROM users WHERE id = ?', userId);
  const settings = getSettings(userId);
  const accounts = userAccounts(userId).filter((a) => !sc || sc.accountIds.includes(a.id));
  const ctx = userContext(user, settings, accounts) + (sc ? `\nThis conversation is limited to the user's "${sc.space}" space; you only see its mail, calendars and contacts.` : '');
  // A busy or stuck model server must not leave the user staring at a spinner: give up if no answer starts in time.
  const ctl = new AbortController();
  signal?.addEventListener('abort', () => ctl.abort(signal.reason));
  let started = false;
  const timer = setTimeout(() => ctl.abort(new Error('timeout')), FIRST_TOKEN_MS);
  let res;
  try {
    res = await chat(userId, 'chat', { ...askPrompt({ ctx, language: 'the user\'s language', context: text, history }), temperature: 0.3, maxTokens: 1500, signal: ctl.signal,
      onToken: (t) => { if (!started) { started = true; clearTimeout(timer); } onToken?.(t); } });
  } catch (e) {
    if (!started && !signal?.aborted) throw new Error(`The AI model did not start answering within ${FIRST_TOKEN_MS / 1000} s — the AI server is probably busy or unreachable. Try again shortly; background work pauses while you ask.`);
    throw e;
  } finally { clearTimeout(timer); }
  // Every email given to the model is listed so its statements can be checked; the ones it cited come first.
  const cited = new Set([...res.text.matchAll(/#(\d+)/g)].map((m) => Number(m[1])));
  const ordered = [...sources.filter((x) => cited.has(x.id)).map((x) => ({ ...x, cited: true })), ...sources.filter((x) => !cited.has(x.id))].slice(0, 10);
  return finish(res.text, ordered);
}
