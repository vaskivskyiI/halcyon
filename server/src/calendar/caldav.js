// CalDAV two-way sync (tsdav). Remote objects may contain a master VEVENT plus overrides with the same UID.
import { get, all, run, now, tx } from '../db/index.js';
import { davClient } from '../contacts/carddav.js';
import { parseIcs, buildIcs } from './ics.js';
import { serializeEvent, toRow } from './repo.js';
import { update } from '../db/index.js';
import { logger } from '../util/log.js';

const log = logger('caldav');
const PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b'];

function upsertFromIcs(calId, href, etag, ics) {
  let parsed;
  try { parsed = parseIcs(ics); } catch (e) { log.warn(`bad ics at ${href}: ${e.message}`); return; }
  run('DELETE FROM events WHERE calendar_id = ? AND href = ? AND dirty = 0', calId, href);
  for (const e of parsed.events) {
    const r = run('INSERT INTO events (calendar_id, uid, start, end, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', calId, e.uid, e.start, e.end, now(), now());
    update('events', r.lastInsertRowid, { ...toRow(e), calendar_id: calId, href, etag, dirty: 0 }, ['calendar_id', 'uid', 'title', 'description', 'location', 'start', 'end', 'all_day', 'timezone', 'rrule', 'exdates_json', 'recurrence_id', 'attendees_json', 'organizer_json', 'reminders_json', 'status', 'busy', 'url', 'online_meeting', 'etag', 'href', 'dirty']);
  }
}

export async function syncCalDav(account) {
  if (!account.caldav_url) return;
  const client = await davClient(account, account.caldav_url, 'caldav');
  const remoteCals = (await client.fetchCalendars()).filter((c) => !c.components || c.components.includes('VEVENT'));
  for (const [i, remote] of remoteCals.entries()) {
    let cal = get('SELECT * FROM calendars WHERE user_id = ? AND url = ?', account.user_id, remote.url);
    if (!cal) {
      const name = typeof remote.displayName === 'string' ? remote.displayName : 'Calendar';
      const color = typeof remote.calendarColor === 'string' ? remote.calendarColor.slice(0, 7) : PALETTE[i % PALETTE.length];
      const r = run("INSERT INTO calendars (user_id, account_id, name, color, source, url, created_at) VALUES (?, ?, ?, ?, 'caldav', ?, ?)", account.user_id, account.id, name, color, remote.url, now());
      cal = get('SELECT * FROM calendars WHERE id = ?', r.lastInsertRowid);
    }
    // Push dirty events grouped by UID.
    const dirtyUids = [...new Set(all('SELECT uid FROM events WHERE calendar_id = ? AND dirty = 1', cal.id).map((r) => r.uid))];
    for (const uid of dirtyUids) {
      const family = all('SELECT * FROM events WHERE calendar_id = ? AND uid = ?', cal.id, uid);
      const master = family.find((e) => !e.recurrence_id) || family[0];
      try {
        if (master.deleted) {
          if (master.href) await client.deleteCalendarObject({ calendarObject: { url: master.href, etag: master.etag } });
          run('DELETE FROM events WHERE calendar_id = ? AND uid = ?', cal.id, uid);
          continue;
        }
        const live = family.filter((e) => !e.deleted);
        const ics = buildIcs(live.map(serializeEvent));
        if (master.href) {
          await client.updateCalendarObject({ calendarObject: { url: master.href, data: ics, etag: master.etag } });
          run('UPDATE events SET dirty = 0 WHERE calendar_id = ? AND uid = ?', cal.id, uid);
        } else {
          const filename = `${uid}.ics`;
          await client.createCalendarObject({ calendar: remote, filename, iCalString: ics });
          run('UPDATE events SET dirty = 0, href = ? WHERE calendar_id = ? AND uid = ?', new URL(filename, remote.url).href, cal.id, uid);
        }
        run('DELETE FROM events WHERE calendar_id = ? AND uid = ? AND deleted = 1', cal.id, uid);
      } catch (e) { log.warn(`push ${uid}: ${e.message}`); }
    }
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
      for (const e of all('SELECT DISTINCT href FROM events WHERE calendar_id = ? AND href IS NOT NULL AND dirty = 0', cal.id)) {
        if (!seen.has(e.href)) run('DELETE FROM events WHERE calendar_id = ? AND href = ?', cal.id, e.href);
      }
      run('UPDATE calendars SET ctag = ? WHERE id = ?', remote.ctag || null, cal.id);
    });
  }
}

export function importIcsInto(userId, calendarId, ics) {
  const parsed = parseIcs(ics);
  let n = 0;
  tx(() => {
    for (const e of parsed.events) {
      const existing = get('SELECT id FROM events WHERE calendar_id = ? AND uid = ? AND COALESCE(recurrence_id, 0) = ?', calendarId, e.uid, e.recurrenceId || 0);
      if (existing) update('events', existing.id, { ...toRow(e), updated_at: now() }, ['title', 'description', 'location', 'start', 'end', 'all_day', 'timezone', 'rrule', 'exdates_json', 'attendees_json', 'organizer_json', 'reminders_json', 'status', 'busy', 'url', 'online_meeting', 'updated_at']);
      else {
        const r = run('INSERT INTO events (calendar_id, uid, start, end, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', calendarId, e.uid, e.start, e.end, now(), now());
        update('events', r.lastInsertRowid, toRow(e), ['title', 'description', 'location', 'all_day', 'timezone', 'rrule', 'exdates_json', 'recurrence_id', 'attendees_json', 'organizer_json', 'reminders_json', 'status', 'busy', 'url', 'online_meeting']);
      }
      n++;
    }
  });
  return n;
}
