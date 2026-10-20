import { get, all, run, now, json } from '../db/index.js';
import { requireUser } from '../auth.js';
import { httpError } from './util.js';
import { notify as notifyRaw } from '../util/events.js';
import { getSettings } from '../settings.js';
import { parseDue, mentionsTime } from '../util/dates.js';
import { aiParseTask } from '../ai/tasks.js';
import { scheduleBriefRefresh } from '../ai/tasks.js';
import { localToEpoch } from '../util/time.js';
import { localStamp } from '../ai/prompts.js';

// Task changes also refresh the AI overview of the daily brief (debounced there).
const notify = (userId, type, payload) => { notifyRaw(userId, type, payload); if (type === 'tasks:changed') scheduleBriefRefresh(userId); };

const out = (t) => ({ id: t.id, title: t.title, notes: t.notes, due: t.due, priority: t.priority, done: !!t.done, completedAt: t.completed_at, list: t.list, sourceMessageId: t.source_message_id, createdAt: t.created_at });

export default async function taskRoutes(app) {
  app.addHook('preHandler', requireUser);

  app.get('/api/tasks', async (req) => {
    const showDone = req.query.done === '1';
    return all(`SELECT * FROM tasks WHERE user_id = ? ${showDone ? '' : 'AND (done = 0 OR completed_at > ?)'} ORDER BY done, due IS NULL, due, priority DESC, id DESC`, req.user.id, ...(showDone ? [] : [now() - 864e5])).map(out);
  });

  // Preview while typing: what the rules understand ("tomorrow at 10", "v petek") — instant, no AI.
  app.post('/api/tasks/parse', async (req) => {
    const r = parseDue(req.body?.text, getSettings(req.user.id).calendar.timezone);
    return { title: r.title, due: r.due, source: r.due ? 'rules' : null };
  });

  // b.text: plain-language task ("send the report to Ana on Tuesday"): title and due date are extracted by rules,
  // with the AI as fallback when the text seems to mention a time the rules did not understand.
  app.post('/api/tasks', async (req, reply) => {
    const b = req.body || {};
    let dueTz = null;
    if (b.text && !b.title) {
      const tz = getSettings(req.user.id).calendar.timezone;
      let parsed = parseDue(b.text, tz);
      if (!parsed.due && b.due == null && mentionsTime(b.text)) parsed = await aiParseTask(req.user.id, b.text, tz).catch(() => parsed);
      b.title = parsed.title;
      if (b.due == null && parsed.due) { b.due = parsed.due; dueTz = tz; }
    }
    if (!b.title?.trim()) return httpError(reply, 400, 'Title required');
    const r = run('INSERT INTO tasks (user_id, title, notes, due, due_tz, priority, list, source_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      req.user.id, b.title.trim(), b.notes || '', b.due || null, dueTz, b.priority || 0, b.list || 'Tasks', b.sourceMessageId || null, now(), now());
    notify(req.user.id, 'tasks:changed', {});
    return out(get('SELECT * FROM tasks WHERE id = ?', r.lastInsertRowid));
  });

  app.patch('/api/tasks/:id', async (req, reply) => {
    const t = get('SELECT * FROM tasks WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!t) return httpError(reply, 404, 'Not found');
    const b = req.body || {};
    // A due time set here was picked by the user (absolute): no longer tied to the zone the server read it in.
    run(`UPDATE tasks SET title = ?, notes = ?, due = ?, due_tz = ?, priority = ?, list = ?, done = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
      b.title ?? t.title, b.notes ?? t.notes, b.due !== undefined ? b.due : t.due, b.due !== undefined ? null : t.due_tz, b.priority ?? t.priority, b.list ?? t.list,
      b.done !== undefined ? (b.done ? 1 : 0) : t.done, b.done ? (t.completed_at || now()) : (b.done === false ? null : t.completed_at), now(), t.id);
    notify(req.user.id, 'tasks:changed', {});
    return out(get('SELECT * FROM tasks WHERE id = ?', t.id));
  });

  app.delete('/api/tasks/:id', async (req) => {
    run('DELETE FROM tasks WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    notify(req.user.id, 'tasks:changed', {});
    return { ok: true };
  });

  // Tasks proposed from a message (AI action items, else a follow-up), with the sender in the title and the context in
  // the body; the web client shows them for editing (title, body, due) before they are created.
  app.get('/api/tasks/from-message/:id', async (req, reply) => {
    const p = proposeTasks(req.user.id, req.params.id);
    return p || httpError(reply, 404, 'Not found');
  });

  // Create tasks from a message: the edited proposals (body.items: [{ title, notes, due }]) or the proposals as they are.
  app.post('/api/tasks/from-message/:id', async (req, reply) => {
    const p = proposeTasks(req.user.id, req.params.id);
    if (!p) return httpError(reply, 404, 'Not found');
    const items = Array.isArray(req.body?.items) && req.body.items.length ? req.body.items : p.items;
    const created = [];
    for (const it of items) {
      // Older clients send the raw AI items ({ text, due: 'YYYY-MM-DD' }).
      const t = it.title ? it : p.items.find((x) => x.text === it.text) || { title: it.text, notes: p.context, due: null };
      if (!String(t.title || '').trim()) continue;
      // Due as read from the email (unchanged in the dialog) is tied to the zone it was read in.
      const due = Number(t.due) || null;
      const read = due && p.items.some((x) => x.due === due) ? p.tz : null;
      const r = run('INSERT INTO tasks (user_id, title, notes, due, due_tz, priority, source_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        req.user.id, String(t.title).trim().slice(0, 300), String(t.notes ?? p.context).slice(0, 4000), due, read, t.priority ? 1 : 0, p.messageId, now(), now());
      created.push(out(get('SELECT * FROM tasks WHERE id = ?', r.lastInsertRowid)));
    }
    notify(req.user.id, 'tasks:changed', {});
    return created;
  });
}

function proposeTasks(userId, id) {
  const m = get(`SELECT m.id, m.subject, m.from_name, m.from_addr, m.to_json, m.date, m.snippet, f.special_use FROM messages m JOIN folders f ON f.id = m.folder_id
    WHERE m.id = ? AND m.user_id = ?`, id, userId);
  if (!m) return null;
  const tz = getSettings(userId).calendar.timezone;
  const ins = get('SELECT summary, action_items_json, action_summary FROM ai_insights WHERE message_id = ?', m.id);
  // Who the task is about: the sender, or for the user's own sent mail the first recipient.
  const sent = m.special_use === '\\Sent';
  const other = sent ? json(m.to_json, [])[0] || {} : { name: m.from_name, address: m.from_addr };
  const who = (other.name || String(other.address || '').split('@')[0] || '').trim();
  const context = [
    `${sent ? 'To' : 'From'}: ${other.name ? `${other.name} <${other.address}>` : other.address || ''}`,
    `Date: ${localStamp(m.date, tz)}`,
    `Subject: ${m.subject || '(no subject)'}`,
    '',
    ins?.summary || m.snippet || '',
  ].join('\n').trim();
  const withWho = (text) => (who && !text.toLowerCase().includes(who.toLowerCase()) ? `${text} (${sent ? 'to ' : ''}${who})` : text);
  const due = (d) => {
    const x = String(d || '').match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}:\d{2}))?/);
    const t = x ? localToEpoch(x[1], x[2] || '17:00', tz) : NaN;
    return Number.isNaN(t) ? null : t;
  };
  const ai = json(ins?.action_items_json, []).filter((a) => a?.text);
  const items = ai.length
    ? ai.map((a) => ({ text: a.text, title: withWho(a.text), notes: context, due: due(a.due) }))
    : [{ text: '', title: withWho(ins?.action_summary || `Follow up: ${m.subject || '(no subject)'}`), notes: context, due: null }];
  return { messageId: m.id, context, items, tz };
}
