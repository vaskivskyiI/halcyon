// CalDAV two-way sync (tsdav). Remote objects may contain a master VEVENT plus overrides with the same UID.
import { get, all, run, now, tx } from '../db/index.js';
import { davClient } from '../contacts/carddav.js';
import { parseIcs, buildIcs } from './ics.js';
import { serializeEvent, toRow } from './repo.js';
import { update } from '../db/index.js';
import { logger } from '../util/log.js';
import { syncTodoCollection } from './todos.js';

const log = logger('caldav');
const PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b'];

function upsertFromIcs(calId, href, etag, ics) {
  let parsed;
  try { parsed = parseIcs(ics); } catch (e) { log.warn(`bad ics at ${href}: ${e.message}`); return; }
  // Updated in place where the event is already known (same UID and occurrence), so its id stays the same for an open
  // editor, links and reminders; new ones are added, and what the server no longer has in this object is removed.
  const cols = ['calendar_id', 'uid', 'title', 'description', 'location', 'start', 'end', 'all_day', 'timezone', 'rrule', 'exdates_json', 'recurrence_id', 'attendees_json', 'organizer_json', 'reminders_json', 'status', 'busy', 'url', 'online_meeting', 'etag', 'href', 'dirty'];
  const kept = new Set();
  for (const e of parsed.events) {
    const existing = get('SELECT id FROM events WHERE calendar_id = ? AND uid = ? AND COALESCE(recurrence_id, 0) = ? AND deleted = 0 AND dirty = 0', calId, e.uid, e.recurrenceId || 0);
    const id = existing?.id || Number(run('INSERT INTO events (calendar_id, uid, start, end, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', calId, e.uid, e.start, e.end, now(), now()).lastInsertRowid);
    update('events', id, { ...toRow(e), calendar_id: calId, href, etag, dirty: 0, updated_at: now() }, [...cols, 'updated_at']);
    kept.add(id);
  }
  for (const r of all('SELECT id FROM events WHERE calendar_id = ? AND href = ? AND dirty = 0', calId, href)) if (!kept.has(r.id)) run('DELETE FROM events WHERE id = ?', r.id);
}

/** account: a mail account with caldav_url, or a read-only source ({ id: null, user_id, caldav_url, dav_user, dav_pass_enc }). */
export async function syncCalDav(account, { sourceId = null, readonly = false } = {}) {
  if (!account.caldav_url) return;
  const client = await davClient(account, account.caldav_url, 'caldav');
  const collections = await client.fetchCalendars();
  const remoteCals = collections.filter((c) => !c.components || c.components.includes('VEVENT'));
  for (const [i, remote] of remoteCals.entries()) {
    let cal = get('SELECT * FROM calendars WHERE user_id = ? AND url = ?', account.user_id, remote.url);
    if (!cal) {
      const name = typeof remote.displayName === 'string' ? remote.displayName : 'Calendar';
      const color = typeof remote.calendarColor === 'string' ? remote.calendarColor.slice(0, 7) : PALETTE[i % PALETTE.length];
      const r = run("INSERT INTO calendars (user_id, account_id, source_id, name, color, source, url, readonly, created_at) VALUES (?, ?, ?, ?, ?, 'caldav', ?, ?, ?)",
        account.user_id, account.id ?? null, sourceId, name, color, remote.url, readonly ? 1 : 0, now());
      cal = get('SELECT * FROM calendars WHERE id = ?', r.lastInsertRowid);
    }
    // Push dirty events grouped by UID (never for read-only calendars).
    const dirtyUids = cal.readonly ? [] : [...new Set(all('SELECT uid FROM events WHERE calendar_id = ? AND dirty = 1', cal.id).map((r) => r.uid))];
    let pushFailed = false;
    for (const uid of dirtyUids) {
      const family = all('SELECT * FROM events WHERE calendar_id = ? AND uid = ?', cal.id, uid);
      const master = family.find((e) => !e.recurrence_id) || family[0];
      // tsdav returns the server's answer instead of throwing: a refused write (403, 412, 415, …) must not be taken
      // for success — the event would be marked as saved and then removed by the next sync as "gone on the server".
      const ok = (res, what) => {
        if (res && res.ok === false && res.status !== 404) throw new Error(`the calendar server refused to ${what} it (${res.status} ${res.statusText || ''})`.trim());
        return res;
      };
      try {
        if (master.deleted) {
          if (master.href) ok(await client.deleteCalendarObject({ calendarObject: { url: master.href, etag: master.etag } }), 'delete');
          run('DELETE FROM events WHERE calendar_id = ? AND uid = ?', cal.id, uid);
          continue;
        }
        const live = family.filter((e) => !e.deleted);
        const ics = buildIcs(live.map(serializeEvent), { clientScheduling: true });
        if (master.href) {
          ok(await client.updateCalendarObject({ calendarObject: { url: master.href, data: ics, etag: master.etag } }), 'update');
          run('UPDATE events SET dirty = 0 WHERE calendar_id = ? AND uid = ?', cal.id, uid);
        } else {
          // A plain file name: UIDs from Outlook / Google contain characters some servers refuse in a URL.
          const filename = `${uid.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120)}.ics`;
          ok(await client.createCalendarObject({ calendar: remote, filename, iCalString: ics }), 'save');
          run('UPDATE events SET dirty = 0, href = ? WHERE calendar_id = ? AND uid = ?', new URL(filename, remote.url).href, cal.id, uid);
        }
        run('DELETE FROM events WHERE calendar_id = ? AND uid = ? AND deleted = 1', cal.id, uid);
      } catch (e) {
        log.warn(`push ${uid}: ${e.message}`);
        // Kept locally (still marked to be saved); the problems panel shows why.
        run('UPDATE calendars SET sync_error = ? WHERE id = ?', `“${master.title || 'Event'}” could not be saved to the server calendar: ${e.message}`.slice(0, 300), cal.id);
        pushFailed = true;
      }
    }
    if (!pushFailed) run('UPDATE calendars SET sync_error = NULL WHERE id = ? AND sync_error IS NOT NULL', cal.id);
    if (cal.ctag && remote.ctag && cal.ctag === remote.ctag) continue;
    const objects = await client.fetchCalendarObjects({ calendar: remote });
    const seen = new Set();
    tx(() => {
      for (const o of objects) {
        seen.add(o.url);
        const local = get('SELECT etag, dirty FROM events WHERE calendar_id = ? AND href = ? LIMIT 1', cal.id, o.url);
        if (local?.dirty) continue;
        if (local && local.etag && local.etag === o.etag) continue;
        if (o.data) upsertFromIcs(cal.id, o.url, o.etag, o.data);
      }
      // Gone on the server → gone here. Except events this app saved that the server never listed (no etag yet): if the
      // server has the same event under another address it was just renamed (the server copy was taken above);
      // otherwise it is saved again instead of silently disappearing.
      const remoteUids = new Set(objects.map((o) => (String(o.data || '').match(/^UID:(.+?)\r?$/m) || [])[1]).filter(Boolean));
      for (const e of all('SELECT href, uid, MAX(etag IS NOT NULL) AS confirmed FROM events WHERE calendar_id = ? AND href IS NOT NULL AND dirty = 0 GROUP BY href', cal.id)) {
        if (seen.has(e.href)) continue;
        if (!e.confirmed && !remoteUids.has(e.uid)) run('UPDATE events SET dirty = 1, href = NULL WHERE calendar_id = ? AND href = ?', cal.id, e.href);
        else run('DELETE FROM events WHERE calendar_id = ? AND href = ?', cal.id, e.href);
      }
      run('UPDATE calendars SET ctag = ? WHERE id = ?', remote.ctag || null, cal.id);
    });
  }
  // Task lists: the collections that hold tasks (often the same ones as the calendars). Not for read-only sources.
  let taskLists = 0;
  if (!readonly) {
    for (const [i, remote] of collections.filter((c) => c.components?.includes('VTODO')).entries()) {
      try { await syncTodoCollection(client, account, remote, i); taskLists++; } catch (e) { log.warn(`tasks ${remote.url}: ${e.message}`); }
    }
  }
  return { calendars: remoteCals.length, taskLists };
}

