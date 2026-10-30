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
import { scope, reqSpace, inIds, cleanSpace, spaceMap } from '../spaces.js';
import { ensureTaskLists, defaultTaskList, cleanRule, completeOccurrence, newTaskUid } from '../calendar/todos.js';
import { syncDav } from '../scheduler.js';
import { originOf } from './spaces.js';

// Task changes also refresh the AI overview of the daily brief (debounced there).
const notify = (userId, type, payload) => { notifyRaw(userId, type, payload); if (type === 'tasks:changed') scheduleBriefRefresh(userId); };

const out = (t) => ({ id: t.id, title: t.title, notes: t.notes, due: t.due, dueAllDay: !!t.due_all_day, priority: t.priority, done: !!t.done, completedAt: t.completed_at,
  list: t.list_name || t.list, listId: t.list_id, rrule: t.rrule || null, readonly: !!t.list_readonly, sourceMessageId: t.source_message_id, createdAt: t.created_at });
const one = (id) => get('SELECT t.*, l.name AS list_name, l.readonly AS list_readonly FROM tasks t LEFT JOIN task_lists l ON l.id = t.list_id WHERE t.id = ?', id);
const listOut = (l, m) => ({ id: l.id, name: l.name, color: l.color, source: l.source, accountId: l.account_id, readonly: !!l.readonly, isDefault: !!l.is_default,
  space: m.taskLists.get(l.id) ?? '', syncError: l.sync_error || null, open: l.open || 0, total: l.total, origin: originOf(l), hidden: !!l.hidden });

/** A change in a synced list goes to the server at once (in the background; a refusal shows in the problems panel). */
function pushList(listId) {
  const l = get('SELECT account_id, source FROM task_lists WHERE id = ?', listId);
  const a = l?.source === 'caldav' && l.account_id && get('SELECT * FROM accounts WHERE id = ?', l.account_id);
  if (!a?.caldav_url) return;
  // A sync already running may have started before this change: then once more after it.
  syncDav(a).then(() => { if (get('SELECT 1 FROM tasks WHERE list_id = ? AND dirty = 1 UNION ALL SELECT 1 FROM task_deletions WHERE list_id = ?', listId, listId)) syncDav(a); }).catch(() => {});
}
const isDav = (listId) => !!get("SELECT 1 FROM task_lists WHERE id = ? AND source = 'caldav'", listId);
/** A list of the user that tasks can be written to, or null. */
const writableList = (userId, id) => (id ? get('SELECT * FROM task_lists WHERE id = ? AND user_id = ? AND readonly = 0', Number(id), userId) : null);

/**
 * Ticking or unticking a task from outside the app (MCP), as the tick in Tasks does. Returns the task as it is now:
 * a repeating task stays open on its next date, the completed occurrence being a new task (`completedId`).
 */
export function setTaskDone(userId, id, done) {
  const t = one(id);
  if (!t || t.user_id !== userId) return null;
  if (t.list_readonly) throw new Error('This task list is read-only');
  run('UPDATE tasks SET done = ?, completed_at = ?, dirty = ?, updated_at = ? WHERE id = ?', done ? 1 : 0, done ? (t.completed_at || now()) : null, isDav(t.list_id) ? 1 : t.dirty || 0, now(), t.id);
  const completedId = done && !t.done && t.rrule ? completeOccurrence(one(t.id), getSettings(userId).calendar.timezone) : null;
  notify(userId, 'tasks:changed', {});
  pushList(t.list_id);
  return { ...one(t.id), completedId };
}

