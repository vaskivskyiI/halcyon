// Tasks (VTODO): task lists, recurrence and CalDAV two-way sync. Lists work like calendars: each is in a space (or
// shared), one is the default; a list is kept in Halcyon or synced with a CalDAV collection that holds tasks.
import ICAL from 'ical.js';
import rrulePkg from 'rrule';
import { get, all, run, now, tx } from '../db/index.js';
import { getSettings } from '../settings.js';
import { randomToken } from '../util/crypto.js';
import { localToEpoch } from '../util/time.js';
import { tzOffsetMs } from './recurrence.js';
import { spaceMap, spaceDefault, cleanSpace } from '../spaces.js';
import { logger } from '../util/log.js';

const { RRule } = rrulePkg;
const log = logger('todos');
const PALETTE = ['#10b981', '#3b82f6', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#ef4444', '#64748b'];
export const newTaskUid = () => `halcyon-task-${randomToken(12)}`;
const userTz = (userId) => getSettings(userId).calendar.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Every user has a list (and a default one); every task is in one of the user's lists and has a UID. Tasks made by
 * older code paths (follow-ups, MCP) or moved in from another user land in the default list — and are sent to the
 * server when that list syncs.
 */
export function ensureTaskLists(userId) {
  if (!get('SELECT 1 FROM task_lists WHERE user_id = ?', userId)) run("INSERT INTO task_lists (user_id, name, source, is_default, created_at) VALUES (?, 'Tasks', 'local', 1, ?)", userId, now());
  if (!get('SELECT 1 FROM task_lists WHERE user_id = ? AND is_default = 1', userId)) {
    run('UPDATE task_lists SET is_default = 1 WHERE id = (SELECT id FROM task_lists WHERE user_id = ? ORDER BY readonly, id LIMIT 1)', userId);
  }
  const loose = all('SELECT id, list_id FROM tasks WHERE user_id = ? AND (uid IS NULL OR list_id IS NULL OR list_id NOT IN (SELECT id FROM task_lists WHERE user_id = ?))', userId, userId);
  if (!loose.length) return;
  const def = defaultTaskList(userId);
  const own = new Set(all('SELECT id FROM task_lists WHERE user_id = ?', userId).map((l) => l.id));
  tx(() => {
    for (const t of loose) {
      const moved = !own.has(t.list_id);
      const listId = moved ? def.id : t.list_id;
      const dav = get("SELECT 1 FROM task_lists WHERE id = ? AND source = 'caldav'", listId);
      run(`UPDATE tasks SET list_id = ?, uid = COALESCE(uid, ?)${moved ? ', href = NULL, etag = NULL' : ''}, dirty = ? WHERE id = ?`, listId, newTaskUid(), dav ? 1 : 0, t.id);
    }
  });
}

/** Where new tasks go in a space: its chosen default, else a writable list of the space, else the default list. */
export function defaultTaskList(userId, space = '') {
  space = cleanSpace(space);
  const chosen = spaceDefault(userId, space, 'taskListId');
  if (chosen) return get('SELECT * FROM task_lists WHERE id = ?', chosen);
  if (space) {
    const ids = [...spaceMap(userId).taskLists].filter(([, s]) => s === space).map(([id]) => id);
    const l = ids.length && get(`SELECT * FROM task_lists WHERE id IN (${ids.join(',')}) AND readonly = 0 ORDER BY is_default DESC, id LIMIT 1`);
    if (l) return l;
  }
  return get('SELECT * FROM task_lists WHERE user_id = ? AND is_default = 1 AND readonly = 0', userId)
    || get('SELECT * FROM task_lists WHERE user_id = ? AND readonly = 0 ORDER BY id LIMIT 1', userId);
}

/** A repeat rule as stored: RRULE value without the prefix, understood by the rrule library; null for none, false if invalid. */
export function cleanRule(r) {
  if (r == null || r === '') return null;
  const s = String(r).trim().replace(/^RRULE:/i, '');
  try { RRule.parseString(s); return /FREQ=/i.test(s) ? s : false; } catch { return false; }
}

/**
 * The next due date of a repeating task after `due` (wall-clock time kept across DST), with the rule as it stays
 * (a COUNT counts down); null when the series has ended.
 */
export function nextOccurrence(rule, due, tz) {
  try {
    const opts = RRule.parseString(rule);
    if (opts.count != null && opts.count <= 1) return null;
    const n = new RRule({ ...opts, count: null, dtstart: new Date(due) }).after(new Date(due), false);
    if (!n) return null;
    let next = n.getTime();
    next += tzOffsetMs(tz, due) - tzOffsetMs(tz, next);
    return { due: next, rule: opts.count != null ? rule.replace(/COUNT=\d+/i, `COUNT=${opts.count - 1}`) : rule };
  } catch { return null; }
}

/**
 * A repeating task done, as in Outlook: this occurrence stays as a completed task, and the task moves on to its next
 * date (still open). Returns the completed copy's id, or null when there is no next date (it is simply done).
 */
export function completeOccurrence(task, tz) {
  const base = task.due || now();
  const next = nextOccurrence(task.rrule, base, tz);
  if (!next) return null;
  const dav = get("SELECT 1 FROM task_lists WHERE id = ? AND source = 'caldav'", task.list_id) ? 1 : 0;
  const t = now();
  const copy = run(`INSERT INTO tasks (user_id, list_id, title, notes, due, due_tz, due_all_day, priority, list, source_message_id, done, completed_at, uid, dirty, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`, task.user_id, task.list_id, task.title, task.notes, task.due, task.due_tz, task.due_all_day || 0, task.priority, task.list,
  task.source_message_id, t, newTaskUid(), dav, t, t).lastInsertRowid;
  run('UPDATE tasks SET due = ?, rrule = ?, done = 0, completed_at = NULL, dirty = ?, updated_at = ? WHERE id = ?', task.due ? next.due : null, next.rule, dav || task.dirty || 0, t, task.id);
  return Number(copy);
}

// ---- VTODO

const pad = (n) => String(n).padStart(2, '0');
/** Local date (YYYY-MM-DD) of a moment in a zone. */
function localDate(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
/** A date-only due is shown at the end of the work day (as "Today" in the app), in the user's zone. */
function timeOf(t, tz, workEnd) {
  if (!t) return null;
  if (t.isDate) return localToEpoch(`${t.year}-${pad(t.month)}-${pad(t.day)}`, workEnd, tz);
  if (!t.zone || t.zone.tzid === 'floating') return localToEpoch(`${t.year}-${pad(t.month)}-${pad(t.day)}`, `${pad(t.hour)}:${pad(t.minute)}`, tz);
  return t.toJSDate().getTime();
}

/** Tasks in an iCalendar text (single-occurrence overrides of repeating tasks are left to the client that made them). */
export function parseTodos(text, tz, workEnd = '17:00') {
  const comp = new ICAL.Component(ICAL.parse(text));
  for (const z of comp.getAllSubcomponents('vtimezone')) { try { ICAL.TimezoneService.register(z); } catch { /* known */ } }
  return comp.getAllSubcomponents('vtodo').filter((v) => !v.getFirstPropertyValue('recurrence-id')).map((v) => {
    const due = v.getFirstPropertyValue('due');
    const status = String(v.getFirstPropertyValue('status') || '').toUpperCase();
    const completed = v.getFirstPropertyValue('completed');
    const prio = Number(v.getFirstPropertyValue('priority') || 0);
    const rule = v.getFirstPropertyValue('rrule');
    return {
      uid: String(v.getFirstPropertyValue('uid') || ''), title: String(v.getFirstPropertyValue('summary') || '(no title)'),
      notes: String(v.getFirstPropertyValue('description') || ''), due: timeOf(due, tz, workEnd), dueAllDay: !!due?.isDate,
      priority: prio >= 1 && prio <= 4 ? 1 : 0, done: status === 'COMPLETED' || (!!completed && status !== 'NEEDS-ACTION' && status !== 'IN-PROCESS'),
      completedAt: completed ? completed.toJSDate().getTime() : null, rrule: rule ? rule.toString() : null,
    };
  });
}

/**
 * A task as iCalendar. Built on the server's own copy when there is one, so what other apps set (categories, alarms,
 * start dates, …) is kept; only what Halcyon edits is replaced.
 */
export function todoIcs(t, tz) {
  let comp = null, vt = null;
  try { if (t.ics) { comp = new ICAL.Component(ICAL.parse(t.ics)); vt = comp.getFirstSubcomponent('vtodo'); } } catch { comp = null; }
  if (!vt) {
    comp = new ICAL.Component(['vcalendar', [], []]);
    comp.updatePropertyWithValue('version', '2.0');
    comp.updatePropertyWithValue('prodid', '-//Halcyon//Halcyon Mail//EN');
    vt = new ICAL.Component('vtodo');
    comp.addSubcomponent(vt);
  }
  // Other occurrences' overrides stay as they are; only the main task is rewritten.
  const set = (name, v) => { vt.removeAllProperties(name); if (v != null && v !== '') vt.addPropertyWithValue(name, v); };
  const stamp = ICAL.Time.fromJSDate(new Date(), true);
  set('uid', t.uid); set('dtstamp', stamp); set('last-modified', stamp);
  set('summary', t.title); set('description', t.notes || null);
  const due = t.due ? (t.due_all_day ? ICAL.Time.fromDateString(localDate(t.due, tz)) : ICAL.Time.fromJSDate(new Date(t.due), true)) : null;
  set('due', due);
  // RFC 5545: a start may not be after the due date, and a repeat rule needs a start — the due date serves as both.
  const start = vt.getFirstPropertyValue('dtstart');
  if (start && (!due || start.compare(due) > 0 || start.isDate !== due.isDate)) vt.removeAllProperties('dtstart');
  if (t.rrule && due && !vt.getFirstPropertyValue('dtstart')) set('dtstart', due);
  set('rrule', t.rrule ? ICAL.Recur.fromString(t.rrule) : null);
  set('priority', t.priority ? 1 : null);
  set('status', t.done ? 'COMPLETED' : 'NEEDS-ACTION');
  set('completed', t.done ? ICAL.Time.fromJSDate(new Date(t.completed_at || now()), true) : null);
  set('percent-complete', t.done ? 100 : null);
  return comp.toString();
}

/** The task list for a CalDAV collection that holds tasks (made when first seen). */
function listFor(account, remote, i, readonly) {
  let list = get('SELECT * FROM task_lists WHERE user_id = ? AND url = ?', account.user_id, remote.url);
  if (!list) {
    const name = typeof remote.displayName === 'string' && remote.displayName ? remote.displayName : 'Tasks';
    const color = typeof remote.calendarColor === 'string' ? remote.calendarColor.slice(0, 7) : PALETTE[i % PALETTE.length];
    const r = run("INSERT INTO task_lists (user_id, account_id, name, color, source, url, readonly, created_at) VALUES (?, ?, ?, ?, 'caldav', ?, ?, ?)",
      account.user_id, account.id ?? null, name, color, remote.url, readonly ? 1 : 0, now());
    list = get('SELECT * FROM task_lists WHERE id = ?', r.lastInsertRowid);
  }
  return list;
}

/**
 * Two-way sync of the tasks of one CalDAV collection: local changes and deletions are sent first (a refused write
 * keeps the task marked and is shown as a problem), then the server's tasks are taken over where they changed.
 */
export async function syncTodoCollection(client, account, remote, i = 0, { readonly = false } = {}) {
  const list = listFor(account, remote, i, readonly);
  const tz = userTz(account.user_id), workEnd = getSettings(account.user_id).calendar.workEnd || '17:00';
  const refused = (res, what) => {
    if (res && res.ok === false && res.status !== 404) throw new Error(`the server refused to ${what} it (${res.status} ${res.statusText || ''})`.trim());
  };
  let error = null;
  if (!list.readonly) {
    for (const d of all('SELECT * FROM task_deletions WHERE list_id = ?', list.id)) {
      try { refused(await client.deleteCalendarObject({ calendarObject: { url: d.href, etag: d.etag || undefined } }), 'delete'); run('DELETE FROM task_deletions WHERE id = ?', d.id); } catch (e) { error = `A deleted task: ${e.message}`; }
    }
    for (const t of all('SELECT * FROM tasks WHERE list_id = ? AND dirty = 1', list.id)) {
      try {
        const data = todoIcs(t, tz);
        let href = t.href;
        if (href) refused(await client.updateCalendarObject({ calendarObject: { url: href, data, etag: t.etag || undefined } }), 'update');
        else {
          const filename = `${t.uid.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120)}.ics`;
          refused(await client.createCalendarObject({ calendar: remote, filename, iCalString: data }), 'save');
          href = new URL(filename, remote.url).href;
        }
        // Only when it was not changed again meanwhile; the server's etag is learned with the next listing.
        run('UPDATE tasks SET dirty = 0, href = ?, etag = NULL, ics = ? WHERE id = ? AND updated_at = ?', href, data, t.id, t.updated_at);
      } catch (e) {
        log.warn(`push task ${t.id}: ${e.message}`);
        error = `“${t.title}” could not be saved in the server's task list: ${e.message}`;
      }
    }
  }
  run('UPDATE task_lists SET sync_error = ? WHERE id = ?', error ? error.slice(0, 300) : null, list.id);
  const pending = get('SELECT 1 FROM tasks WHERE list_id = ? AND (etag IS NULL AND href IS NOT NULL)', list.id);
  if (list.ctag && remote.ctag && list.ctag === remote.ctag && !pending) return list;
  // tsdav asks for events unless told otherwise.
  const objects = await client.fetchCalendarObjects({ calendar: remote, filters: [{ 'comp-filter': { _attributes: { name: 'VCALENDAR' }, 'comp-filter': { _attributes: { name: 'VTODO' } } } }] });
  tx(() => {
    const seen = new Set();
    for (const o of objects) {
      if (!o.data || !/BEGIN:VTODO/i.test(o.data)) continue;
      seen.add(o.url);
      const local = get('SELECT id, etag, dirty FROM tasks WHERE list_id = ? AND href = ?', list.id, o.url);
      if (local?.dirty || (local?.etag && local.etag === o.etag)) continue;
      let td;
      try { [td] = parseTodos(o.data, tz, workEnd); } catch (e) { log.warn(`bad task at ${o.url}: ${e.message}`); continue; }
      if (!td?.uid) continue;
      const known = local || get('SELECT id, dirty FROM tasks WHERE list_id = ? AND uid = ?', list.id, td.uid);
      if (known?.dirty) continue;
      const vals = [td.title, td.notes, td.due, td.dueAllDay ? 1 : 0, td.priority, td.done ? 1 : 0, td.done ? (td.completedAt || now()) : null, td.rrule, td.uid, o.url, o.etag || null, o.data];
      if (known) run('UPDATE tasks SET title = ?, notes = ?, due = ?, due_tz = NULL, due_all_day = ?, priority = ?, done = ?, completed_at = ?, rrule = ?, uid = ?, href = ?, etag = ?, ics = ?, dirty = 0 WHERE id = ?', ...vals, known.id);
      else {
        run(`INSERT INTO tasks (user_id, list_id, list, title, notes, due, due_all_day, priority, done, completed_at, rrule, uid, href, etag, ics, dirty, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`, account.user_id, list.id, list.name, ...vals, now(), now());
      }
    }
    // Gone on the server → gone here; one saved here that the server never listed is saved again instead.
    for (const t of all('SELECT id, href, etag FROM tasks WHERE list_id = ? AND href IS NOT NULL AND dirty = 0', list.id)) {
      if (seen.has(t.href)) continue;
      if (t.etag) run('DELETE FROM tasks WHERE id = ?', t.id);
      else run('UPDATE tasks SET dirty = 1, href = NULL WHERE id = ?', t.id);
    }
    run('UPDATE task_lists SET ctag = ? WHERE id = ?', remote.ctag || null, list.id);
  });
  return list;
}
