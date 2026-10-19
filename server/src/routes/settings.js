import { requireUser, publicUser } from '../auth.js';
import { getSettings, saveSettings } from '../settings.js';
import { resumeWaiting } from '../ai/queue.js';
import { oauthAvailable } from '../mail/oauth.js';
import { config } from '../config.js';

export default async function settingsRoutes(app) {
  app.get('/api/me', { preHandler: requireUser }, async (req) => ({
    user: publicUser(req.user), settings: getSettings(req.user.id), oauth: oauthAvailable(), singleUser: config.singleUser, version: '1.0.0',
  }));
  app.patch('/api/settings', { preHandler: requireUser }, async (req) => {
    const s = saveSettings(req.user.id, req.body || {});
    if (req.body?.ai) resumeWaiting(req.user.id);
    return s;
  });
}