export default async function taskRoutes(app) {
  app.addHook('preHandler', requireUser);

  // ---- lists (each in a space, like calendars; synced ones come from an account's CalDAV server)
  // ?all=1: every list of every space, hidden ones too, with all its tasks counted (Settings → Calendars & tasks).
  app.get('/api/task-lists', async (req) => {
    ensureTaskLists(req.user.id);
    const every = req.query.all === '1';
    const sc = every ? null : scope(req.user.id, reqSpace(req)), m = spaceMap(req.user.id);
    return all(`SELECT l.*, a.email, (SELECT COUNT(*) FROM tasks t WHERE t.list_id = l.id AND t.done = 0) AS open, (SELECT COUNT(*) FROM tasks t WHERE t.list_id = l.id) AS total
      FROM task_lists l LEFT JOIN accounts a ON a.id = l.account_id
      WHERE l.user_id = ? AND ${inIds('l.id', sc?.taskListIds)} ${every ? '' : 'AND COALESCE(l.hidden, 0) = 0'}
      ORDER BY l.is_default DESC, l.name`, req.user.id).map((l) => listOut(l, m));
  });
  app.post('/api/task-lists', async (req, reply) => {
    const name = String(req.body?.name || '').trim().slice(0, 80);
    if (!name) return httpError(reply, 400, 'Name required');
    const space = req.body?.space !== undefined ? cleanSpace(req.body.space) : reqSpace(req);
    const r = run("INSERT INTO task_lists (user_id, name, color, source, space, created_at) VALUES (?, ?, ?, 'local', ?, ?)", req.user.id, name, req.body?.color || '#10b981', space, now());
    notify(req.user.id, 'tasks:changed', {});
    return listOut(get('SELECT * FROM task_lists WHERE id = ?', r.lastInsertRowid), spaceMap(req.user.id));
  });
  app.patch('/api/task-lists/:id', async (req, reply) => {
    const l = get('SELECT * FROM task_lists WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!l) return httpError(reply, 404, 'Not found');
    const b = req.body || {};
    if (b.hidden !== undefined) {
      if (b.hidden && l.is_default) {
        const next = get('SELECT id FROM task_lists WHERE user_id = ? AND id != ? AND readonly = 0 AND COALESCE(hidden, 0) = 0 ORDER BY id LIMIT 1', req.user.id, l.id);
        if (!next) return httpError(reply, 400, 'This is your only task list — it cannot be hidden');
        run('UPDATE task_lists SET is_default = 0 WHERE id = ?', l.id);
        run('UPDATE task_lists SET is_default = 1 WHERE id = ?', next.id);
      }
      run('UPDATE task_lists SET hidden = ? WHERE id = ?', b.hidden ? 1 : 0, l.id);
    }
    if (b.isDefault) {
      if (l.readonly) return httpError(reply, 400, 'A read-only list cannot be the default');
      run('UPDATE task_lists SET is_default = 0 WHERE user_id = ?', req.user.id);
      run('UPDATE task_lists SET is_default = 1, hidden = 0 WHERE id = ?', l.id);
    }
    run('UPDATE task_lists SET name = COALESCE(?, name), color = COALESCE(?, color) WHERE id = ?', b.name ? String(b.name).trim().slice(0, 80) : null, b.color || null, l.id);
    notify(req.user.id, 'tasks:changed', {});
    return listOut(get('SELECT * FROM task_lists WHERE id = ?', l.id), spaceMap(req.user.id));
  });
  // Tasks of a list kept in Halcyon moved into another list (e.g. a synced one, so they go to its server). A task the
  // target already has (same UID) is skipped; nothing is deleted.
  app.post('/api/task-lists/:id/move-tasks', async (req, reply) => {
    const from = get('SELECT * FROM task_lists WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    const to = writableList(req.user.id, req.body?.to);
    if (!from || !to || to.id === from.id) return httpError(reply, 404, 'Not found');
    if (from.source !== 'local') return httpError(reply, 400, 'Only tasks of a list kept in Halcyon can be moved');
    ensureTaskLists(req.user.id);
    const there = new Set(all('SELECT uid FROM tasks WHERE list_id = ?', to.id).map((r) => r.uid));
    const rows = all('SELECT id, uid FROM tasks WHERE list_id = ?', from.id);
    const move = rows.filter((t) => !there.has(t.uid));
    for (const t of move) run('UPDATE tasks SET list_id = ?, list = ?, href = NULL, etag = NULL, dirty = ?, updated_at = ? WHERE id = ?', to.id, to.name, to.source === 'caldav' ? 1 : 0, now(), t.id);
    notify(req.user.id, 'tasks:changed', {});
    pushList(to.id);
    return { moved: move.length, skipped: rows.length - move.length };
  });

  // Only lists kept in Halcyon are deleted here (with their tasks); a synced one goes with its account's calendar service.
  app.delete('/api/task-lists/:id', async (req, reply) => {
    const l = get('SELECT * FROM task_lists WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!l) return httpError(reply, 404, 'Not found');
    // One from a server is only hidden (it would come back with the next sync; it stays on the server).
    const next = get('SELECT id FROM task_lists WHERE user_id = ? AND id != ? AND readonly = 0 ORDER BY COALESCE(hidden, 0), id LIMIT 1', req.user.id, l.id);
    if (!next) return httpError(reply, 400, 'This is your only task list');
    if (l.source !== 'local') {
      run('UPDATE task_lists SET hidden = 1, is_default = 0 WHERE id = ?', l.id);
      if (l.is_default) run('UPDATE task_lists SET is_default = 1, hidden = 0 WHERE id = ?', next.id);
      notify(req.user.id, 'tasks:changed', {});
      return { ok: true, hidden: true };
    }
    run('DELETE FROM tasks WHERE list_id = ?', l.id);
    run('DELETE FROM task_lists WHERE id = ?', l.id);
    if (l.is_default) run('UPDATE task_lists SET is_default = 1, hidden = 0 WHERE id = ?', next.id);
    ensureTaskLists(req.user.id);
    notify(req.user.id, 'tasks:changed', {});
    return { ok: true };
  });

  // ---- tasks: those of the active space (all spaces when none is chosen), optionally of one list
  app.get('/api/tasks', async (req) => {
    ensureTaskLists(req.user.id);
    const sc = scope(req.user.id, reqSpace(req));
    const showDone = req.query.done === '1';
    const listId = Number(req.query.listId) || null;
    return all(`SELECT t.*, l.name AS list_name, l.readonly AS list_readonly FROM tasks t JOIN task_lists l ON l.id = t.list_id
      WHERE t.user_id = ? AND COALESCE(l.hidden, 0) = 0 AND ${inIds('t.list_id', sc?.taskListIds)} ${listId ? 'AND t.list_id = ?' : ''} ${showDone ? '' : 'AND (t.done = 0 OR t.completed_at > ?)'}
      ORDER BY t.done, t.due IS NULL, t.due, t.priority DESC, t.id DESC`, req.user.id, ...(listId ? [listId] : []), ...(showDone ? [] : [now() - 864e5])).map(out);
  });

  // Preview while typing: what the rules understand ("tomorrow at 10", "v petek") — instant, no AI.
  app.post('/api/tasks/parse', async (req) => {
    const r = parseDue(req.body?.text, getSettings(req.user.id).calendar.timezone);
    return { title: r.title, due: r.due, source: r.due ? 'rules' : null };
  });

  // b.text: plain-language task ("send the report to Ana on Tuesday"): title and due date are extracted by rules,
  // with the AI as fallback when the text seems to mention a time the rules did not understand. b.listId: the list
  // (else the default of the active space); b.rrule: repeat rule.
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
    const rrule = cleanRule(b.rrule);
    if (rrule === false) return httpError(reply, 400, 'Repeat rule not understood');
    ensureTaskLists(req.user.id);
    const list = b.listId ? writableList(req.user.id, b.listId) : defaultTaskList(req.user.id, reqSpace(req));
    if (!list) return httpError(reply, 400, 'Tasks cannot be added to that list');
    const r = run(`INSERT INTO tasks (user_id, list_id, title, notes, due, due_tz, due_all_day, priority, list, rrule, uid, dirty, source_message_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, req.user.id, list.id, b.title.trim(), b.notes || '', b.due || null, dueTz, b.dueAllDay ? 1 : 0, b.priority || 0, list.name,
    rrule, newTaskUid(), list.source === 'caldav' ? 1 : 0, b.sourceMessageId || null, now(), now());
    notify(req.user.id, 'tasks:changed', {});
    pushList(list.id);
    return out(one(r.lastInsertRowid));
  });

  app.patch('/api/tasks/:id', async (req, reply) => {
    const t = one(req.params.id);
    if (!t || t.user_id !== req.user.id) return httpError(reply, 404, 'Not found');
    if (t.list_readonly) return httpError(reply, 403, 'This task list is read-only');
    const b = req.body || {};
    const rrule = b.rrule !== undefined ? cleanRule(b.rrule) : t.rrule;
    if (rrule === false) return httpError(reply, 400, 'Repeat rule not understood');
    // Moved to another list: it leaves the old one (also on its server) and is saved new in the other.
    let listId = t.list_id;
    if (b.listId && Number(b.listId) !== t.list_id) {
      const to = writableList(req.user.id, b.listId);
      if (!to) return httpError(reply, 400, 'Tasks cannot be moved to that list');
      if (t.href) run('INSERT INTO task_deletions (list_id, href, etag) VALUES (?, ?, ?)', t.list_id, t.href, t.etag);
      run('UPDATE tasks SET list_id = ?, list = ?, href = NULL, etag = NULL WHERE id = ?', to.id, to.name, t.id);
      pushList(t.list_id);
      listId = to.id;
    }
    // A due time set here was picked by the user (absolute): no longer tied to the zone the server read it in.
    run(`UPDATE tasks SET title = ?, notes = ?, due = ?, due_tz = ?, due_all_day = ?, priority = ?, rrule = ?, done = ?, completed_at = ?, dirty = ?, updated_at = ? WHERE id = ?`,
      b.title ?? t.title, b.notes ?? t.notes, b.due !== undefined ? b.due : t.due, b.due !== undefined ? null : t.due_tz,
      b.dueAllDay !== undefined ? (b.dueAllDay ? 1 : 0) : b.due !== undefined ? 0 : t.due_all_day, b.priority ?? t.priority, rrule,
      b.done !== undefined ? (b.done ? 1 : 0) : t.done, b.done ? (t.completed_at || now()) : (b.done === false ? null : t.completed_at), isDav(listId) ? 1 : 0, now(), t.id);
    // A repeating task done: this occurrence is kept as completed and the task moves on to its next date.
    let completed = null;
    if (b.done && !t.done && rrule) completed = completeOccurrence(one(t.id), getSettings(req.user.id).calendar.timezone);
    notify(req.user.id, 'tasks:changed', {});
    pushList(listId);
    return { ...out(one(t.id)), ...(completed ? { completedCopy: out(one(completed)) } : {}) };
  });

  app.delete('/api/tasks/:id', async (req, reply) => {
    const t = one(req.params.id);
    if (!t || t.user_id !== req.user.id) return { ok: true };
    if (t.list_readonly) return httpError(reply, 403, 'This task list is read-only');
    if (t.href) run('INSERT INTO task_deletions (list_id, href, etag) VALUES (?, ?, ?)', t.list_id, t.href, t.etag);
    run('DELETE FROM tasks WHERE id = ? AND user_id = ?', t.id, req.user.id);
    notify(req.user.id, 'tasks:changed', {});
    pushList(t.list_id);
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
    // Into the list chosen, else the default list of the space the email's account is in.
    ensureTaskLists(req.user.id);
    const acc = get('SELECT account_id FROM messages WHERE id = ?', p.messageId)?.account_id;
    const list = writableList(req.user.id, req.body?.listId) || defaultTaskList(req.user.id, spaceMap(req.user.id).accounts.get(acc) || reqSpace(req));
    const created = [];
    for (const it of items) {
      // Older clients send the raw AI items ({ text, due: 'YYYY-MM-DD' }).
      const t = it.title ? it : p.items.find((x) => x.text === it.text) || { title: it.text, notes: p.context, due: null };
      if (!String(t.title || '').trim()) continue;
      // Due as read from the email (unchanged in the dialog) is tied to the zone it was read in.
      const due = Number(t.due) || null;
      const read = due && p.items.some((x) => x.due === due) ? p.tz : null;
      const rrule = due ? cleanRule(t.rrule) || null : null; // repeats from the due date; not understood = once
      const r = run(`INSERT INTO tasks (user_id, list_id, list, uid, dirty, title, notes, due, due_tz, priority, rrule, source_message_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, req.user.id, list.id, list.name, newTaskUid(), list.source === 'caldav' ? 1 : 0,
      String(t.title).trim().slice(0, 300), String(t.notes ?? p.context).slice(0, 4000), due, read, t.priority ? 1 : 0, rrule, p.messageId, now(), now());
      created.push(out(one(r.lastInsertRowid)));
    }
    notify(req.user.id, 'tasks:changed', {});
    pushList(list.id);
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
