import { requireUser, publicUser } from '../auth.js';
import { getSettings, saveSettings } from '../settings.js';
import { resumeWaiting } from '../ai/queue.js';
import { backfillAnalysis } from '../mail/pipeline.js';
import { oauthAvailable } from '../mail/oauth.js';
import { config } from '../config.js';
import { all, run, json } from '../db/index.js';
import { rezone } from '../util/time.js';

export default async function settingsRoutes(app) {
  app.get('/api/me', { preHandler: requireUser }, async (req) => ({
    user: publicUser(req.user), settings: getSettings(req.user.id), oauth: oauthAvailable(), singleUser: config.singleUser, version: '1.0.0',
  }));
  app.patch('/api/settings', { preHandler: requireUser }, async (req) => {
    const before = getSettings(req.user.id).calendar.timezone;
    const s = saveSettings(req.user.id, req.body || {});
    if (s.calendar.timezone !== before) rezoneInsights(req.user.id, before, s.calendar.timezone);
    if (req.body?.ai) { resumeWaiting(req.user.id); backfillAnalysis(req.user.id); }
    return s;
  });
}

// Times the AI read from mail ("Tuesday at 8:00") were converted with the old zone; keep their wall-clock reading.
function rezoneInsights(userId, from, to) {
  try { new Intl.DateTimeFormat('en', { timeZone: to }); } catch { return; }
  const rows = all(`SELECT i.message_id, i.events_json, i.expires_at FROM ai_insights i JOIN messages m ON m.id = i.message_id
    WHERE m.user_id = ? AND (i.events_json NOT IN ('', '[]') OR i.expires_at IS NOT NULL)`, userId);
  const shift = (iso) => new Date(rezone(Date.parse(iso), from, to)).toISOString();
  for (const r of rows) {
    const events = json(r.events_json, []).map((e) => ({ ...e, start: shift(e.start), end: shift(e.end) }));
    run('UPDATE ai_insights SET events_json = ?, expires_at = ? WHERE message_id = ?', JSON.stringify(events), r.expires_at && rezone(r.expires_at, from, to), r.message_id);
  }
}
