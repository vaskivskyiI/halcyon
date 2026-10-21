import { localToEpoch } from '../util/time.js';
import { get, all, run, json, now, update, tx } from '../db/index.js';
import { uuid } from '../util/crypto.js';
import { expand } from './recurrence.js';
import { getSettings } from '../settings.js';
import { notify } from '../util/events.js';
import { queueMemory } from '../ai/queue.js';

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
  return get('SELECT e.*, c.source, c.readonly FROM events e JOIN calendars c ON c.id = e.calendar_id WHERE e.id = ? AND c.user_id = ?', id, userId);
}

// Subscribed calendars (ICS links, read-only CalDAV) are never changed from here.
const readOnly = () => Object.assign(new Error('This calendar is read-only (a subscription)'), { statusCode: 400 });

export function createEvent(userId, e, extra = {}) {
  const cal = (e.calendarId && userCalendar(userId, e.calendarId)) || defaultCalendar(userId);
  if (!cal) throw new Error('No calendar');
  if (cal.readonly) throw readOnly();
  const s = getSettings(userId);
  const start = Number(e.start), end = Number(e.end || start + s.calendar.defaultDurationMin * 60e3);
  const r = run('INSERT INTO events (calendar_id, uid, start, end, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', cal.id, e.uid || uuid(), start, end, now(), now());
  update('events', r.lastInsertRowid, {
    ...toRow({ reminders: [s.calendar.defaultReminderMin], ...e, calendarId: cal.id }), start, end,
    dirty: cal.source === 'caldav' ? 1 : 0, ...extra, updated_at: now(),
  }, COLS);
  notify(userId, 'calendar:changed', {});
  queueMemory(userId, 'event', r.lastInsertRowid);
  return get('SELECT * FROM events WHERE id = ?', r.lastInsertRowid);
}

