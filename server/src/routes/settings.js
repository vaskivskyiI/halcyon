import { requireUser, publicUser } from '../auth.js';
import { getSettings, saveSettings, timezoneChanged } from '../settings.js';
import { resumeWaiting } from '../ai/queue.js';
import { backfillAnalysis } from '../mail/pipeline.js';
import { oauthAvailable } from '../mail/oauth.js';
import { config } from '../config.js';

export default async function settingsRoutes(app) {
  app.get('/api/me', { preHandler: requireUser }, async (req) => ({
    user: publicUser(req.user), settings: getSettings(req.user.id), oauth: oauthAvailable(), singleUser: config.singleUser, version: '1.0.0',
    serverTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));
  app.patch('/api/settings', { preHandler: requireUser }, async (req) => {
    const old = getSettings(req.user.id);
    const s = saveSettings(req.user.id, req.body || {});
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
