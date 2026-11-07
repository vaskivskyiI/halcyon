// Buttons on notifications (Mark read, Archive, Snooze, Mark done …): what each notification offers, what pressing one
// does (POST /api/push/action, routes/settings.js) and reminders snoozed until later (scheduler.js).
import { get, all, run, json, now } from './db/index.js';
import { escapeHtml } from './util/text.js';
import { sanitizeEmailHtml as sanitizeQuote } from './mail/sanitize.js';
import { getSettings } from './settings.js';
import { tzOffsetMs } from './calendar/recurrence.js';
import { eventOf } from './calendar/repo.js';

const SNOOZE_EVENT_MIN = 5, SNOOZE_TASK_MIN = 60;

// The buttons a mail notification can have; the user picks which, in order (Settings → Notifications). Android shows
// the first three, Windows five, browsers two.
export const MAIL_ACTIONS = { reply: 'Reply', read: 'Mark read', archive: 'Archive', delete: 'Delete', snooze: 'Snooze', flag: 'Flag', spam: 'Spam' };
export const DEFAULT_MAIL_ACTIONS = ['reply', 'read', 'archive', 'delete', 'snooze'];

/**
 * ref: what the buttons act on — 'mail:<id,id…>', 'event:<id>:<start>', 'task:<id>'. actions: [{ id, title, input?, url? }]:
 * input — the button takes a typed text (Android answers in the notification), url — where it goes where it cannot
 * (the reply opens the composer; Join opens the meeting).
 */
export function actionsOf(kind, data, mailActions = DEFAULT_MAIL_ACTIONS) {
  if (data.tag === 'test') return { ref: '', actions: [] };
  const mail = (data.about?.mail || []).map(Number).filter(Boolean);
  if (kind === 'mail' && mail.length) {
    const ids = (Array.isArray(mailActions) ? mailActions : DEFAULT_MAIL_ACTIONS).filter((a) => MAIL_ACTIONS[a]);
    return { ref: `mail:${mail.join(',')}`, actions: mail.length === 1
      ? ids.map((a) => ({ id: a, title: MAIL_ACTIONS[a], ...(a === 'reply' ? { input: 'Reply…', url: `#/mail/unified/${mail[0]}/reply` } : {}) }))
      : [{ id: 'read', title: 'Mark all read' }, { id: 'archive', title: 'Archive all' }] };
  }
  if (data.event) {
    return { ref: `event:${data.event.id}:${data.event.start}`, actions: [
      ...(/^https:\/\//i.test(data.event.meeting || '') ? [{ id: 'join', title: 'Join', url: data.event.meeting }] : []),
      { id: 'snooze', title: `Snooze ${SNOOZE_EVENT_MIN} min` }, { id: 'snooze15', title: 'Snooze 15 min' }, { id: 'dismiss', title: 'Dismiss' },
    ] };
  }
  if (data.about?.task) return { ref: `task:${data.about.task}`, actions: [{ id: 'done', title: 'Mark done' }, { id: 'snooze', title: 'Snooze 1 h' }, { id: 'tomorrow', title: 'Tomorrow' }] };
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
    url: `#/calendar/event/${e.id}/${start}`, tag: `rem-e${e.id}-${start}`, type: 'event', event: { id: e.id, start, meeting: e.onlineMeeting || e.online_meeting || '' },
    about: { until: Math.max(end, start + 15 * 60e3) },
  };
}

/** The "due now" reminder of a task. */
export const taskReminder = (task) => ({ title: task.title, body: 'Task due now', url: `#/tasks/${task.id}`, tag: `rem-t${task.id}`, type: 'task', about: { task: task.id } });

/** Snoozed: the reminder comes again at `dueAt` (kept in the database, so a restart does not lose it). */
export function snoozeReminder(userId, ref, dueAt) {
  run('DELETE FROM reminder_snoozes WHERE user_id = ? AND ref = ?', userId, ref);
  run('INSERT INTO reminder_snoozes (user_id, ref, due_at, created_at) VALUES (?, ?, ?, ?)', userId, ref, dueAt, now());
}
/** When a snooze button brings the reminder back. */
export function snoozeUntil(userId, kind, action, t = now()) {
  if (action === 'tomorrow') return tomorrowMorning(userId, t);
  if (action === 'snooze15') return t + 15 * 60e3;
  return t + (kind === 'event' ? SNOOZE_EVENT_MIN : SNOOZE_TASK_MIN) * 60e3;
}

/** A short answer typed in the notification: a reply to the sender (Reply-To), quoting the email, sent like any other
 *  (with the undo delay). The email counts as read. */
export function quickReply(userId, id, text) {
  const m = get(`SELECT m.*, a.kind AS account_kind FROM messages m JOIN accounts a ON a.id = m.account_id WHERE m.id = ? AND m.user_id = ?`, id, userId);
  if (!m) throw Object.assign(new Error('Not found'), { statusCode: 404 });
  if (m.account_kind === 'archive') throw Object.assign(new Error('Mail in an archive cannot be answered from here'), { statusCode: 400 });
  const to = json(m.reply_to_json, []).filter((a) => a?.address);
  const subject = /^re:/i.test(m.subject || '') ? m.subject : `Re: ${m.subject || ''}`;
  const quoted = m.body_html ? sanitizeQuote(m.body_html, { allowRemote: true }).html : escapeHtml(m.body_text || '').replace(/\n/g, '<br>');
  const html = `<div>${escapeHtml(text).replace(/\n/g, '<br>')}</div><div data-quote="1"><br><div>${escapeHtml(m.from_name || m.from_addr)} wrote:</div><blockquote>${quoted}</blockquote></div>`;
  return { accountId: m.account_id, to: to.length ? to : [{ name: m.from_name || '', address: m.from_addr }], subject, html, text: `${text}\n`, inReplyToId: m.id };
}

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
