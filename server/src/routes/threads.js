// Conversations pinned to the top of the list, and the user's private notes on a conversation (never sent, never
// shown to anyone else). Addressed by any message of the conversation (so a shared space's mail is pinned / noted in
// that space); stored per conversation: its thread id, or "m:<message id>" for a message without one.
import { get, run, now } from '../db/index.js';
import { requireUser } from '../auth.js';
import { httpError } from './util.js';
import { notify } from '../util/events.js';

const keyOf = (req) => {
  const m = get('SELECT id, thread_id FROM messages WHERE id = ? AND user_id = ?', Number(req.params.id), req.user.id);
  return m ? (m.thread_id || `m:${m.id}`) : null;
};

export default async function threadRoutes(app) {
  app.addHook('preHandler', requireUser);

  app.get('/api/messages/:id/pin', async (req, reply) => {
    const key = keyOf(req);
    return key ? { pinned: !!get('SELECT 1 AS x FROM pinned_threads WHERE user_id = ? AND thread_key = ?', req.user.id, key) } : httpError(reply, 404, 'Not found');
  });
  app.post('/api/messages/:id/pin', async (req, reply) => {
    const key = keyOf(req);
    if (!key) return httpError(reply, 404, 'Not found');
    if (req.body?.pinned === false) run('DELETE FROM pinned_threads WHERE user_id = ? AND thread_key = ?', req.user.id, key);
    else run('INSERT OR REPLACE INTO pinned_threads (user_id, thread_key, pinned_at) VALUES (?, ?, ?)', req.user.id, key, now());
    notify(req.user.id, 'mail:changed', { pinned: key });
    return { ok: true, pinned: req.body?.pinned !== false };
  });

  app.get('/api/messages/:id/note', async (req, reply) => {
    const key = keyOf(req);
    if (!key) return httpError(reply, 404, 'Not found');
    const r = get('SELECT note, updated_at FROM thread_notes WHERE user_id = ? AND thread_key = ?', req.user.id, key);
    return { note: r?.note || '', updatedAt: r?.updated_at || null };
  });
  app.put('/api/messages/:id/note', async (req, reply) => {
    const key = keyOf(req);
    if (!key) return httpError(reply, 404, 'Not found');
    const note = String(req.body?.note ?? '').slice(0, 10000);
    if (!note.trim()) run('DELETE FROM thread_notes WHERE user_id = ? AND thread_key = ?', req.user.id, key);
    else run('INSERT OR REPLACE INTO thread_notes (user_id, thread_key, note, updated_at) VALUES (?, ?, ?, ?)', req.user.id, key, note, now());
    notify(req.user.id, 'mail:changed', { note: key });
    return { ok: true, note: note.trim() ? note : '', updatedAt: now() };
  });
}
