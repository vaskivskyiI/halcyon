import { allDayMs } from './recurrence.js';
import { localToEpoch } from '../util/time.js';
import { get, all, run, json, now, update, tx } from '../db/index.js';
import { uuid } from '../util/crypto.js';
import { expand } from './recurrence.js';
import { getSettings } from '../settings.js';
import { notify } from '../util/events.js';
import { queueMemory } from '../ai/queue.js';

const COLS = ['calendar_id', 'uid', 'title', 'description', 'location', 'start', 'end', 'all_day', 'timezone', 'rrule', 'exdates_json', 'recurrence_id',
  'attendees_json', 'organizer_json', 'reminders_json', 'status', 'busy', 'url', 'online_meeting', 'etag', 'href', 'dirty', 'deleted', 'source_message_id', 'updated_at',
  'linked_cal_id', 'linked_uid', 'linked_at', 'show_as'];

// How an event shows the user's time; busy, tentative and away block it, free and working elsewhere do not.
export const EVENT_SHOW_AS = ['free', 'elsewhere', 'tentative', 'busy', 'oof'];
export const blocksTime = (s) => s === 'busy' || s === 'tentative' || s === 'oof';
const ownShowAs = (e) => (EVENT_SHOW_AS.includes(e.show_as) ? e.show_as : e.busy ? 'busy' : 'free');

export function serializeEvent(e) {
  return {
    id: e.id, calendarId: e.calendar_id, uid: e.uid, title: e.title, description: e.description, location: e.location,
    start: e.start, end: e.end, allDay: !!e.all_day, timezone: e.timezone, rrule: e.rrule, exdates: json(e.exdates_json, []),
    recurrenceId: e.recurrence_id, attendees: json(e.attendees_json, []), organizer: json(e.organizer_json, null),
    reminders: json(e.reminders_json, []), status: e.status, busy: !!e.busy, url: e.url, onlineMeeting: e.online_meeting,
    sourceMessageId: e.source_message_id, linkedFrom: e.linked_cal_id || null, eventShowAs: ownShowAs(e), myShowAs: e.my_show_as || null,
  };
}

