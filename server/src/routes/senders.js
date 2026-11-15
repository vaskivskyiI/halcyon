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
import { unsubscribePlan } from '../mail/lists.js';

const SKIP_FOLDERS = "COALESCE(f.special_use, '') NOT IN ('\\Sent', '\\Drafts', '\\Trash', '\\Junk')";

export default async function senderRoutes(app) {
  app.addHook('preHandler', requireUser);

  app.get('/api/senders', async (req) => {
    const days = Math.min(Math.max(Number(req.query.days) || 90, 7), 730);
    const sc = scope(req.user.id, reqSpace(req));
    const own = ownAddresses(req.user.id);
    const rows = all(`SELECT lower(m.from_addr) AS address, MAX(m.from_name) AS name, COUNT(*) AS total, SUM(m.is_read) AS seen, MAX(m.date) AS last,
        SUM(f.special_use = '\\Inbox') AS inbox, MAX(CASE WHEN m.list_unsubscribe IS NOT NULL AND COALESCE(li.list_post, 0) = 0 THEN m.id END) AS unsubscribeId,
        MAX(i.category) AS category
      FROM messages m JOIN folders f ON f.id = m.folder_id LEFT JOIN ai_insights i ON i.message_id = m.id LEFT JOIN list_info li ON li.message_id = m.id
      WHERE m.user_id = ? AND ${inIds('m.account_id', sc?.accountIds)} AND m.date > ? AND ${SKIP_FOLDERS} AND m.from_addr IS NOT NULL
      GROUP BY lower(m.from_addr) HAVING COUNT(*) >= 2 ORDER BY total DESC LIMIT 300`, req.user.id, Date.now() - days * 864e5);
    const rare = rareSenders(req.user.id), kept = keptSenders(req.user.id);
    const focus = new Set(focusSenders(req.user.id).filter((f) => f.focused).map((f) => f.address));
    // Unsubscribing here is only from the sender's own newsletter: mail they wrote to a discussion list is not theirs to stop.
    const msg = db.prepare('SELECT id, account_id, from_addr, list_unsubscribe FROM messages WHERE id = ?');
    return rows.filter((r) => !own.has(r.address)).map((r) => ({ ...r, plan: r.unsubscribeId ? unsubscribePlan(msg.get(r.unsubscribeId)) : null, inbox: r.inbox || 0, readRate: r.total ? Math.round((100 * (r.seen || 0)) / r.total) : 0,
      learned: rare.has(r.address), kept: kept.has(r.address), focused: focus.has(r.address) || focus.has(`@${r.address.split('@')[1]}`) }));
  });

  // Senders always in Focused (Settings → Mail; focus.js).
  app.get('/api/focus-senders', async (req) => focusSenders(req.user.id));
  app.post('/api/focus-senders', async (req, reply) => {
    try { return { address: setFocusSender(req.user.id, req.body?.address, req.body?.other ? 'other' : req.body?.focused !== false) }; } catch (e) { return reply.code(400).send({ error: e.message }); }
  });
  app.delete('/api/focus-senders', async (req) => ({ removed: forgetFocusSender(req.user.id, req.query.address) }));

  // Mail → Subscriptions: newsletters (one row per sender) and mailing lists (one row per list — mail people write to a
  // discussion list is grouped by the list, not shown as theirs), with their latest subjects, exactly what unsubscribing
  // does (mail/lists.js unsubscribePlan), and whether the user unsubscribed (and how much came after). People the user
  // writes to who also send something with List-Unsubscribe are not subscriptions.
  app.get('/api/subscriptions', async (req) => {
    const days = Math.min(Math.max(Number(req.query.days) || 90, 7), 730);
    const sc = scope(req.user.id, reqSpace(req));
    const own = ownAddresses(req.user.id);
    const done = new Map(all('SELECT address, method, at FROM unsubscribed WHERE user_id = ?', req.user.id).map((u) => [u.address, u]));
    const KEY = "CASE WHEN li.list_post = 1 AND li.list_id IS NOT NULL THEN 'list:' || li.list_id ELSE lower(m.from_addr) END";
    const base = `FROM messages m JOIN folders f ON f.id = m.folder_id LEFT JOIN list_info li ON li.message_id = m.id
      WHERE m.user_id = ? AND ${inIds('m.account_id', sc?.accountIds)} AND ${SKIP_FOLDERS} AND m.list_unsubscribe IS NOT NULL AND m.from_addr IS NOT NULL`;
    const rows = all(`SELECT ${KEY} AS address, MAX(CASE WHEN li.list_post = 1 THEN COALESCE(li.list_name, li.list_id) ELSE m.from_name END) AS name, MAX(li.list_post) AS isList,
        COUNT(*) AS total, SUM(m.is_read) AS seen, MAX(m.date) AS last, SUM(f.special_use = '\\Inbox') AS inbox, MAX(m.id) AS unsubscribeId
      ${base} AND m.date > ? GROUP BY ${KEY} ORDER BY total DESC LIMIT 500`, req.user.id, Date.now() - days * 864e5);
    const recent = db.prepare(`SELECT m.id, m.subject, m.date, m.is_read AS isRead, m.from_name AS fromName ${base} AND ${KEY} = ? ORDER BY m.date DESC LIMIT 5`);
    const after = db.prepare(`SELECT COUNT(*) AS n ${base} AND ${KEY} = ? AND m.date > ?`);
    const sentTo = db.prepare(`SELECT 1 AS x FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.user_id = ? AND f.special_use = '\\Sent'
      AND (lower(m.to_json) LIKE ? OR lower(m.cc_json) LIKE ?) LIMIT 1`);
    const personal = db.prepare(`SELECT COUNT(*) AS n FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.user_id = ? AND lower(m.from_addr) = ?
      AND m.list_unsubscribe IS NULL AND ${SKIP_FOLDERS}`);
    const msg = db.prepare('SELECT id, account_id, from_addr, list_unsubscribe FROM messages WHERE id = ?');
    return rows.filter((r) => !own.has(r.address)).filter((r) => {
      if (r.isList) return true;
      // A person: written to by the user and sending ordinary mail too.
      const like = `%"${r.address}"%`;
      return !(sentTo.get(req.user.id, like, like) && personal.get(req.user.id, r.address).n > 0);
    }).map((r) => {
      const u = done.get(r.address);
      // A day's grace: mail already on its way when the user unsubscribed is not "kept sending".
      return { ...r, isList: !!r.isList, inbox: r.inbox || 0, readRate: r.total ? Math.round((100 * (r.seen || 0)) / r.total) : 0,
        recent: recent.all(req.user.id, r.address), unsubscribedAt: u?.at || null, method: u?.method || null,
        since: u ? after.get(req.user.id, r.address, u.at + 864e5).n : 0, plan: unsubscribePlan(msg.get(r.unsubscribeId)) };
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
    // A mailing list (address 'list:<id>') is its list mail, not everything its writers sent.
    const all_ = [...new Set([req.body?.address, ...(Array.isArray(req.body?.addresses) ? req.body.addresses : [])].map((a) => String(a || '').toLowerCase()))];
    const lists = all_.filter((a) => a.startsWith('list:')).map((a) => a.slice(5)).slice(0, 200);
    const addresses = all_.filter((a) => !a.startsWith('list:') && a.includes('@')).slice(0, 1000);
    const action = req.body?.action;
    if ((!addresses.length && !lists.length) || !['archive', 'read'].includes(action)) return reply.code(400).send({ error: 'address and action (archive | read) needed' });
    const sc = scope(req.user.id, reqSpace(req));
    const where = action === 'archive' ? "f.special_use = '\\Inbox'" : `m.is_read = 0 AND ${SKIP_FOLDERS}`;
    const ids = all(`SELECT m.id FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.user_id = ? AND ${inIds('m.account_id', sc?.accountIds)}
      AND (lower(m.from_addr) IN (${addresses.map(() => '?').join(',') || "''"})
        OR m.id IN (SELECT message_id FROM list_info WHERE list_post = 1 AND list_id IN (${lists.map(() => '?').join(',') || "''"}))) AND ${where}`, req.user.id, ...addresses, ...lists).map((r) => r.id);
    if (!ids.length) return { count: 0 };
    if (action === 'archive') await actions.archiveMessages(req.user.id, ids);
    else actions.setFlags(req.user.id, ids, { read: true });
    notify(req.user.id, 'mail:changed', { ids });
    return { count: ids.length };
  });
}
