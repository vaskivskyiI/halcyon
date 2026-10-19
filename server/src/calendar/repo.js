import { get, all, run, json, now, update, tx } from '../db/index.js';
import { uuid } from '../util/crypto.js';
import { expand } from './recurrence.js';
import { getSettings } from '../settings.js';
import { notify } from '../util/events.js';

const COLS = ['calendar_id', 'uid', 'title', 'description', 'location', 'start', 'end', 'all_day', 'timezone', 'rrule', 'exdates_json', 'recurrence_id',
  'attendees_json', 'organizer_json', 'reminders_json', 'status', 'busy', 'url', 'online_meeting', 'etag', 'href', 'dirty', 'deleted', 'source_message_id', 'updated_at'];

export function serializeEvent(e) {
  return {
    id: e.id, calendarId: e.calendar_id, uid: e.uid, title: e.title, description: e.description, location: e.location,
    start: e.start, end: e.end, allDay: !!e.all_day, timezone: e.timezone, rrule: e.rrule, exdates: json(e.exdates_json, []),
    recurrenceId: e.recurrence_id, attendees: json(e.attendees_json, []), organizer: json(e.organizer_json, null),
    reminders: json(e.reminders_json, []), status: e.status, busy: !!e.busy, url: e.url, onlineMeeting: e.online_meeting,
    sourceMessageId: e.source_message_id,
  };
}

export function toRow(e) {
  return {
    calendar_id: e.calendarId, uid: e.uid, title: e.title, description: e.description, location: e.location, start: e.start, end: e.end,
    all_day: e.allDay === undefined ? undefined : (e.allDay ? 1 : 0), timezone: e.timezone, rrule: e.rrule === '' ? null : e.rrule,
    exdates_json: e.exdates && JSON.stringify(e.exdates), recurrence_id: e.recurrenceId,
    attendees_json: e.attendees && JSON.stringify(e.attendees), organizer_json: e.organizer === undefined ? undefined : JSON.stringify(e.organizer),
    reminders_json: e.reminders && JSON.stringify(e.reminders), status: e.status, busy: e.busy === undefined ? undefined : (e.busy ? 1 : 0),
    url: e.url, online_meeting: e.onlineMeeting, source_message_id: e.sourceMessageId,
  };
}

export const userCalendar = (userId, id) => get('SELECT * FROM calendars WHERE id = ? AND user_id = ?', id, userId);
export const defaultCalendar = (userId) => get('SELECT * FROM calendars WHERE user_id = ? AND readonly = 0 ORDER BY is_default DESC, id LIMIT 1', userId);

export function eventOf(userId, id) {
  return get('SELECT e.*, c.source FROM events e JOIN calendars c ON c.id = e.calendar_id WHERE e.id = ? AND c.user_id = ?', id, userId);
}

export function createEvent(userId, e, extra = {}) {
  const cal = (e.calendarId && userCalendar(userId, e.calendarId)) || defaultCalendar(userId);
  if (!cal) throw new Error('No calendar');
  if (cal.readonly) throw new Error('Calendar is read-only');
  const s = getSettings(userId);
  const start = Number(e.start), end = Number(e.end || start + s.calendar.defaultDurationMin * 60e3);
  const r = run('INSERT INTO events (calendar_id, uid, start, end, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', cal.id, e.uid || uuid(), start, end, now(), now());
  update('events', r.lastInsertRowid, {
    ...toRow({ reminders: [s.calendar.defaultReminderMin], ...e, calendarId: cal.id }), start, end,
    dirty: cal.source === 'caldav' ? 1 : 0, ...extra, updated_at: now(),
  }, COLS);
  notify(userId, 'calendar:changed', {});
  return get('SELECT * FROM events WHERE id = ?', r.lastInsertRowid);
}

export function updateEvent(userId, id, patch, extra = {}) {
  const ev = eventOf(userId, id);
  if (!ev) return null;
  if (patch.calendarId && !userCalendar(userId, patch.calendarId)) throw new Error('Calendar not found');
  update('events', id, { ...toRow(patch), dirty: ev.source === 'caldav' ? 1 : 0, ...extra, updated_at: now() }, COLS);
  notify(userId, 'calendar:changed', {});
  return get('SELECT * FROM events WHERE id = ?', id);
}

