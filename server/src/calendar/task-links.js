// Emails added to a task by the user ("Add to a task"): mail that came later about something to do. Kept by the task's
// UID (a task moved to another list is a new row with the same UID), else by its id.
import { get, all, run, now } from '../db/index.js';

const fail = (status, message) => Object.assign(new Error(message), { statusCode: status });
const keyOf = (t) => t.uid || `id:${t.id}`;

function taskKey(userId, taskId) {
  const t = get('SELECT id, uid FROM tasks WHERE id = ? AND user_id = ?', Number(taskId), userId);
  if (!t) throw fail(404, 'Task not found');
  return keyOf(t);
}

export function addTaskLink(userId, taskId, kind, refId) {
  if (kind !== 'mail') throw fail(400, 'Unknown kind');
  const key = taskKey(userId, taskId);
  if (!get('SELECT id FROM messages WHERE id = ? AND user_id = ?', Number(refId), userId)) throw fail(404, 'Not found');
  run('INSERT OR IGNORE INTO task_links (user_id, task_uid, kind, ref_id, created_at) VALUES (?, ?, ?, ?, ?)', userId, key, kind, Number(refId), now());
  return taskLinks(userId, taskId);
}

export function removeTaskLink(userId, taskId, kind, refId) {
  run('DELETE FROM task_links WHERE user_id = ? AND task_uid = ? AND kind = ? AND ref_id = ?', userId, taskKey(userId, taskId), kind, Number(refId));
  return taskLinks(userId, taskId);
}

/** What the task is linked with: the emails added to it, and the events it was added to (event-links.js). */
export function taskLinks(userId, taskId) {
  const key = taskKey(userId, taskId);
  const mail = all(`SELECT m.id, m.subject, m.from_name, m.from_addr, m.date, m.thread_id FROM task_links l JOIN messages m ON m.id = l.ref_id AND m.user_id = l.user_id
    WHERE l.user_id = ? AND l.task_uid = ? AND l.kind = 'mail' ORDER BY m.date DESC`, userId, key)
    .map((m) => ({ id: m.id, subject: m.subject, from: { name: m.from_name, address: m.from_addr }, date: m.date, threadId: m.thread_id }));
  const events = all(`SELECT e.id, e.uid, e.title, e.start, e.end, e.all_day FROM event_links l
    JOIN events e ON e.uid = l.event_uid AND e.recurrence_id IS NULL AND e.deleted = 0 JOIN calendars c ON c.id = e.calendar_id AND c.user_id = l.user_id
    WHERE l.user_id = ? AND l.kind = 'task' AND l.ref_id = ? ORDER BY e.start`, userId, Number(taskId))
    .filter((e, i, l) => l.findIndex((x) => x.uid === e.uid) === i).map((e) => ({ id: e.id, title: e.title, start: e.start, end: e.end, allDay: !!e.all_day }));
  return { mail, events };
}

/** How many emails were added to each task: Map taskId → n. */
export function mailCounts(userId, taskIds) {
  const out = new Map();
  const ids = taskIds.map(Number).filter(Boolean);
  if (!ids.length || !get("SELECT 1 AS x FROM task_links WHERE user_id = ? AND kind = 'mail' LIMIT 1", userId)) return out;
  const tasks = all(`SELECT id, uid FROM tasks WHERE user_id = ? AND id IN (${ids.join(',')})`, userId);
  const byKey = new Map(tasks.map((t) => [keyOf(t), t.id]));
  const rows = all(`SELECT task_uid, COUNT(*) AS n FROM task_links WHERE user_id = ? AND kind = 'mail' GROUP BY task_uid`, userId);
  for (const r of rows) if (byKey.has(r.task_uid)) out.set(byKey.get(r.task_uid), r.n);
  return out;
}

/** The tasks these messages were added to: [{ id, title, due, done, messageId }]. */
export function tasksLinkedTo(userId, msgIds) {
  const ids = msgIds.map(Number).filter(Boolean);
  if (!ids.length) return [];
  return all(`SELECT t.id, t.title, t.due, t.done, l.ref_id AS messageId FROM task_links l
    JOIN tasks t ON t.user_id = l.user_id AND (t.uid = l.task_uid OR 'id:' || t.id = l.task_uid)
    WHERE l.user_id = ? AND l.kind = 'mail' AND l.ref_id IN (${ids.join(',')}) ORDER BY t.done, t.due`, userId)
    .filter((t, i, l) => l.findIndex((x) => x.id === t.id) === i);
}
