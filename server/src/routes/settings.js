import { requireUser, publicUser, ownerOnlyMessage, homeSpace } from '../auth.js';
import { dropPersonalStarters } from '../shared.js';
import { getSettings, saveSettings, timezoneChanged } from '../settings.js';
import { resumeWaiting } from '../ai/queue.js';
import { backfillAnalysis } from '../mail/pipeline.js';
import { oauthAvailable } from '../mail/oauth.js';
import { config } from '../config.js';
import { run, get } from '../db/index.js';
import { vapidKeys, subscribe, unsubscribe, devices, notifyUser, registerFcm, unregisterFcm, removeDevice, closeNotifications } from '../notifications.js';
import { fcmAccount, fcmError } from '../fcm.js';
import { httpError } from './util.js';
import { tomorrowMorning, snoozeReminder, snoozeUntil, quickReply } from '../notify-actions.js';

export default async function settingsRoutes(app) {
  // ---- Web Push (notifications.js): this device subscribes / unsubscribes; a test notification.
  app.get('/api/push/key', { preHandler: requireUser }, async () => ({ publicKey: vapidKeys().publicKey }));
  app.get('/api/push/devices', { preHandler: requireUser }, async (req) => devices(req.person?.id || req.user.id));
  app.post('/api/push/subscribe', { preHandler: requireUser }, async (req, reply) => {
    try {
      subscribe(req.person?.id || req.user.id, req.body?.subscription, req.body?.device);
      run("INSERT OR REPLACE INTO app_state (key, value) VALUES ('public_host', ?)", String(req.hostname || '').split(':')[0] || 'localhost');
      return { ok: true };
    } catch (e) { return reply.code(400).send({ error: e.message }); }
  });
  app.post('/api/push/unsubscribe', { preHandler: requireUser }, async (req) => ({ removed: unsubscribe(req.person?.id || req.user.id, req.body?.endpoint) }));
  // ---- The native Android app (FCM): whether this server can reach it; its token registered / removed.
  app.get('/api/push/fcm', { preHandler: requireUser }, async () => ({ available: !!fcmAccount(), error: fcmError() }));
  app.post('/api/push/fcm/register', { preHandler: requireUser }, async (req, reply) => {
    if (!fcmAccount()) return reply.code(409).send({ error: 'This server is not set up for Android notifications (HALCYON_FCM_SERVICE_ACCOUNT)' });
    try { return { ok: true, replaced: registerFcm(req.person?.id || req.user.id, req.body?.token, req.body?.device, req.body?.version) }; } catch (e) { return reply.code(400).send({ error: e.message }); }
  });
  app.delete('/api/push/devices/:kind/:id', { preHandler: requireUser }, async (req) => ({ removed: removeDevice(req.person?.id || req.user.id, req.params.kind, req.params.id) }));
  // A notification opened or swiped away on one device: taken back on the others too.
  app.post('/api/push/close', { preHandler: requireUser }, async (req) => { await closeNotifications(req.user.id, [req.body?.tag]); return { ok: true }; });
  // A button pressed on a notification (notify-actions.js): done through the same routes the app uses (as the same
  // user, in the same space), then the notification is taken back everywhere.
  app.post('/api/push/action', { preHandler: requireUser }, async (req, reply) => {
    const { ref = '', action = '', tag = '', text = '' } = req.body || {};
    const [kind, a, b] = String(ref).split(':');
    const headers = Object.fromEntries(['cookie', 'authorization', 'x-halcyon-as'].filter((h) => req.headers[h]).map((h) => [h, req.headers[h]]));
    const call = async (method, url, payload) => {
      const r = await app.inject({ method, url, payload, headers });
      if (r.statusCode >= 400) throw Object.assign(new Error(r.json()?.error || `Failed (${r.statusCode})`), { statusCode: r.statusCode });
    };
    const MAIL = { read: 'read', archive: 'archive', snooze: 'snooze', delete: 'trash', flag: 'flag', spam: 'spam' };
    const ids = kind === 'mail' ? String(a || '').split(',').map(Number).filter(Boolean).slice(0, 500) : [];
    if (kind === 'mail' && !ids.length) return httpError(reply, 400, 'Nothing to act on');
    if (kind === 'mail' && action === 'reply') {
      // Typed in the notification (Android): sent as a reply, with the usual undo delay.
      if (!String(text).trim()) return httpError(reply, 400, 'Nothing to send');
      await call('POST', '/api/send', quickReply(req.user.id, ids[0], String(text).trim().slice(0, 20000)));
      await call('POST', '/api/messages/actions', { action: 'read', ids: [ids[0]] });
    } else if (kind === 'mail' && MAIL[action]) {
      await call('POST', '/api/messages/actions', { action: MAIL[action], ids, ...(action === 'snooze' ? { until: tomorrowMorning(req.user.id) } : {}) });
    } else if (kind === 'task' && action === 'done') await call('PATCH', `/api/tasks/${Number(a)}`, { done: true });
    else if ((kind === 'task' && ['snooze', 'tomorrow'].includes(action)) || (kind === 'event' && ['snooze', 'snooze15'].includes(action))) {
      const own = kind === 'task' ? get('SELECT 1 AS x FROM tasks WHERE id = ? AND user_id = ?', Number(a), req.user.id)
        : get('SELECT 1 AS x FROM events e JOIN calendars c ON c.id = e.calendar_id WHERE e.id = ? AND c.user_id = ?', Number(a), req.user.id);
      if (!own) return httpError(reply, 404, 'Not found');
      snoozeReminder(req.user.id, kind === 'task' ? `task:${Number(a)}` : `event:${Number(a)}:${Number(b) || 0}`, snoozeUntil(req.user.id, kind, action));
    } else if (!['dismiss', 'join'].includes(action)) return httpError(reply, 400, 'Unknown action');
    await closeNotifications(req.user.id, [tag]);
    return { ok: true };
  });
  app.post('/api/push/fcm/unregister', { preHandler: requireUser }, async (req) => ({ removed: unregisterFcm(req.person?.id || req.user.id, req.body?.token) }));
  app.post('/api/push/test', { preHandler: requireUser }, async (req) => {
    const uid = req.person?.id || req.user.id;
    const { inQuietHours, prefsOf } = await import('../notifications.js');
    if (inQuietHours(uid, prefsOf(uid))) return { ok: false, quiet: true };
    notifyUser(uid, 'reminder', { title: 'Halcyon', body: 'Notifications work on this device.', url: '#/settings/notifications', tag: 'test' });
    return { ok: true };
  });

  // In a shared space (req.person set) mail, calendar and AI settings are the space's, set once by its owners; how the
  // app looks, its language, notifications and one's habits in writing and reading mail stay the person's own.
  const PERSONAL = ['ui', 'notifications'];
  const HABITS = ['undoSendSeconds', 'loadRemoteImages', 'markReadAfterMs', 'replyAllDefault', 'composeFormat'];
  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));
  const settingsFor = (req) => {
    const s = getSettings(req.user.id);
    if (!req.person) return s;
    const p = getSettings(req.person.id);
    return { ...s, ...Object.fromEntries(PERSONAL.map((k) => [k, p[k]])), mail: { ...s.mail, ...pick(p.mail, HABITS) } };
  };
  app.get('/api/me', { preHandler: requireUser }, async (req) => {
    // Working in the home space (a login with only shared spaces): its own empty starters are not needed.
    if (req.person && homeSpace(req.person.id) === req.user.id) dropPersonalStarters(req.person.id);
    return {
    user: publicUser(req.person || req.user), settings: settingsFor(req), oauth: oauthAvailable(), singleUser: config.singleUser, version: '1.0.0',
    serverTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone, acting: req.person ? { id: req.user.id, name: req.user.name, role: req.spaceRole } : null,
    };
  });
  app.patch('/api/settings', { preHandler: requireUser }, async (req, reply) => {
    const body = { ...(req.body || {}) };
    if (req.person) {
      const own = { ...pick(body, PERSONAL), ...(body.mail && Object.keys(pick(body.mail, HABITS)).length ? { mail: pick(body.mail, HABITS) } : {}) };
      for (const k of PERSONAL) delete body[k];
      if (body.mail) { body.mail = { ...body.mail }; for (const k of HABITS) delete body.mail[k]; if (!Object.keys(body.mail).length) delete body.mail; }
      // The space's time zone is its owners' choice; a member's device zone never moves it.
      if (body.calendar) { body.calendar = { ...body.calendar }; delete body.calendar.tzAuto; if (!Object.keys(body.calendar).length) delete body.calendar; }
      if (Object.keys(body).length && req.spaceRole !== 'owner') return reply.code(403).send({ error: ownerOnlyMessage, code: 'owner-only' });
      if (Object.keys(own).length) saveSettings(req.person.id, own);
    }
    const old = getSettings(req.user.id);
    const saved = saveSettings(req.user.id, body);
    const s = req.person ? settingsFor(req) : saved;
    if (s.calendar.timezone !== old.calendar.timezone) timezoneChanged(req.user.id, old.calendar.timezone, s.calendar.timezone);
    // Looking for mail still to analyse scans the whole mailbox: only when a setting that changes the answer changed
    // (or a provider/route may now work), and after the reply, so a switch in Settings flips at once.
    const ai = ['enabled', 'autoAnalyze', 'analyzeDays', 'analyzeFolders', 'embeddings', 'routes', 'privacyMode'];
    if (ai.some((k) => JSON.stringify(s.ai[k]) !== JSON.stringify(old.ai[k]))) {
      const userId = req.user.id;
      setImmediate(() => { try { resumeWaiting(userId); backfillAnalysis(userId).catch((e) => req.log.error(e)); } catch (e) { req.log.error(e); } });
    }
    return s;
  });
}
