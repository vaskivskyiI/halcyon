import { requireUser, publicUser } from '../auth.js';
import { getSettings, saveSettings, timezoneChanged } from '../settings.js';
import { resumeWaiting } from '../ai/queue.js';
import { backfillAnalysis } from '../mail/pipeline.js';
import { oauthAvailable } from '../mail/oauth.js';
import { config } from '../config.js';
import { run } from '../db/index.js';
import { vapidKeys, subscribe, unsubscribe, devices, notifyUser, registerFcm, unregisterFcm, removeDevice } from '../notifications.js';
import { fcmAccount, fcmError } from '../fcm.js';

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
    try { return { ok: true, replaced: registerFcm(req.person?.id || req.user.id, req.body?.token, req.body?.device) }; } catch (e) { return reply.code(400).send({ error: e.message }); }
  });
  app.delete('/api/push/devices/:kind/:id', { preHandler: requireUser }, async (req) => ({ removed: removeDevice(req.person?.id || req.user.id, req.params.kind, req.params.id) }));
  app.post('/api/push/fcm/unregister', { preHandler: requireUser }, async (req) => ({ removed: unregisterFcm(req.person?.id || req.user.id, req.body?.token) }));
  app.post('/api/push/test', { preHandler: requireUser }, async (req) => {
    const uid = req.person?.id || req.user.id;
    const { inQuietHours, prefsOf } = await import('../notifications.js');
    if (inQuietHours(uid, prefsOf(uid))) return { ok: false, quiet: true };
    notifyUser(uid, 'reminder', { title: 'Halcyon', body: 'Notifications work on this device.', url: '#/settings/notifications', tag: 'test' });
    return { ok: true };
  });

  // In a shared space (req.person set) mail, calendar and AI settings are the space's; how the app looks, its language
  // and notifications stay the person's own.
  const PERSONAL = ['ui', 'notifications'];
  const settingsFor = (req) => {
    const s = getSettings(req.user.id);
    if (!req.person) return s;
    const p = getSettings(req.person.id);
    return { ...s, ...Object.fromEntries(PERSONAL.map((k) => [k, p[k]])) };
  };
  app.get('/api/me', { preHandler: requireUser }, async (req) => ({
    user: publicUser(req.person || req.user), settings: settingsFor(req), oauth: oauthAvailable(), singleUser: config.singleUser, version: '1.0.0',
    serverTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone, acting: req.person ? { id: req.user.id, name: req.user.name } : null,
  }));
  app.patch('/api/settings', { preHandler: requireUser }, async (req) => {
    const body = { ...(req.body || {}) };
    if (req.person) {
      const own = Object.fromEntries(PERSONAL.filter((k) => body[k]).map((k) => [k, body[k]]));
      for (const k of PERSONAL) delete body[k];
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
      setImmediate(() => { try { resumeWaiting(userId); backfillAnalysis(userId); } catch (e) { req.log.error(e); } });
    }
    return s;
  });
}
