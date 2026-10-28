import { get, all, run, now, json, tx } from '../db/index.js';
import { requireUser } from '../auth.js';
import { httpError } from './util.js';
import * as repo from '../calendar/repo.js';
import { buildIcs } from '../calendar/ics.js';
import { importIcsInto, syncCalendarSource } from '../calendar/caldav.js';
import { encrypt } from '../util/crypto.js';
import { respondToInvitation, sendInvitations } from '../calendar/invites.js';
import { notify } from '../util/events.js';
import { syncDav } from '../scheduler.js';
import { scope, reqSpace, spaceMap, inIds, cleanSpace } from '../spaces.js';
import { linkEvent, unlinkEvent } from '../calendar/linked.js';

const calOut = (c, spaces) => ({ id: c.id, name: c.name, color: c.color, source: c.source, accountId: c.account_id, sourceId: c.source_id || null, enabled: !!c.enabled, isDefault: !!c.is_default, readonly: !!c.readonly, url: c.source === 'subscription' ? c.url : undefined,
  space: spaces?.calendars.get(c.id) ?? '', ownSpace: c.space, syncError: c.sync_error || null, lastSyncAt: c.last_sync_at || null, showAs: c.show_as || 'busy' });
const SHOW_AS = ['busy', 'free', 'info'];
const sourceOut = (s) => ({ id: s.id, name: s.name, url: s.url, username: s.dav_user, lastSyncAt: s.last_sync_at, error: s.error,
  calendars: get('SELECT COUNT(*) AS n FROM calendars WHERE source_id = ?', s.id).n });

