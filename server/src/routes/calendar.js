import { get, all, run, now, json } from '../db/index.js';
import { requireUser } from '../auth.js';
import { httpError } from './util.js';
import * as repo from '../calendar/repo.js';
import { buildIcs } from '../calendar/ics.js';
import { importIcsInto } from '../calendar/caldav.js';
import { respondToInvitation, sendInvitations } from '../calendar/invites.js';
import { notify } from '../util/events.js';
import { syncDav } from '../scheduler.js';
import { scope, reqSpace, spaceMap, inIds, cleanSpace } from '../spaces.js';

const calOut = (c, spaces) => ({ id: c.id, name: c.name, color: c.color, source: c.source, accountId: c.account_id, enabled: !!c.enabled, isDefault: !!c.is_default, readonly: !!c.readonly, url: c.source === 'subscription' ? c.url : undefined,
  space: spaces?.calendars.get(c.id) ?? '', ownSpace: c.space });

export default async function calendarRoutes(app) {
  app.addHook('preHandler', requireUser);

  app.get('/api/calendars', async (req) => {
    const sc = scope(req.user.id, reqSpace(req)), spaces = spaceMap(req.user.id);
    return all(`SELECT * FROM calendars WHERE user_id = ? AND ${inIds('id', sc?.calendarIds)} ORDER BY is_default DESC, name`, req.user.id).map((c) => calOut(c, spaces));
  });

  app.post('/api/calendars', async (req) => {
    const { name, color, url, space } = req.body || {};
    // url → read-only ICS subscription (e.g. holidays, shared calendars). New calendars belong to the active space.
    const r = run('INSERT INTO calendars (user_id, name, color, source, url, readonly, space, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      req.user.id, name || 'Calendar', color || '#10b981', url ? 'subscription' : 'local', url || null, url ? 1 : 0, cleanSpace(space ?? reqSpace(req)), now());
    if (url) await refreshSubscription(req.user.id, r.lastInsertRowid).catch(() => {});
    return calOut(get('SELECT * FROM calendars WHERE id = ?', r.lastInsertRowid), spaceMap(req.user.id));
  });

  app.patch('/api/calendars/:id', async (req, reply) => {
    const c = repo.userCalendar(req.user.id, req.params.id);
    if (!c) return httpError(reply, 404, 'Not found');
    const { name, color, enabled, isDefault } = req.body || {};
    if (isDefault) run('UPDATE calendars SET is_default = 0 WHERE user_id = ?', req.user.id);
    run('UPDATE calendars SET name = COALESCE(?, name), color = COALESCE(?, color), enabled = COALESCE(?, enabled), is_default = COALESCE(?, is_default) WHERE id = ?',
      name ?? null, color ?? null, enabled === undefined ? null : (enabled ? 1 : 0), isDefault ? 1 : null, c.id);
    notify(req.user.id, 'calendar:changed', {});
    return calOut(repo.userCalendar(req.user.id, c.id), spaceMap(req.user.id));
  });

  app.delete('/api/calendars/:id', async (req, reply) => {
    const c = repo.userCalendar(req.user.id, req.params.id);
    if (!c) return httpError(reply, 404, 'Not found');
    if (c.is_default && c.source === 'local') return httpError(reply, 400, 'Cannot delete the default calendar');
    run('DELETE FROM calendars WHERE id = ?', c.id);
    return { ok: true };
  });

  app.post('/api/calendars/:id/refresh', async (req, reply) => {
    const c = repo.userCalendar(req.user.id, req.params.id);
    if (!c) return httpError(reply, 404, 'Not found');
    if (c.source === 'subscription') await refreshSubscription(req.user.id, c.id);
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
    const sc = scope(req.user.id, reqSpace(req));
    let ids = req.query.calendars ? String(req.query.calendars).split(',').map(Number) : null;
    if (sc) ids = (ids || sc.calendarIds).filter((id) => sc.calendarIds.includes(id));
    return ids && !ids.length ? [] : repo.listRange(req.user.id, from, to, ids);
  });

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
    try { return respondToInvitation(req.user.id, Number(req.params.id), req.body?.response, { comment: req.body?.comment, sendReply: req.body?.sendReply !== false }); } catch (e) { return httpError(reply, 400, e.message); }
  });
}

async function refreshSubscription(userId, calId) {
  const c = get('SELECT * FROM calendars WHERE id = ?', calId);
  const url = c.url.replace(/^webcal:/i, 'https:');
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  run('DELETE FROM events WHERE calendar_id = ?', calId);
  importIcsInto(userId, calId, await r.text());
  notify(userId, 'calendar:changed', {});
}

export function startSubscriptionRefresh() {
  setInterval(() => {
    for (const c of all("SELECT id, user_id FROM calendars WHERE source = 'subscription'")) refreshSubscription(c.user_id, c.id).catch(() => {});
  }, 6 * 3600e3).unref();
}