export function toRow(e) {
  return {
    calendar_id: e.calendarId, uid: e.uid, title: e.title, description: e.description, location: e.location, start: e.start, end: e.end,
    all_day: e.allDay === undefined ? undefined : (e.allDay ? 1 : 0), timezone: e.timezone, rrule: e.rrule === '' ? null : e.rrule,
    exdates_json: e.exdates && JSON.stringify(e.exdates), recurrence_id: e.recurrenceId,
    attendees_json: e.attendees && JSON.stringify(e.attendees), organizer_json: e.organizer === undefined ? undefined : JSON.stringify(e.organizer),
    reminders_json: e.reminders && JSON.stringify(e.reminders), status: e.status,
    // showAs (the event's own status) wins over the older busy flag; busy alone resets it to plain busy / free.
    busy: EVENT_SHOW_AS.includes(e.showAs) ? (e.showAs === 'free' ? 0 : 1) : e.busy === undefined ? undefined : (e.busy ? 1 : 0),
    show_as: EVENT_SHOW_AS.includes(e.showAs) ? e.showAs : e.busy === undefined ? undefined : null,
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
  let start = Number(e.start), end = Number(e.end || start + s.calendar.defaultDurationMin * 60e3);
  if (e.allDay) { start = allDayMs(start); end = Math.max(allDayMs(end), start + 864e5); }
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
  if (patch.allDay ?? !!cur.all_day) {
    const start = allDayMs(patch.start ?? cur.start);
    patch = { ...patch, start, end: Math.max(allDayMs(patch.end ?? cur.end), start + 864e5) };
  }
  update('events', id, { ...toRow(patch), dirty: cur.source === 'caldav' ? 1 : 0, ...extra, updated_at: now() }, COLS);
  notify(userId, 'calendar:changed', {});
  // Copies of this event in other calendars follow at once (calendar/linked.js).
  const calId = cur.calendar_id;
  setImmediate(() => import('./linked.js').then((m) => m.syncLinked(calId)).catch(() => {}));
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

/**
 * The user's own choice for one event (a series with all its occurrences): how it shows their time, also for events of
 * read-only, free or informational calendars. Kept in Halcyon only; null goes back to what the calendar and event say.
 */
export function setMyShowAs(userId, id, showAs) {
  const ev = eventOf(userId, id);
  if (!ev) return null;
  run('UPDATE events SET my_show_as = ? WHERE calendar_id = ? AND uid = ?', EVENT_SHOW_AS.includes(showAs) ? showAs : null, ev.calendar_id, ev.uid);
  notify(userId, 'calendar:changed', {});
  return get('SELECT * FROM events WHERE id = ?', id);
}

/** Expanded occurrences in [from, to) for the user's enabled calendars. */
/** includeInfo: false leaves out events shown "just for information" (brief, reminders). */
export function listRange(userId, from, to, calendarIds, { includeInfo = true } = {}) {
  const tz = getSettings(userId).calendar.timezone;
  let cals = all('SELECT * FROM calendars WHERE user_id = ? AND enabled = 1', userId);
  if (calendarIds?.length) cals = cals.filter((c) => calendarIds.includes(c.id));
  if (!cals.length) return [];
  const ph = cals.map(() => '?').join(',');
  const rows = all(`SELECT * FROM events WHERE deleted = 0 AND calendar_id IN (${ph}) AND (rrule IS NOT NULL OR (start < ? AND end >= ?))`, ...cals.map((c) => c.id), to, from);
  // An event added to the user's own calendar from another one (a linked copy) shows once — as the copy.
  const copied = new Set(rows.filter((r) => r.linked_cal_id).map((r) => `${r.linked_cal_id}:${r.linked_uid}`));
  const linkNames = new Map(all(`SELECT id, name FROM calendars WHERE id IN (${[...new Set(rows.filter((r) => r.linked_cal_id).map((r) => Number(r.linked_cal_id)))].join(',') || 0})`).map((c) => [c.id, c.name]));
  for (let i = rows.length - 1; i >= 0; i--) if (copied.has(`${rows[i].calendar_id}:${rows[i].uid}`)) rows.splice(i, 1);
  const overrides = new Map();
  for (const r of rows) if (r.recurrence_id) overrides.set(`${r.calendar_id}:${r.uid}:${r.recurrence_id}`, r);
  const calById = Object.fromEntries(cals.map((c) => [c.id, c]));
  // What the calendar adds to each of its events: in a calendar shown as busy, the event's own status counts; in a free or
  // informational one, the calendar's — unless the user chose otherwise for that event.
  const extra = (r) => {
    const c = calById[r.calendar_id];
    const calendarShowAs = c.show_as || 'busy';
    const showAs = (EVENT_SHOW_AS.includes(r.my_show_as) && r.my_show_as) || (calendarShowAs === 'busy' ? ownShowAs(r) : calendarShowAs);
    return { color: c.color, readonly: !!c.readonly, calendarName: c.name, calendarShowAs, showAs, busy: blocksTime(showAs), linkedFromName: r.linked_cal_id ? linkNames.get(r.linked_cal_id) || 'another calendar' : null };
  };
  const out = [];
  for (const r of rows) {
    if (!includeInfo && extra(r).showAs === 'info') continue;
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

/**
 * Busy time other people share with these users ("busy only", freebusy_shares): of each busy event of the shared calendars
 * only start, end and all-day leave the owner's side, as "Busy · <owner>". Owners among the viewers are left out (their
 * own time already shows as theirs).
 */
export function sharedBusy(viewerIds, from, to) {
  const ids = [...new Set(viewerIds.filter(Boolean).map(Number))];
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  const grants = all(`SELECT DISTINCT f.owner_id, f.calendar_id, COALESCE(NULLIF(u.name, ''), u.email) AS owner FROM freebusy_shares f
    JOIN users u ON u.id = f.owner_id JOIN calendars c ON c.id = f.calendar_id AND c.user_id = f.owner_id
    WHERE f.grantee_id IN (${ph}) AND f.owner_id NOT IN (${ph})`, ...ids, ...ids);
  const byOwner = new Map();
  for (const g of grants) byOwner.set(g.owner_id, { owner: g.owner, cals: [...(byOwner.get(g.owner_id)?.cals || []), g.calendar_id] });
  const out = new Map();
  for (const [ownerId, { owner, cals }] of byOwner) {
    for (const e of listRange(ownerId, from, to, cals, { includeInfo: false })) {
      if (!e.busy) continue;
      const key = `fb:${ownerId}:${e.start}:${e.end}:${e.allDay ? 1 : 0}`;
      out.set(key, { instanceId: key, id: null, calendarId: null, start: e.start, end: e.end, allDay: !!e.allDay, title: `Busy · ${owner}`,
        blocked: true, busy: true, readonly: true, showAs: 'busy', color: '#9ca3af', calendarName: owner, sharedBusy: true });
    }
  }
  return [...out.values()].sort((a, b) => a.start - b.start);
}

/** Free/busy slot finder used by the AI scheduler and "suggest times". viewers: whose busy-only shares count too (default: the user's). */
export function findFreeSlots(userId, from, to, durationMin, { workStart, workEnd, viewers = [userId] } = {}) {
  const s = getSettings(userId).calendar;
  const tz = s.timezone;
  // Working hours and weekends are the user's (their zone), not the server's.
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
  const busy = [...listRange(userId, from, to), ...sharedBusy(viewers, from, to)].filter((e) => e.busy && !e.allDay).map((e) => [e.start, e.end]).sort((a, b) => a[0] - b[0]);
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