export default async function calendarRoutes(app) {
  app.addHook('preHandler', requireUser);

  app.get('/api/calendars', async (req) => {
    const sc = req.query.allSpaces === '1' ? null : scope(req.user.id, reqSpace(req)), spaces = spaceMap(req.user.id);
    return all(`SELECT * FROM calendars WHERE user_id = ? AND ${inIds('id', sc?.calendarIds)} ORDER BY is_default DESC, name`, req.user.id).map((c) => calOut(c, spaces));
  });

  app.post('/api/calendars', async (req, reply) => {
    const { name, color, url, space, showAs } = req.body || {};
    // url → read-only ICS subscription (holidays, Google / Outlook "secret iCal address", shared calendars). It is
    // loaded before it is added, so a wrong link is reported instead of giving an empty calendar. New calendars
    // belong to the active space.
    let ics = null;
    if (url) { try { ics = await fetchIcs(url); } catch (e) { return httpError(reply, 400, `Could not load the calendar: ${e.message}`); } }
    const r = run('INSERT INTO calendars (user_id, name, color, source, url, readonly, space, show_as, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      req.user.id, name || 'Calendar', color || '#10b981', url ? 'subscription' : 'local', url || null, url ? 1 : 0, cleanSpace(space ?? reqSpace(req)),
      SHOW_AS.includes(showAs) ? showAs : 'busy', now());
    if (ics) {
      importIcsInto(req.user.id, r.lastInsertRowid, ics);
      run('UPDATE calendars SET last_sync_at = ? WHERE id = ?', now(), r.lastInsertRowid);
      notify(req.user.id, 'calendar:changed', {});
    }
    return calOut(get('SELECT * FROM calendars WHERE id = ?', r.lastInsertRowid), spaceMap(req.user.id));
  });

  // ---- read-only CalDAV sources (calendars on another server: Nextcloud, iCloud, Fastmail, a shared calendar, ...)
  app.get('/api/calendar-sources', async (req) => all('SELECT * FROM calendar_sources WHERE user_id = ? ORDER BY id', req.user.id).map(sourceOut));
  app.post('/api/calendar-sources', async (req, reply) => {
    const { url, username, password, name, space, showAs } = req.body || {};
    if (!/^https?:\/\//i.test(String(url || '').trim())) return httpError(reply, 400, 'Enter the CalDAV address (https://...)');
    const r = run('INSERT INTO calendar_sources (user_id, name, url, dav_user, dav_pass_enc, space, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      req.user.id, String(name || new URL(String(url).trim()).hostname).slice(0, 80), String(url).trim(), username || null, password ? encrypt(password) : null,
      cleanSpace(space ?? reqSpace(req)), now());
    try {
      await syncCalendarSource(r.lastInsertRowid);
      if (SHOW_AS.includes(showAs)) run('UPDATE calendars SET show_as = ? WHERE source_id = ?', showAs, r.lastInsertRowid);
    } catch (e) {
      // Login refused or nothing found: a source that never worked is not kept.
      run('DELETE FROM calendars WHERE source_id = ?', r.lastInsertRowid);
      run('DELETE FROM calendar_sources WHERE id = ?', r.lastInsertRowid);
      return httpError(reply, 400, `Could not read calendars there: ${e.message}`);
    }
    notify(req.user.id, 'calendar:changed', {});
    return sourceOut(get('SELECT * FROM calendar_sources WHERE id = ?', r.lastInsertRowid));
  });
  app.post('/api/calendar-sources/:id/refresh', async (req, reply) => {
    const s = get('SELECT id FROM calendar_sources WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!s) return httpError(reply, 404, 'Not found');
    try { await syncCalendarSource(s.id); } catch (e) { return httpError(reply, 400, e.message); }
    notify(req.user.id, 'calendar:changed', {});
    return sourceOut(get('SELECT * FROM calendar_sources WHERE id = ?', s.id));
  });
  // Removes the source and the local read-only copies of its calendars; nothing on the other server is touched.
  app.delete('/api/calendar-sources/:id', async (req, reply) => {
    const s = get('SELECT id FROM calendar_sources WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!s) return httpError(reply, 404, 'Not found');
    run('DELETE FROM calendars WHERE source_id = ?', s.id);
    run('DELETE FROM calendar_sources WHERE id = ?', s.id);
    notify(req.user.id, 'calendar:changed', {});
    return { ok: true };
  });

  app.patch('/api/calendars/:id', async (req, reply) => {
    const c = repo.userCalendar(req.user.id, req.params.id);
    if (!c) return httpError(reply, 404, 'Not found');
    const { name, color, enabled, isDefault, showAs } = req.body || {};
    if (isDefault) run('UPDATE calendars SET is_default = 0 WHERE user_id = ?', req.user.id);
    if (SHOW_AS.includes(showAs)) run('UPDATE calendars SET show_as = ? WHERE id = ?', showAs, c.id);
    run('UPDATE calendars SET name = COALESCE(?, name), color = COALESCE(?, color), enabled = COALESCE(?, enabled), is_default = COALESCE(?, is_default) WHERE id = ?',
      name ?? null, color ?? null, enabled === undefined ? null : (enabled ? 1 : 0), isDefault ? 1 : null, c.id);
    notify(req.user.id, 'calendar:changed', {});
    return calOut(repo.userCalendar(req.user.id, c.id), spaceMap(req.user.id));
  });

  app.delete('/api/calendars/:id', async (req, reply) => {
    const c = repo.userCalendar(req.user.id, req.params.id);
    if (!c) return httpError(reply, 404, 'Not found');
    // The default calendar can go when another writable one takes its place (which then becomes the default).
    const next = c.is_default ? get('SELECT id FROM calendars WHERE user_id = ? AND id != ? AND readonly = 0 ORDER BY id LIMIT 1', req.user.id, c.id) : null;
    if (c.is_default && !next) return httpError(reply, 400, 'This is your only calendar you can add events to — add another one first');
    run('DELETE FROM calendars WHERE id = ?', c.id);
    if (next) run('UPDATE calendars SET is_default = 1 WHERE id = ?', next.id);
    notify(req.user.id, 'calendar:changed', {});
    return { ok: true };
  });

  app.post('/api/calendars/:id/refresh', async (req, reply) => {
    const c = repo.userCalendar(req.user.id, req.params.id);
    if (!c) return httpError(reply, 404, 'Not found');
    if (c.source === 'subscription') { try { await refreshSubscription(req.user.id, c.id); } catch (e) { return httpError(reply, 400, e.message); } }
    else if (c.source_id) { try { await syncCalendarSource(c.source_id); } catch (e) { return httpError(reply, 400, e.message); } }
    else if (c.account_id) await syncDav(get('SELECT * FROM accounts WHERE id = ?', c.account_id));
    return { ok: true };
  });

  app.get('/api/calendars/:id/export.ics', async (req, reply) => {
    const c = repo.userCalendar(req.user.id, req.params.id);
    if (!c) return httpError(reply, 404, 'Not found');
    const events = all('SELECT * FROM events WHERE calendar_id = ? AND deleted = 0', c.id).map(repo.serializeEvent);
    reply.header('content-type', 'text/calendar; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${c.name.replace(/[^\w-]+/g, '_')}.ics"`);
    return buildIcs(events);
  });

  app.post('/api/calendars/:id/import', async (req, reply) => {
    const c = repo.userCalendar(req.user.id, req.params.id);
    if (!c) return httpError(reply, 404, 'Not found');
    try {
      const n = importIcsInto(req.user.id, c.id, String(req.body?.ics || ''));
      notify(req.user.id, 'calendar:changed', {});
      return { imported: n };
    } catch (e) { return httpError(reply, 400, `Invalid iCalendar file: ${e.message}`); }
  });

  app.get('/api/events', async (req) => {
    const from = Number(req.query.from) || Date.now() - 7 * 864e5;
    const to = Number(req.query.to) || from + 42 * 864e5;
    // allSpaces=1: one person, one schedule — overlap checks look at every space, and say which one an event is in.
    const all = req.query.allSpaces === '1';
    const sc = all ? null : scope(req.user.id, reqSpace(req));
    let ids = req.query.calendars ? String(req.query.calendars).split(',').map(Number) : null;
    if (sc) ids = (ids || sc.calendarIds).filter((id) => sc.calendarIds.includes(id));
    const list = ids && !ids.length ? [] : repo.listRange(req.user.id, from, to, ids);
    if (!all) return [...list, ...blockedElsewhere(req, from, to, sc)].sort((a, b) => a.start - b.start);
    const spaces = spaceMap(req.user.id);
    return list.map((e) => ({ ...e, space: spaces.calendars.get(e.calendarId) || '' }));
  });

  // ---- an event from a read-only / information / shared calendar added to one's own calendar (calendar/linked.js)
  // In a shared space the copy goes to the person's own calendar.
  app.get('/api/events/link-targets', async (req) => all('SELECT id, name, color, is_default AS isDefault FROM calendars WHERE user_id = ? AND readonly = 0 AND enabled = 1 ORDER BY is_default DESC, name', req.person?.id || req.user.id));
  app.post('/api/events/:id/link', async (req, reply) => {
    try {
      const e = linkEvent(req.user.id, Number(req.params.id), req.person?.id || req.user.id, req.body?.calendarId ? Number(req.body.calendarId) : null);
      if (req.person) notify(req.person.id, 'calendar:changed', {});
      return repo.serializeEvent(e);
    } catch (e) { return httpError(reply, 400, e.message); }
  });
  app.post('/api/events/:id/unlink', async (req) => { unlinkEvent(req.user.id, Number(req.params.id)); notify(req.user.id, 'calendar:changed', {}); return { ok: true }; });

  /**
   * One person, one schedule: while a space is shown, time the user is busy in their other spaces — and, in a shared
   * space, in their own calendars — shows as "Blocked · <where>", without title, people or place.
   */
  function blockedElsewhere(req, from, to, sc) {
    const out = [];
    const mask = (e, label) => ({ instanceId: `blk:${e.instanceId}`, id: null, calendarId: null, start: e.start, end: e.end, allDay: e.allDay, title: `Blocked · ${label}`,
      blocked: true, busy: true, readonly: true, showAs: 'busy', color: '#9ca3af', calendarName: label });
    if (sc) {
      const spaces = spaceMap(req.user.id);
      const others = all('SELECT id FROM calendars WHERE user_id = ? AND enabled = 1', req.user.id).map((c) => c.id).filter((id) => !sc.calendarIds.includes(id));
      if (others.length) for (const e of repo.listRange(req.user.id, from, to, others, { includeInfo: false })) if (e.busy) out.push(mask(e, spaces.calendars.get(e.calendarId) || 'another space'));
    }
    if (req.person) {
      const spaces = spaceMap(req.person.id);
      for (const e of repo.listRange(req.person.id, from, to, null, { includeInfo: false })) if (e.busy) out.push(mask(e, spaces.calendars.get(e.calendarId) || 'my calendar'));
    }
    return out;
  }

  app.get('/api/events/search', async (req) => {
    const q = `%${req.query.q || ''}%`;
    const sc = scope(req.user.id, reqSpace(req));
    return all(`SELECT e.* FROM events e JOIN calendars c ON c.id = e.calendar_id WHERE c.user_id = ? AND ${inIds('c.id', sc?.calendarIds)} AND e.deleted = 0 AND (e.title LIKE ? OR e.location LIKE ? OR e.description LIKE ?) ORDER BY e.start DESC LIMIT 50`, req.user.id, q, q, q).map(repo.serializeEvent);
  });

  app.get('/api/events/:id', async (req, reply) => {
    const e = repo.eventOf(req.user.id, req.params.id);
    return e ? repo.serializeEvent(e) : httpError(reply, 404, 'Not found');
  });

  app.post('/api/events', async (req, reply) => {
    try {
      const { sendInvites, accountId, ...data } = req.body || {};
      const e = repo.createEvent(req.user.id, data);
      if (sendInvites && json(e.attendees_json, []).length) sendInvitations(req.user.id, e.id, { accountId });
      return repo.serializeEvent(e);
    } catch (err) { return httpError(reply, 400, err.message); }
  });

  // scope: 'all' (series) | 'this' (single occurrence, requires occurrence=<start ms>)
  app.patch('/api/events/:id', async (req, reply) => {
    const { scope, occurrence, sendInvites, accountId, ...patch } = req.body || {};
    try {
      let e;
      if (scope === 'this' && occurrence) e = repo.editOccurrence(req.user.id, Number(req.params.id), Number(occurrence), patch);
      else {
        // Moving a whole series via drag: shift by the delta from the dragged occurrence.
        const cur = repo.eventOf(req.user.id, req.params.id);
        if (!cur) return httpError(reply, 404, 'Not found');
        if (cur.rrule && occurrence && patch.start !== undefined) {
          const delta = Number(patch.start) - Number(occurrence);
          const dur = (patch.end ?? (Number(occurrence) + (cur.end - cur.start))) - patch.start;
          patch.start = cur.start + delta; patch.end = patch.start + dur;
        }
        e = repo.updateEvent(req.user.id, Number(req.params.id), patch);
      }
      if (!e) return httpError(reply, 404, 'Not found');
      if (sendInvites) sendInvitations(req.user.id, e.id, { accountId });
      return repo.serializeEvent(e);
    } catch (err) { return httpError(reply, 400, err.message); }
  });

  app.delete('/api/events/:id', async (req, reply) => {
    const { scope, occurrence, notify: notifyAttendees } = req.query;
    const e = repo.eventOf(req.user.id, req.params.id);
    if (!e) return httpError(reply, 404, 'Not found');
    if (e.readonly) return httpError(reply, 400, 'This calendar is read-only (a subscription)');
    if (scope === 'this' && occurrence) { repo.editOccurrence(req.user.id, e.id, Number(occurrence), null, { remove: true }); return { ok: true }; }
    if (notifyAttendees === '1') sendInvitations(req.user.id, e.id, { method: 'CANCEL' });
    repo.deleteEvent(req.user.id, e.id);
    return { ok: true };
  });

  app.get('/api/calendar/free-slots', async (req) => {
    const from = Number(req.query.from) || Date.now();
    return repo.findFreeSlots(req.user.id, from, Number(req.query.to) || from + 7 * 864e5, Number(req.query.duration) || 30);
  });

  app.post('/api/messages/:id/invitation/respond', async (req, reply) => {
    try { return respondToInvitation(req.user.id, Number(req.params.id), req.body?.response, { comment: req.body?.comment, sendReply: req.body?.sendReply !== false, calendarId: req.body?.calendarId }); } catch (e) { return httpError(reply, 400, e.message); }
  });
}

async function fetchIcs(url) {
  const r = await fetch(String(url).trim().replace(/^webcal:/i, 'https:'), { signal: AbortSignal.timeout(30e3), headers: { accept: 'text/calendar, */*' } });
  if (!r.ok) throw new Error(`the server answered ${r.status}`);
  const text = await r.text();
  if (!/BEGIN:VCALENDAR/.test(text)) throw new Error('this link does not return a calendar (iCal/ICS)');
  return text;
}

async function refreshSubscription(userId, calId) {
  const c = get('SELECT * FROM calendars WHERE id = ?', calId);
  try {
    const ics = await fetchIcs(c.url);
    tx(() => { run('DELETE FROM events WHERE calendar_id = ?', calId); importIcsInto(userId, calId, ics); });
    run('UPDATE calendars SET last_sync_at = ?, sync_error = NULL WHERE id = ?', now(), calId);
  } catch (e) {
    run('UPDATE calendars SET sync_error = ? WHERE id = ?', String(e.message || e).slice(0, 300), calId);
    throw e;
  }
  notify(userId, 'calendar:changed', {});
}

// Subscriptions and read-only CalDAV sources are refreshed every 30 minutes.
export function startSubscriptionRefresh() {
  setInterval(() => {
    for (const c of all("SELECT id, user_id FROM calendars WHERE source = 'subscription'")) refreshSubscription(c.user_id, c.id).catch(() => {});
    for (const s of all('SELECT id FROM calendar_sources')) syncCalendarSource(s.id).catch(() => {});
  }, 30 * 60e3).unref();
}
