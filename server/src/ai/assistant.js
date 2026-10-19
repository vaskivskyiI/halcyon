// "Ask your inbox": retrieval-augmented chat over mail, calendar, contacts and tasks.
import { get, all, run, json, now } from '../db/index.js';
import { getSettings } from '../settings.js';
import { chat } from './router.js';
import { askPrompt, stripQuoted, userContext } from './prompts.js';
import { hybridSearch } from '../search.js';
import { listRange, findFreeSlots } from '../calendar/repo.js';
import { userAccounts } from '../accounts.js';

const STOP = new Set('a an the and or but of to in on at for with from by about what which who whom when where why how is are was were be been do does did have has had i me my we our you your it this that these those any some all can could would should will shall may might please tell show find give list email emails mail mails message messages me us last recent recently latest'.split(' '));

function keywords(q) {
  return (q.toLowerCase().match(/[\p{L}\p{N}@.\-]{2,}/gu) || []).filter((w) => !STOP.has(w)).slice(0, 8);
}

async function buildContext(userId, question) {
  const kw = keywords(question);
  let ids = [];
  if (kw.length) {
    // OR-semantics for keyword recall; semantic search catches paraphrases.
    const ors = await Promise.all(kw.slice(0, 4).map((w) => hybridSearch(userId, w, { limit: 6, semantic: false })));
    ids = [...new Set([...(await hybridSearch(userId, question, { limit: 10 })), ...ors.flat()])];
  }
  if (ids.length < 4) ids = [...new Set([...ids, ...all('SELECT id FROM messages WHERE user_id = ? ORDER BY date DESC LIMIT 8', userId).map((r) => r.id)])];
  ids = ids.slice(0, 14);
  const msgs = ids.map((id) => get(`SELECT m.*, i.summary AS ai_summary FROM messages m LEFT JOIN ai_insights i ON i.message_id = m.id WHERE m.id = ?`, id)).filter(Boolean);
  const parts = msgs.map((m) => `[#${m.id}] ${new Date(m.date).toISOString().slice(0, 16)} From: ${m.from_name || ''} <${m.from_addr}> To: ${json(m.to_json, []).map((a) => a.address).join(', ')}
Subject: ${m.subject}
${m.ai_summary ? `Summary: ${m.ai_summary}\n` : ''}${stripQuoted(m.body_text).slice(0, 1200)}`);

  let cal = '';
  if (/calendar|schedule|meeting|event|today|tomorrow|week|free|busy|available|appointment|when|koledar|sestan|termin/i.test(question)) {
    const from = new Date(); from.setHours(0, 0, 0, 0);
    const events = listRange(userId, from.getTime() - 864e5, from.getTime() + 21 * 864e5);
    cal = `\nCALENDAR (next 3 weeks):\n${events.map((e) => `- ${new Date(e.start).toString().slice(0, 21)} → ${new Date(e.end).toTimeString().slice(0, 5)} ${e.title}${e.location ? ` @ ${e.location}` : ''}`).join('\n') || '(no events)'}`;
    if (/free|available|slot|when can/i.test(question)) {
      const slots = findFreeSlots(userId, Date.now(), Date.now() + 10 * 864e5, 30);
      cal += `\nFREE 30-MIN SLOTS (working hours): ${slots.slice(0, 10).map((s) => new Date(s.start).toString().slice(0, 21)).join('; ')}`;
    }
  }
  let tasks = '';
  if (/task|todo|to-do|to do|due|deadline|naloge/i.test(question)) {
    tasks = `\nOPEN TASKS:\n${all('SELECT title, due FROM tasks WHERE user_id = ? AND done = 0 ORDER BY due IS NULL, due LIMIT 30', userId).map((t) => `- ${t.title}${t.due ? ` (due ${new Date(t.due).toDateString()})` : ''}`).join('\n')}`;
  }
  return { text: `EMAILS:\n${parts.join('\n\n')}${cal}${tasks}`, sources: msgs.map((m) => ({ id: m.id, subject: m.subject, from: m.from_name || m.from_addr, date: m.date })) };
}

export async function ask(userId, { chatId, question }, onToken) {
  let chatRow = chatId && get('SELECT * FROM chats WHERE id = ? AND user_id = ?', chatId, userId);
  if (!chatRow) {
    const r = run('INSERT INTO chats (user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)', userId, question.slice(0, 80), now(), now());
    chatRow = get('SELECT * FROM chats WHERE id = ?', r.lastInsertRowid);
  }
  run('INSERT INTO chat_messages (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)', chatRow.id, 'user', question, now());
  const history = all('SELECT role, content FROM chat_messages WHERE chat_id = ? ORDER BY id DESC LIMIT 10', chatRow.id).reverse();
  const { text, sources } = await buildContext(userId, question);
  const user = get('SELECT * FROM users WHERE id = ?', userId);
  const settings = getSettings(userId);
  const prompt = askPrompt({ ctx: userContext(user, settings, userAccounts(userId)), language: 'the user\'s language', context: text, history });
  const res = await chat(userId, 'chat', { ...prompt, temperature: 0.3, maxTokens: 1500, onToken });
  const cited = new Set([...res.text.matchAll(/#(\d+)/g)].map((m) => Number(m[1])));
  const used = sources.filter((s) => cited.has(s.id));
  run('INSERT INTO chat_messages (chat_id, role, content, sources_json, created_at) VALUES (?, ?, ?, ?, ?)', chatRow.id, 'assistant', res.text, JSON.stringify(used), now());
  run('UPDATE chats SET updated_at = ? WHERE id = ?', now(), chatRow.id);
  return { chatId: chatRow.id, answer: res.text, sources: used };
}
