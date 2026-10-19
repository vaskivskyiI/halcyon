import { get, all, run, now, json } from '../db/index.js';
import { requireUser } from '../auth.js';
import { httpError } from './util.js';
import { notify } from '../util/events.js';

const out = (t) => ({ id: t.id, title: t.title, notes: t.notes, due: t.due, priority: t.priority, done: !!t.done, completedAt: t.completed_at, list: t.list, sourceMessageId: t.source_message_id, createdAt: t.created_at });

export default async function taskRoutes(app) {
  app.addHook('preHandler', requireUser);

  app.get('/api/tasks', async (req) => {
    const showDone = req.query.done === '1';
    return all(`SELECT * FROM tasks WHERE user_id = ? ${showDone ? '' : 'AND (done = 0 OR completed_at > ?)'} ORDER BY done, due IS NULL, due, priority DESC, id DESC`, req.user.id, ...(showDone ? [] : [now() - 864e5])).map(out);
  });

  app.post('/api/tasks', async (req, reply) => {
    const b = req.body || {};
    if (!b.title?.trim()) return httpError(reply, 400, 'Title required');
    const r = run('INSERT INTO tasks (user_id, title, notes, due, priority, list, source_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      req.user.id, b.title.trim(), b.notes || '', b.due || null, b.priority || 0, b.list || 'Tasks', b.sourceMessageId || null, now(), now());
    notify(req.user.id, 'tasks:changed', {});
    return out(get('SELECT * FROM tasks WHERE id = ?', r.lastInsertRowid));
  });

  app.patch('/api/tasks/:id', async (req, reply) => {
    const t = get('SELECT * FROM tasks WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!t) return httpError(reply, 404, 'Not found');
    const b = req.body || {};
    run(`UPDATE tasks SET title = ?, notes = ?, due = ?, priority = ?, list = ?, done = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
      b.title ?? t.title, b.notes ?? t.notes, b.due !== undefined ? b.due : t.due, b.priority ?? t.priority, b.list ?? t.list,
      b.done !== undefined ? (b.done ? 1 : 0) : t.done, b.done ? (t.completed_at || now()) : (b.done === false ? null : t.completed_at), now(), t.id);
    notify(req.user.id, 'tasks:changed', {});
    return out(get('SELECT * FROM tasks WHERE id = ?', t.id));
  });

  app.delete('/api/tasks/:id', async (req) => {
    run('DELETE FROM tasks WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    notify(req.user.id, 'tasks:changed', {});
    return { ok: true };
  });

  // Create tasks from the AI-extracted action items of a message.
  app.post('/api/tasks/from-message/:id', async (req, reply) => {
    const m = get('SELECT id, subject FROM messages WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!m) return httpError(reply, 404, 'Not found');
    const items = req.body?.items || json(get('SELECT action_items_json FROM ai_insights WHERE message_id = ?', m.id)?.action_items_json, []);
    const created = [];
    for (const it of items.length ? items : [{ text: `Follow up: ${m.subject}` }]) {
      const due = it.due ? Date.parse(it.due + (String(it.due).length === 10 ? 'T17:00:00' : '')) : null;
      const r = run('INSERT INTO tasks (user_id, title, due, source_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', req.user.id, it.text, Number.isNaN(due) ? null : due, m.id, now(), now());
      created.push(out(get('SELECT * FROM tasks WHERE id = ?', r.lastInsertRowid)));
    }
    notify(req.user.id, 'tasks:changed', {});
    return created;
  });
}
