// Emails and tasks added to an event by the user ("Add to event"): mail that came later about a meeting, tasks made for
// it. Kept by the event's UID, so the link survives the event moving to another calendar or being synced again.
import { get, all, run, now } from '../db/index.js';
import { eventOf } from './repo.js';

const KINDS = ['mail', 'task'];
const fail = (status, message) => Object.assign(new Error(message), { statusCode: status });

function eventUid(userId, eventId) {
  const e = eventOf(userId, Number(eventId));
  if (!e || e.deleted) throw fail(404, 'Event not found');
  return e.uid;
}
function owned(userId, kind, refId) {
  return kind === 'mail' ? get('SELECT id FROM messages WHERE id = ? AND user_id = ?', refId, userId)
    : get('SELECT id FROM tasks WHERE id = ? AND user_id = ?', refId, userId);
}

export function addEventLink(userId, eventId, kind, refId) {
  if (!KINDS.includes(kind)) throw fail(400, 'Unknown kind');
  const uid = eventUid(userId, eventId);
  if (!owned(userId, kind, Number(refId))) throw fail(404, 'Not found');
  run('INSERT OR IGNORE INTO event_links (user_id, event_uid, kind, ref_id, created_at) VALUES (?, ?, ?, ?, ?)', userId, uid, kind, Number(refId), now());
  return eventLinks(userId, eventId);
}

export function removeEventLink(userId, eventId, kind, refId) {
  run('DELETE FROM event_links WHERE user_id = ? AND event_uid = ? AND kind = ? AND ref_id = ?', userId, eventUid(userId, eventId), kind, Number(refId));
  return eventLinks(userId, eventId);
}

/** What was added to the event: { mail: [...], tasks: [...] }, newest mail first. Deleted mail and tasks drop out. */
export function eventLinks(userId, eventId) {
  const uid = eventUid(userId, eventId);
  const mail = all(`SELECT m.id, m.subject, m.from_name, m.from_addr, m.date, m.thread_id FROM event_links l JOIN messages m ON m.id = l.ref_id AND m.user_id = l.user_id
    WHERE l.user_id = ? AND l.event_uid = ? AND l.kind = 'mail' ORDER BY m.date DESC`, userId, uid)
    .map((m) => ({ id: m.id, subject: m.subject, from: { name: m.from_name, address: m.from_addr }, date: m.date, threadId: m.thread_id }));
  const tasks = all(`SELECT t.id, t.title, t.done, t.due FROM event_links l JOIN tasks t ON t.id = l.ref_id AND t.user_id = l.user_id
    WHERE l.user_id = ? AND l.event_uid = ? AND l.kind = 'task' ORDER BY t.done, t.due IS NULL, t.due`, userId, uid)
    .map((t) => ({ id: t.id, title: t.title, done: !!t.done, due: t.due }));
  return { mail, tasks };
}

/** The events mail or tasks were added to: Map refId → [{ id, title, start, end, allDay }] (one per event, not per copy). */
export function eventsLinkedTo(userId, kind, refIds) {
  const ids = [...new Set(refIds.map(Number).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  const rows = all(`SELECT l.ref_id, e.id, e.uid, e.title, e.start, e.end, e.all_day FROM event_links l
    JOIN events e ON e.uid = l.event_uid AND e.recurrence_id IS NULL AND e.deleted = 0 JOIN calendars c ON c.id = e.calendar_id AND c.user_id = l.user_id
    WHERE l.user_id = ? AND l.kind = ? AND l.ref_id IN (${ids.join(',')}) ORDER BY e.start`, userId, kind);
  for (const r of rows) {
    const list = out.get(r.ref_id) || [];
    if (!list.some((x) => x.uid === r.uid)) list.push({ id: r.id, uid: r.uid, title: r.title, start: r.start, end: r.end, allDay: !!r.all_day });
    out.set(r.ref_id, list);
  }
  return out;
}