/** Moves an event and its changed occurrences to another calendar; returns the id of the moved master event. */
function moveToCalendar(ev, to) {
  const from = get('SELECT source FROM calendars WHERE id = ?', ev.calendar_id);
  let masterId = null;
  tx(() => {
    for (const r of all('SELECT * FROM events WHERE calendar_id = ? AND uid = ? AND deleted = 0', ev.calendar_id, ev.uid)) {
      const { id: oldId, ...row } = r;
      const copy = { ...row, calendar_id: to.id, href: null, etag: null, dirty: to.source === 'caldav' ? 1 : 0, updated_at: now() };
      const cols = Object.keys(copy);
      const newId = Number(run(`INSERT INTO events (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((k) => copy[k])).lastInsertRowid);
      if (!r.recurrence_id) masterId = newId;
      // Server copy in the old calendar: deleted there by the next sync; a local-only copy is simply removed.
      if (from?.source === 'caldav' && r.href) run('UPDATE events SET deleted = 1, dirty = 1 WHERE id = ?', oldId);
      else run('DELETE FROM events WHERE id = ?', oldId);
    }
  });
  return masterId || get('SELECT id FROM events WHERE calendar_id = ? AND uid = ? ORDER BY recurrence_id IS NOT NULL LIMIT 1', to.id, ev.uid).id;
}

export function updateEvent(userId, id, patch, extra = {}) {
  const ev = eventOf(userId, id);
  if (!ev) return null;
  if (ev.readonly) throw readOnly();
  if (patch.calendarId && Number(patch.calendarId) !== ev.calendar_id) {
    const to = userCalendar(userId, patch.calendarId);
    if (!to) throw new Error('Calendar not found');
    if (to.readonly) throw readOnly();
    // Another calendar: the event (with its changed occurrences) moves there — on a server calendar it is created
    // anew, and removed from the old server calendar on the next sync. Then the rest of the change is applied.
    id = moveToCalendar(ev, to);
    const { calendarId: _c, ...rest } = patch;
    patch = rest;
  }
  const cur = get('SELECT e.*, c.source FROM events e JOIN calendars c ON c.id = e.calendar_id WHERE e.id = ?', id);
  update('events', id, { ...toRow(patch), dirty: cur.source === 'caldav' ? 1 : 0, ...extra, updated_at: now() }, COLS);
  notify(userId, 'calendar:changed', {});
  queueMemory(userId, 'event', id);
  return get('SELECT * FROM events WHERE id = ?', id);
}

export function deleteEvent(userId, id) {
  const ev = eventOf(userId, id);
  if (!ev) return;
  if (ev.readonly) throw readOnly();
  tx(() => {
    if (ev.recurrence_id) {
      // Removing a modified occurrence: also exclude it from the series so it doesn't reappear.
      const master = get('SELECT * FROM events WHERE calendar_id = ? AND uid = ? AND recurrence_id IS NULL', ev.calendar_id, ev.uid);
      if (master) run('UPDATE events SET exdates_json = ?, dirty = ? WHERE id = ?', JSON.stringify([...json(master.exdates_json, []), ev.recurrence_id]), ev.source === 'caldav' ? 1 : 0, master.id);
    }
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
  if (master.readonly) throw readOnly();
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
/** includeInfo: false leaves out calendars shown "just for information" (brief, reminders). */
export function listRange(userId, from, to, calendarIds, { includeInfo = true } = {}) {
  const tz = getSettings(userId).calendar.timezone;
  let cals = all('SELECT * FROM calendars WHERE user_id = ? AND enabled = 1', userId);
  if (calendarIds?.length) cals = cals.filter((c) => calendarIds.includes(c.id));
  if (!includeInfo) cals = cals.filter((c) => (c.show_as || 'busy') !== 'info');
  if (!cals.length) return [];
  const ph = cals.map(() => '?').join(',');
  const rows = all(`SELECT * FROM events WHERE deleted = 0 AND calendar_id IN (${ph}) AND (rrule IS NOT NULL OR (start < ? AND end >= ?))`, ...cals.map((c) => c.id), to, from);
  const overrides = new Map();
  for (const r of rows) if (r.recurrence_id) overrides.set(`${r.calendar_id}:${r.uid}:${r.recurrence_id}`, r);
  const calById = Object.fromEntries(cals.map((c) => [c.id, c]));
  // What the calendar adds to each of its events: an event only blocks time when its calendar is shown as busy.
  const extra = (r) => {
    const c = calById[r.calendar_id];
    const showAs = c.show_as || 'busy';
    return { color: c.color, readonly: !!c.readonly, calendarName: c.name, showAs, busy: !!r.busy && showAs === 'busy' };
  };
  const out = [];
  for (const r of rows) {
    if (r.recurrence_id) {
      if (r.start < to && r.end >= from) out.push({ ...serializeEvent(r), instanceId: `${r.id}`, seriesId: get('SELECT id FROM events WHERE calendar_id = ? AND uid = ? AND recurrence_id IS NULL', r.calendar_id, r.uid)?.id, ...extra(r) });
      continue;
    }
    const base = serializeEvent(r);
    for (const occ of expand(base, from, to, tz)) {
      if (r.rrule && overrides.has(`${r.calendar_id}:${r.uid}:${occ.start}`)) continue;
      out.push({ ...base, start: occ.start, end: occ.end, occurrence: r.rrule ? occ.start : null, instanceId: r.rrule ? `${r.id}:${occ.start}` : `${r.id}`, ...extra(r) });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Free/busy slot finder used by the AI scheduler and "suggest times". */
export function findFreeSlots(userId, from, to, durationMin, { workStart, workEnd } = {}) {
  const s = getSettings(userId).calendar;
  const tz = s.timezone;
  // Working hours and weekends are the user's (their zone), not the server's.
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
  const busy = listRange(userId, from, to).filter((e) => e.busy && !e.allDay).map((e) => [e.start, e.end]).sort((a, b) => a[0] - b[0]);
  const dur = durationMin * 60e3, step = 30 * 60e3, perDay = 4;
  const slots = [];
  const seen = new Set();
  for (let t0 = from; t0 < to && slots.length < 20; t0 += 12 * 3600e3) {
    const p = Object.fromEntries(day.formatToParts(new Date(t0)).map((x) => [x.type, x.value]));
    const ymd = `${p.year}-${p.month}-${p.day}`;
    if (seen.has(ymd)) continue;
    seen.add(ymd);
    if (p.weekday === 'Sat' || p.weekday === 'Sun') continue;
    const ds = localToEpoch(ymd, workStart || s.workStart, tz), de = localToEpoch(ymd, workEnd || s.workEnd, tz);
    // Start on a quarter hour, then offer starts every 30 minutes in each free gap (a few per day, so they spread).
    let t = Math.ceil(Math.max(ds, from) / 9e5) * 9e5, n = 0;
    for (const [bs, be] of [...busy.filter(([bs, be]) => be > t && bs < de), [de, de]]) {
      for (; t + dur <= Math.min(bs, de) && n < perDay && slots.length < 20; t += step, n++) slots.push({ start: t, end: t + dur });
      t = Math.max(t, Math.ceil(be / 9e5) * 9e5);
    }
  }
  return slots;
}
