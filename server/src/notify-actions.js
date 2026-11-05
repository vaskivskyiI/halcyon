// Buttons on notifications (Mark read, Archive, Snooze, Mark done …): what each notification offers, what pressing one
// does (POST /api/push/action, routes/settings.js) and reminders snoozed until later (scheduler.js).
import { get, all, run, now } from './db/index.js';
import { getSettings } from './settings.js';
import { tzOffsetMs } from './calendar/recurrence.js';
import { eventOf } from './calendar/repo.js';

const SNOOZE_EVENT_MIN = 5, SNOOZE_TASK_MIN = 60;

/**
 * ref: what the buttons act on — 'mail:<id,id…>', 'event:<id>:<start>', 'task:<id>'. actions: [{ id, title }]; three at
 * most (Android shows no more).
 */
export function actionsOf(kind, data) {
  if (data.tag === 'test') return { ref: '', actions: [] };
  const mail = (data.about?.mail || []).map(Number).filter(Boolean);
  if (kind === 'mail' && mail.length) {
    return { ref: `mail:${mail.join(',')}`, actions: mail.length === 1
      ? [{ id: 'read', title: 'Mark read' }, { id: 'archive', title: 'Archive' }, { id: 'snooze', title: 'Snooze' }]
      : [{ id: 'read', title: 'Mark all read' }] };
  }
  if (data.event) return { ref: `event:${data.event.id}:${data.event.start}`, actions: [{ id: 'snooze', title: `Snooze ${SNOOZE_EVENT_MIN} min` }, { id: 'dismiss', title: 'Dismiss' }] };
  if (data.about?.task) return { ref: `task:${data.about.task}`, actions: [{ id: 'done', title: 'Mark done' }, { id: 'snooze', title: 'Snooze 1 h' }] };
  return { ref: '', actions: [] };
}

/** 08:00 tomorrow in the user's time zone (what "Snooze" on a mail notification means, as the swipe does). */
export function tomorrowMorning(userId, t = now()) {
  const tz = getSettings(userId).calendar.timezone;
  const local = t + tzOffsetMs(tz, t);
  const want = Math.floor(local / 864e5) * 864e5 + 864e5 + 8 * 3600e3;
  return want - tzOffsetMs(tz, want - tzOffsetMs(tz, t));
}

/** The reminder of an event (its occurrence at `start`). */
export function eventReminder(userId, e, start) {
  const tz = getSettings(userId).calendar.timezone;
  const end = start + Math.max(0, (e.end || e.start) - e.start);
  return {
    title: e.title, body: `${new Date(start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz })}${e.location ? ` · ${e.location}` : ''}`,
    url: `#/calendar/event/${e.id}/${start}`, tag: `rem-e${e.id}-${start}`, type: 'event', event: { id: e.id, start },
    about: { until: Math.max(end, start + 15 * 60e3) },
  };
}

/** The "due now" reminder of a task. */
export const taskReminder = (task) => ({ title: task.title, body: 'Task due now', url: `#/tasks/${task.id}`, tag: `rem-t${task.id}`, type: 'task', about: { task: task.id } });

/** Snoozed: the reminder comes again in `minutes` (kept in the database, so a restart does not lose it). */
export function snoozeReminder(userId, ref, minutes) {
  run('DELETE FROM reminder_snoozes WHERE user_id = ? AND ref = ?', userId, ref);
  run('INSERT INTO reminder_snoozes (user_id, ref, due_at, created_at) VALUES (?, ?, ?, ?)', userId, ref, now() + minutes * 60e3, now());
}
export const snoozeMinutes = (kind) => (kind === 'event' ? SNOOZE_EVENT_MIN : SNOOZE_TASK_MIN);

/** Snoozed reminders due now, taken off the list: [{ userId, data }] to notify (a task done meanwhile is dropped). */
export function dueReminders(t = now()) {
  const out = [];
  for (const r of all('SELECT * FROM reminder_snoozes WHERE due_at <= ?', t)) {
    run('DELETE FROM reminder_snoozes WHERE id = ?', r.id);
    const [kind, id, start] = r.ref.split(':');
    if (kind === 'task') {
      const task = get('SELECT * FROM tasks WHERE id = ? AND user_id = ? AND done = 0', Number(id), r.user_id);
      if (task) out.push({ userId: r.user_id, data: taskReminder(task) });
    } else if (kind === 'event') {
      const e = eventOf(r.user_id, Number(id));
      if (e && e.status !== 'cancelled') out.push({ userId: r.user_id, data: eventReminder(r.user_id, e, Number(start) || e.start) });
    }
  }
  return out;
}
