// Who fills the mailbox: senders by how much they send and how much of it the user reads — newsletters never opened
// stand out, and are unsubscribed from and cleared out of the inbox in one go (Mail → More → Senders).
import { db, all } from '../db/index.js';
import { requireUser } from '../auth.js';
import { scope, reqSpace, inIds } from '../spaces.js';
import { ownAddresses } from '../ai/open-items.js';
import * as actions from '../mail/actions.js';
import { notify } from '../util/events.js';
import { rareSenders, keptSenders, keepSender } from '../ai/habits.js';
import { focusSenders, setFocusSender, forgetFocusSender } from '../focus.js';

const SKIP_FOLDERS = "COALESCE(f.special_use, '') NOT IN ('\\Sent', '\\Drafts', '\\Trash', '\\Junk')";

export default async function senderRoutes(app) {
  app.addHook('preHandler', requireUser);

  app.get('/api/senders', async (req) => {
    const days = Math.min(Math.max(Number(req.query.days) || 90, 7), 730);
    const sc = scope(req.user.id, reqSpace(req));
    const own = ownAddresses(req.user.id);
    const rows = all(`SELECT lower(m.from_addr) AS address, MAX(m.from_name) AS name, COUNT(*) AS total, SUM(m.is_read) AS seen, MAX(m.date) AS last,
        SUM(f.special_use = '\\Inbox') AS inbox, MAX(CASE WHEN m.list_unsubscribe IS NOT NULL THEN m.id END) AS unsubscribeId,
        MAX(i.category) AS category
      FROM messages m JOIN folders f ON f.id = m.folder_id LEFT JOIN ai_insights i ON i.message_id = m.id
      WHERE m.user_id = ? AND ${inIds('m.account_id', sc?.accountIds)} AND m.date > ? AND ${SKIP_FOLDERS} AND m.from_addr IS NOT NULL
      GROUP BY lower(m.from_addr) HAVING COUNT(*) >= 2 ORDER BY total DESC LIMIT 300`, req.user.id, Date.now() - days * 864e5);
    const rare = rareSenders(req.user.id), kept = keptSenders(req.user.id);
    const focus = new Set(focusSenders(req.user.id).filter((f) => f.focused).map((f) => f.address));
    return rows.filter((r) => !own.has(r.address)).map((r) => ({ ...r, inbox: r.inbox || 0, readRate: r.total ? Math.round((100 * (r.seen || 0)) / r.total) : 0,
      learned: rare.has(r.address), kept: kept.has(r.address), focused: focus.has(r.address) || focus.has(`@${r.address.split('@')[1]}`) }));
  });

  // Senders always in Focused (Settings → Mail; focus.js).
  app.get('/api/focus-senders', async (req) => focusSenders(req.user.id));
  app.post('/api/focus-senders', async (req, reply) => {
    try { return { address: setFocusSender(req.user.id, req.body?.address, req.body?.focused !== false) }; } catch (e) { return reply.code(400).send({ error: e.message }); }
  });
  app.delete('/api/focus-senders', async (req) => ({ removed: forgetFocusSender(req.user.id, req.query.address) }));

  // Mail → Subscriptions: senders of list mail (List-Unsubscribe) with their latest subjects, and whether the user
  // unsubscribed (and how much came after).
  app.get('/api/subscriptions', async (req) => {
    const days = Math.min(Math.max(Number(req.query.days) || 90, 7), 730);
    const sc = scope(req.user.id, reqSpace(req));
    const own = ownAddresses(req.user.id);
    const done = new Map(all('SELECT address, method, at FROM unsubscribed WHERE user_id = ?', req.user.id).map((u) => [u.address, u]));
    const rows = all(`SELECT lower(m.from_addr) AS address, MAX(m.from_name) AS name, COUNT(*) AS total, SUM(m.is_read) AS seen, MAX(m.date) AS last,
        SUM(f.special_use = '\\Inbox') AS inbox, MAX(m.id) AS unsubscribeId
      FROM messages m JOIN folders f ON f.id = m.folder_id
      WHERE m.user_id = ? AND ${inIds('m.account_id', sc?.accountIds)} AND m.date > ? AND ${SKIP_FOLDERS} AND m.list_unsubscribe IS NOT NULL AND m.from_addr IS NOT NULL
      GROUP BY lower(m.from_addr) ORDER BY total DESC LIMIT 500`, req.user.id, Date.now() - days * 864e5);
    const mine = `m.user_id = ? AND m.from_addr = ? AND ${inIds('m.account_id', sc?.accountIds)} AND ${SKIP_FOLDERS}`;
    const recent = db.prepare(`SELECT m.id, m.subject, m.date, m.is_read AS isRead FROM messages m JOIN folders f ON f.id = m.folder_id WHERE ${mine} ORDER BY m.date DESC LIMIT 5`);
    const after = db.prepare(`SELECT COUNT(*) AS n FROM messages m JOIN folders f ON f.id = m.folder_id WHERE ${mine} AND m.date > ?`);
    return rows.filter((r) => !own.has(r.address)).map((r) => {
      const u = done.get(r.address);
      // A day's grace: mail already on its way when the user unsubscribed is not "kept sending".
      return { ...r, inbox: r.inbox || 0, readRate: r.total ? Math.round((100 * (r.seen || 0)) / r.total) : 0,
        recent: recent.all(req.user.id, r.address), unsubscribedAt: u?.at || null, method: u?.method || null,
        since: u ? after.get(req.user.id, r.address, u.at + 864e5).n : 0 };
    });
  });

  // "Rarely read" learned from habit (ai/habits.js): keep = true treats the sender normally again; false lets it learn.
  app.post('/api/senders/habit', async (req, reply) => {
    const address = String(req.body?.address || '').toLowerCase();
    if (!address.includes('@')) return reply.code(400).send({ error: 'address needed' });
    keepSender(req.user.id, address, !!req.body?.keep);
    return { ok: true, learned: rareSenders(req.user.id).has(address) };
  });

  // Everything from a sender (or several: addresses) out of the inbox (archived) or marked read; undo goes through the
  // usual list undo.
  app.post('/api/senders/action', async (req, reply) => {
    const addresses = [...new Set([req.body?.address, ...(Array.isArray(req.body?.addresses) ? req.body.addresses : [])]
      .map((a) => String(a || '').toLowerCase()).filter((a) => a.includes('@')))].slice(0, 1000);
    const action = req.body?.action;
    if (!addresses.length || !['archive', 'read'].includes(action)) return reply.code(400).send({ error: 'address and action (archive | read) needed' });
    const sc = scope(req.user.id, reqSpace(req));
    const where = action === 'archive' ? "f.special_use = '\\Inbox'" : `m.is_read = 0 AND ${SKIP_FOLDERS}`;
    const ids = all(`SELECT m.id FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.user_id = ? AND ${inIds('m.account_id', sc?.accountIds)}
      AND lower(m.from_addr) IN (${addresses.map(() => '?').join(',')}) AND ${where}`, req.user.id, ...addresses).map((r) => r.id);
    if (!ids.length) return { count: 0 };
    if (action === 'archive') await actions.archiveMessages(req.user.id, ids);
    else actions.setFlags(req.user.id, ids, { read: true });
    notify(req.user.id, 'mail:changed', { ids });
    return { count: ids.length };
  });
}
