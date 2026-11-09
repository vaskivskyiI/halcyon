import { requireUser } from '../auth.js';

const BODIES = 40, LIST = 200, MAX_BODY = 300e3;

/**
 * What a device keeps to show without a connection (web/public/sw.js stands in with it when the server cannot be
 * reached and it has no copy of that exact request): the newest mail of all inboxes with the bodies of the newest
 * ones, the open tasks, and the events from two weeks ago to six weeks ahead. Made from the app's own routes (as the
 * same user, in the same space), so the shapes are what the app reads.
 */
export default async function offlineRoutes(app) {
  app.get('/api/offline/pack', { preHandler: requireUser }, async (req) => {
    const headers = Object.fromEntries(['cookie', 'authorization', 'x-halcyon-as', 'x-halcyon-space', 'x-halcyon-tz'].filter((h) => req.headers[h]).map((h) => [h, req.headers[h]]));
    const get = async (url) => { const r = await app.inject({ method: 'GET', url, headers }); return r.statusCode === 200 ? r.json() : null; };
    const t = Date.now();
    const [list, tasks, events] = await Promise.all([
      get(`/api/messages?view=unified&limit=${LIST}`), get('/api/tasks'), get(`/api/events?from=${t - 14 * 864e5}&to=${t + 42 * 864e5}`),
    ]);
    const bodies = {};
    for (const m of (list?.items || []).slice(0, BODIES)) {
      const b = await get(`/api/messages/${m.id}`);
      if (b && (b.html || '').length + (b.text || '').length < MAX_BODY) bodies[b.id] = b;
    }
    return { at: t, list, bodies, tasks: tasks || [], events: events || [], range: { from: t - 14 * 864e5, to: t + 42 * 864e5 } };
  });
}
