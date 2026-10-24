// An event from a read-only, "just for information" or shared calendar, added to the user's own calendar: a copy that
// follows the original (its calendar + uid, so it survives a subscription rebuilding its events). Where both would
// show, only the copy does. When the original moves or changes, the copy follows; when it is gone, the copy stays,
// marked cancelled (the user decides to delete it).
import { get, all, run, now, json, update } from '../db/index.js';
import { notify } from '../util/events.js';
import { createEvent, userCalendar, defaultCalendar } from './repo.js';

// What follows the original. Reminders, the calendar and "busy" are the user's own choice on the copy.
const FOLLOW = ['title', 'description', 'location', 'start', 'end', 'all_day', 'timezone', 'rrule', 'exdates_json', 'url', 'online_meeting'];

const original = (calId, uid) => get('SELECT * FROM events WHERE calendar_id = ? AND uid = ? AND recurrence_id IS NULL AND deleted = 0', calId, uid);

/**
 * Adds the event `sourceId` (visible to `viewerId` — the user, or the shared space they act as) to `targetUserId`'s
 * calendar `calendarId` (default: their default calendar).
 */
export function linkEvent(viewerId, sourceId, targetUserId, calendarId = null) {
  const src = get('SELECT e.*, c.user_id AS owner, c.readonly, c.show_as FROM events e JOIN calendars c ON c.id = e.calendar_id WHERE e.id = ? AND e.deleted = 0', sourceId);
  if (!src || src.owner !== viewerId) throw new Error('Event not found');
  const master = src.recurrence_id ? original(src.calendar_id, src.uid) || src : src;
  const cal = (calendarId && userCalendar(targetUserId, calendarId)) || defaultCalendar(targetUserId);
  if (!cal || cal.readonly) throw new Error('Choose one of your own calendars');
  if (cal.id === master.calendar_id) throw new Error('This event is already in that calendar');
  const had = get('SELECT e.id FROM events e JOIN calendars c ON c.id = e.calendar_id WHERE c.user_id = ? AND e.linked_cal_id = ? AND e.linked_uid = ? AND e.deleted = 0', targetUserId, master.calendar_id, master.uid);
  if (had) return get('SELECT * FROM events WHERE id = ?', had.id);
  return createEvent(targetUserId, {
    calendarId: cal.id, title: master.title, description: master.description, location: master.location, start: master.start, end: master.end,
    allDay: !!master.all_day, timezone: master.timezone, rrule: master.rrule, exdates: json(master.exdates_json, []), url: master.url,
    onlineMeeting: master.online_meeting, busy: true, attendees: [],
  }, { linked_cal_id: master.calendar_id, linked_uid: master.uid, linked_at: now() });
}

/** The copy no longer follows the original (it stays as an ordinary event). */
export function unlinkEvent(userId, id) {
  run('UPDATE events SET linked_cal_id = NULL, linked_uid = NULL, linked_at = NULL WHERE id = ? AND calendar_id IN (SELECT id FROM calendars WHERE user_id = ?)', id, userId);
}

/** Brings copies up to date with their originals (all, or those of one calendar). Cheap when nothing changed. */
export function syncLinked(calendarId = null) {
  const copies = all(`SELECT e.*, c.user_id, c.source FROM events e JOIN calendars c ON c.id = e.calendar_id
    WHERE e.linked_cal_id IS NOT NULL AND e.deleted = 0 ${calendarId ? 'AND e.linked_cal_id = ?' : ''}`, ...(calendarId ? [calendarId] : []));
  const changed = new Set();
  for (const c of copies) {
    const o = original(c.linked_cal_id, c.linked_uid);
    if (!o) {
      if (c.status !== 'cancelled') { run("UPDATE events SET status = 'cancelled', dirty = ?, updated_at = ? WHERE id = ?", c.source === 'caldav' ? 1 : 0, now(), c.id); changed.add(c.user_id); }
      continue;
    }
    if ((o.updated_at || 0) <= (c.linked_at || 0) && c.status !== 'cancelled') continue;
    const fields = Object.fromEntries(FOLLOW.map((k) => [k, o[k]]));
    update('events', c.id, { ...fields, status: o.status === 'cancelled' ? 'cancelled' : 'confirmed', dirty: c.source === 'caldav' ? 1 : 0, linked_at: now(), updated_at: now() },
      [...FOLLOW, 'status', 'dirty', 'linked_at', 'updated_at']);
    changed.add(c.user_id);
  }
  for (const u of changed) notify(u, 'calendar:changed', {});
  return changed.size;
}
