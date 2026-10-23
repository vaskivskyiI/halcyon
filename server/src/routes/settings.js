import { requireUser, publicUser } from '../auth.js';
import { getSettings, saveSettings, timezoneChanged } from '../settings.js';
import { resumeWaiting } from '../ai/queue.js';
import { backfillAnalysis } from '../mail/pipeline.js';
import { oauthAvailable } from '../mail/oauth.js';
import { config } from '../config.js';

export default async function settingsRoutes(app) {
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