const IMPORT_COLS = ['title', 'description', 'location', 'start', 'end', 'all_day', 'timezone', 'rrule', 'exdates_json', 'attendees_json', 'organizer_json', 'reminders_json', 'status', 'busy', 'url', 'online_meeting'];

/**
 * Events of an ICS text into a calendar, matched by UID (and occurrence). An event that did not change keeps its row
 * as it is — same id, no new timestamp — so links, reminders already shown and the AI index stay valid. replace: what
 * the text no longer has is removed (a subscription refreshed).
 */
export function importIcsInto(userId, calendarId, ics, { replace = false } = {}) {
  const parsed = parseIcs(ics);
  let n = 0;
  const keep = new Set();
  tx(() => {
    for (const e of parsed.events) {
      const row = toRow(e);
      const existing = get('SELECT * FROM events WHERE calendar_id = ? AND uid = ? AND COALESCE(recurrence_id, 0) = ?', calendarId, e.uid, e.recurrenceId || 0);
      if (existing) {
        keep.add(existing.id);
        const changed = IMPORT_COLS.some((k) => row[k] !== undefined && String(row[k] ?? '') !== String(existing[k] ?? ''));
        if (changed) update('events', existing.id, { ...row, updated_at: now() }, [...IMPORT_COLS, 'updated_at']);
      } else {
        const r = run('INSERT INTO events (calendar_id, uid, start, end, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', calendarId, e.uid, e.start, e.end, now(), now());
        update('events', r.lastInsertRowid, toRow(e), [...IMPORT_COLS.filter((k) => k !== 'start' && k !== 'end'), 'recurrence_id']);
        keep.add(Number(r.lastInsertRowid));
      }
      n++;
    }
    if (replace) for (const r of all('SELECT id FROM events WHERE calendar_id = ?', calendarId)) if (!keep.has(r.id)) run('DELETE FROM events WHERE id = ?', r.id);
  });
  return n;
}

/** Syncs a read-only CalDAV source: every calendar found at its URL, never written to. Errors are kept for the UI. */
export async function syncCalendarSource(sourceId) {
  const src = get('SELECT * FROM calendar_sources WHERE id = ?', sourceId);
  if (!src) return;
  try {
    await syncCalDav({ id: null, user_id: src.user_id, email: src.dav_user || '', caldav_url: src.url, dav_user: src.dav_user, dav_pass_enc: src.dav_pass_enc, auth_type: 'password' },
      { sourceId: src.id, readonly: true });
    run('UPDATE calendar_sources SET last_sync_at = ?, error = NULL WHERE id = ?', now(), src.id);
    if (src.space != null) run('UPDATE calendars SET space = COALESCE(space, ?) WHERE source_id = ?', src.space, src.id);
  } catch (e) {
    run('UPDATE calendar_sources SET error = ? WHERE id = ?', String(e.message || e).slice(0, 300), src.id);
    throw e;
  }
}
