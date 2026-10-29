// Who fills the mailbox: senders by how much they send and how much of it the user reads — newsletters never opened
// stand out, and are unsubscribed from and cleared out of the inbox in one go (Mail → More → Senders).
import { all } from '../db/index.js';
import { requireUser } from '../auth.js';
import { scope, reqSpace, inIds } from '../spaces.js';
import { ownAddresses } from '../ai/open-items.js';
import * as actions from '../mail/actions.js';
import { notify } from '../util/events.js';
import { rareSenders, keptSenders, keepSender } from '../ai/habits.js';

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
    return rows.filter((r) => !own.has(r.address)).map((r) => ({ ...r, inbox: r.inbox || 0, readRate: r.total ? Math.round((100 * (r.seen || 0)) / r.total) : 0,
      learned: rare.has(r.address), kept: kept.has(r.address) }));
  });

  // "Rarely read" learned from habit (ai/habits.js): keep = true treats the sender normally again; false lets it learn.
  app.post('/api/senders/habit', async (req, reply) => {
    const address = String(req.body?.address || '').toLowerCase();
    if (!address.includes('@')) return reply.code(400).send({ error: 'address needed' });
    keepSender(req.user.id, address, !!req.body?.keep);
    return { ok: true, learned: rareSenders(req.user.id).has(address) };
  });

  // Everything from a sender out of the inbox (archived) or marked read; undo goes through the usual list undo.
  app.post('/api/senders/action', async (req, reply) => {
    const address = String(req.body?.address || '').toLowerCase();
    const action = req.body?.action;
    if (!address.includes('@') || !['archive', 'read'].includes(action)) return reply.code(400).send({ error: 'address and action (archive | read) needed' });
    const sc = scope(req.user.id, reqSpace(req));
    const where = action === 'archive' ? "f.special_use = '\\Inbox'" : `m.is_read = 0 AND ${SKIP_FOLDERS}`;
    const ids = all(`SELECT m.id FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.user_id = ? AND ${inIds('m.account_id', sc?.accountIds)}
      AND lower(m.from_addr) = ? AND ${where}`, req.user.id, address).map((r) => r.id);
    if (!ids.length) return { count: 0 };
    if (action === 'archive') await actions.archiveMessages(req.user.id, ids);
    else actions.setFlags(req.user.id, ids, { read: true });
    notify(req.user.id, 'mail:changed', { ids });
    return { count: ids.length };
  });
}