export function deleteEvent(userId, id) {
  const ev = eventOf(userId, id);
  if (!ev) return;
  tx(() => {
    const family = ev.recurrence_id ? [ev] : all('SELECT * FROM events WHERE calendar_id = ? AND uid = ?', ev.calendar_id, ev.uid);
    for (const x of family) {
      if (ev.source === 'caldav' && x.href) run('UPDATE events SET deleted = 1, dirty = 1 WHERE id = ?', x.id);
      else run('DELETE FROM events WHERE id = ?', x.id);
    }
  });
  notify(userId, 'calendar:changed', {});
}

/** Edit or delete a single occurrence of a recurring series. */
export function editOccurrence(userId, id, occurrenceStart, patch, { remove = false } = {}) {
  const master = eventOf(userId, id);
  if (!master) return null;
  if (remove) {
    const ex = json(master.exdates_json, []);
    ex.push(Number(occurrenceStart));
    return updateEvent(userId, id, { exdates: ex });
  }
  const existing = get('SELECT id FROM events WHERE calendar_id = ? AND uid = ? AND recurrence_id = ?', master.calendar_id, master.uid, occurrenceStart);
  if (existing) return updateEvent(userId, existing.id, patch);
  const dur = master.end - master.start;
  const base = serializeEvent(master);
  return createEvent(userId, { ...base, rrule: null, exdates: [], start: Number(occurrenceStart), end: Number(occurrenceStart) + dur, ...patch, calendarId: master.calendar_id, uid: master.uid, recurrenceId: Number(occurrenceStart) },
    { href: master.href, etag: master.etag });
}

/** Expanded occurrences in [from, to) for the user's enabled calendars. */
export function listRange(userId, from, to, calendarIds) {
  const tz = getSettings(userId).calendar.timezone;
  let cals = all('SELECT * FROM calendars WHERE user_id = ? AND enabled = 1', userId);
  if (calendarIds?.length) cals = cals.filter((c) => calendarIds.includes(c.id));
  if (!cals.length) return [];
  const ph = cals.map(() => '?').join(',');
  const rows = all(`SELECT * FROM events WHERE deleted = 0 AND calendar_id IN (${ph}) AND (rrule IS NOT NULL OR (start < ? AND end >= ?))`, ...cals.map((c) => c.id), to, from);
  const overrides = new Map();
  for (const r of rows) if (r.recurrence_id) overrides.set(`${r.calendar_id}:${r.uid}:${r.recurrence_id}`, r);
  const calById = Object.fromEntries(cals.map((c) => [c.id, c]));
  const out = [];
  for (const r of rows) {
    if (r.recurrence_id) {
      if (r.start < to && r.end >= from) out.push({ ...serializeEvent(r), instanceId: `${r.id}`, seriesId: get('SELECT id FROM events WHERE calendar_id = ? AND uid = ? AND recurrence_id IS NULL', r.calendar_id, r.uid)?.id, color: calById[r.calendar_id].color });
      continue;
    }
    const base = serializeEvent(r);
    for (const occ of expand(base, from, to, tz)) {
      if (r.rrule && overrides.has(`${r.calendar_id}:${r.uid}:${occ.start}`)) continue;
      out.push({ ...base, start: occ.start, end: occ.end, occurrence: r.rrule ? occ.start : null, instanceId: r.rrule ? `${r.id}:${occ.start}` : `${r.id}`, color: calById[r.calendar_id].color });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Free/busy slot finder used by the AI scheduler and "suggest times". */
export function findFreeSlots(userId, from, to, durationMin, { workStart, workEnd } = {}) {
  const s = getSettings(userId).calendar;
  const [wsH, wsM] = (workStart || s.workStart).split(':').map(Number);
  const [weH, weM] = (workEnd || s.workEnd).split(':').map(Number);
  const busy = listRange(userId, from, to).filter((e) => e.busy && !e.allDay).map((e) => [e.start, e.end]).sort((a, b) => a[0] - b[0]);
  const slots = [];
  const dur = durationMin * 60e3;
  for (let day = new Date(from); day < new Date(to) && slots.length < 20; day.setDate(day.getDate() + 1)) {
    if ([0, 6].includes(day.getDay())) continue;
    const ds = new Date(day); ds.setHours(wsH, wsM, 0, 0);
    const de = new Date(day); de.setHours(weH, weM, 0, 0);
    let t = Math.max(ds.getTime(), from);
    for (const [bs, be] of busy) {
      if (be <= t || bs >= de.getTime()) continue;
      if (bs - t >= dur) slots.push({ start: t, end: t + dur });
      t = Math.max(t, be);
    }
    if (de.getTime() - t >= dur) slots.push({ start: t, end: t + dur });
  }
  return slots.slice(0, 20);
}
