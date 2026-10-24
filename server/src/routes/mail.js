import { db, get, all, run, json, now, update } from '../db/index.js';
import { requireUser } from '../auth.js';
import { ids, httpError } from './util.js';
import { serializeMessage, readRaw, parseRaw, messageRow, senderOf, inviteText, icsOf } from '../mail/store.js';
import { sanitizeEmailHtml, htmlToText } from '../mail/sanitize.js';
import * as actions from '../mail/actions.js';
import { queueSend, cancelSend, buildMime, saveDraft, saveDraftToServer, deleteDraft, draftFromMessage } from '../mail/send.js';
import { queueOp, syncManager } from '../mail/sync.js';
import { serializeInsight } from '../ai/tasks.js';
import { hybridSearch, parseQuery, buildWhere, embedQuery, messageHits } from '../search.js';
import { invitationFor } from '../calendar/invites.js';
import { getSettings } from '../settings.js';
import { userAccounts } from '../accounts.js';
import { runRule } from '../rules.js';
import { contactByEmail } from '../contacts/service.js';
import { notify } from '../util/events.js';
import { scope, reqSpace, inIds } from '../spaces.js';
import { recordFeedback, correctInsight, similarRecent } from '../ai/learning.js';
import { enqueue } from '../ai/queue.js';
import { listCategories, saveCategory, categoryById, setTag, viewSql } from '../ai/custom.js';
import { CATEGORIES } from '../ai/prompts.js';
import { openReplySql, openActionSql, openChecker, supersededSql, NOISE as OPEN_NOISE } from '../ai/open-items.js';

const NOISE = "('newsletter','promotion','social','notification')";
const LIST_COLS = `m.id, m.account_id, m.folder_id, m.uid, m.message_id, m.thread_id, m.subject, m.from_name, m.from_addr, m.to_json, m.cc_json, m.bcc_json, m.reply_to_json,
  m.date, m.snippet, m.has_attachments, m.is_read, m.is_flagged, m.is_answered, m.is_forwarded, m.is_draft, m.local_copy, m.sender_json, m.snoozed_until, m.labels_json, m.ai_status, m.calendar_ics,
  i.summary AS ai_summary, i.category AS ai_category, i.priority AS ai_priority, i.needs_reply AS ai_needs_reply, i.is_phishing AS ai_phishing, i.draft_reply IS NOT NULL AS ai_has_draft,
  i.topic AS ai_topic, i.expires_at AS ai_expires_at, i.needs_reply_user AS ai_needs_reply_user, i.needs_action AS ai_needs_action, i.action_summary AS ai_action_summary, i.dismissed_at AS ai_dismissed,
  EXISTS (SELECT 1 FROM drafts dr JOIN messages dm ON dm.id = dr.in_reply_to WHERE dr.user_id = m.user_id AND dm.thread_id = m.thread_id) AS has_user_draft,
  (SELECT special_use FROM folders WHERE id = m.folder_id) AS folder_special,
  CASE WHEN i.needs_reply = 1 AND i.needs_reply_user IS NULL THEN ${supersededSql('reply')} ELSE 0 END AS ai_superseded_reply,
  CASE WHEN i.needs_action = 1 THEN ${supersededSql('action')} ELSE 0 END AS ai_superseded_action,
  (SELECT group_concat(category_id) FROM message_tags WHERE message_id = m.id AND source IN ('ai', 'user')) AS my_tags`;

// Message list orders (t = table prefix: 'm.' or '' inside the threaded CTE).
const SORTS = {
  date: (t) => `${t}date`,
  from: (t) => `lower(COALESCE(NULLIF(${t}from_name, ''), ${t}from_addr))`,
  subject: (t) => `lower(ltrim(${t}subject, ' '))`,
  size: (t) => `${t}size`,
  unread: (t) => `${t}is_read`,
  flagged: (t) => `${t}is_flagged`,
};

// open: openChecker(userId) — "reply needed" / "action" only while still open (same rules as the views).
function listItem(r, open) {
  return serializeMessage(r, {
    ai: r.ai_summary != null || r.ai_category != null ? { summary: r.ai_summary, category: r.ai_category, priority: r.ai_priority, needsReply: open ? open(r).reply : !!r.ai_needs_reply, isPhishing: !!r.ai_phishing, hasDraft: !!r.ai_has_draft,
      topic: r.ai_topic || null, expired: !!(r.ai_expires_at && r.ai_expires_at < Date.now()),
      needsAction: open ? open(r).action : !!r.ai_needs_action && !r.ai_dismissed, actionSummary: r.ai_action_summary || null } : null,
    hasDraft: !!r.has_user_draft, myCategories: r.my_tags ? String(r.my_tags).split(',').map(Number) : [],
    threadCount: r.thread_count || 1, threadUnread: r.thread_unread || 0, folder: { id: r.folder_id, specialUse: r.folder_special },
  });
}

const FOCUSED = `(i.message_id IS NULL OR (i.priority >= 40 AND COALESCE(i.category, '') NOT IN ${NOISE}) OR i.priority >= 70)`;

function scopeFor(userId, q, sc) {
  const where = ['m.user_id = ?', inIds('m.account_id', sc?.accountIds)], params = [userId];
  const view = q.view || 'unified';
  if (view === 'folder' && q.folderId) { where.push('m.folder_id = ?'); params.push(Number(q.folderId)); }
  else if (view === 'unified') where.push("m.folder_id IN (SELECT f.id FROM folders f WHERE f.special_use = '\\Inbox')");
  else if (view === 'flagged') where.push("m.is_flagged = 1 AND m.folder_id NOT IN (SELECT id FROM folders WHERE special_use IN ('\\Trash','\\Junk'))");
  else if (view === 'snoozed') where.push('m.snoozed_until IS NOT NULL');
  // Open items: one definition for lists, counts, search and the brief (ai/open-items.js).
  else if (view === 'needsreply') where.push(`${openReplySql(userId)} AND m.folder_id IN (SELECT id FROM folders WHERE special_use = '\\Inbox')`);
  else if (view === 'needsaction') where.push(`${openActionSql(userId)} AND m.folder_id IN (SELECT id FROM folders WHERE special_use = '\\Inbox')`);
  else if (view === 'important') where.push(`i.priority >= 70 AND i.dismissed_at IS NULL AND COALESCE(i.category, '') NOT IN ${OPEN_NOISE} AND m.date >= ${Date.now() - 30 * 864e5} AND m.folder_id IN (SELECT id FROM folders WHERE special_use = '\\Inbox')`);
  else if (view === 'topic' && q.topic) { where.push('lower(i.topic) = lower(?)'); params.push(String(q.topic)); }
  else if (view === 'category' && q.category) { where.push("i.category = ? AND m.folder_id NOT IN (SELECT id FROM folders WHERE special_use IN ('\\Trash','\\Junk'))"); params.push(String(q.category)); }
  else if (view === 'mycat' && q.customId) { const c = categoryById(userId, Number(q.customId)); where.push(c ? viewSql(userId, c) : '0'); }
  else if (view === 'label' && q.labelId) { where.push('EXISTS (SELECT 1 FROM json_each(m.labels_json) j WHERE j.value = ?)'); params.push(Number(q.labelId)); }
  else if (['sent', 'drafts', 'archive', 'trash', 'junk'].includes(view)) {
    const special = { sent: '\\Sent', drafts: '\\Drafts', archive: '\\Archive', trash: '\\Trash', junk: '\\Junk' }[view];
    where.push('m.folder_id IN (SELECT id FROM folders WHERE special_use = ?)'); params.push(special);
  }
  if (q.accountId) { where.push('m.account_id = ?'); params.push(Number(q.accountId)); }
  if (view !== 'snoozed') where.push('m.snoozed_until IS NULL');
  switch (q.filter) {
    case 'unread': where.push('m.is_read = 0'); break;
    case 'flagged': where.push('m.is_flagged = 1'); break;
    case 'attachments': where.push('m.has_attachments = 1'); break;
    case 'focused': where.push(FOCUSED); break;
    case 'other': where.push(`i.message_id IS NOT NULL AND i.priority < 70 AND (i.priority < 40 OR i.category IN ${NOISE})`); break;
    default: break;
  }
  if (q.category && view !== 'category') { where.push('i.category = ?'); params.push(q.category); }
  return { where, params };
}

export default async function mailRoutes(app) {
  app.addHook('preHandler', requireUser);

  // ---- folders
  app.get('/api/folders', async (req) => {
    const sc = scope(req.user.id, reqSpace(req));
    const accounts = userAccounts(req.user.id).filter((a) => !sc || sc.accountIds.includes(a.id));
    const acc = inIds('m.account_id', sc?.accountIds);
    const out = accounts.map((a) => ({
      accountId: a.id, email: a.email, name: a.name || a.email, color: a.color, syncState: a.sync_state, syncError: a.sync_error,
      folders: all('SELECT id, path, name, delimiter, special_use AS specialUse, parent_path AS parentPath, total, unread, sync_enabled AS syncEnabled FROM folders WHERE account_id = ? ORDER BY path', a.id),
    }));
    // Each count uses the same filter as its list and counts conversations (as the list shows them):
    // unread ones for mailboxes, all open ones for the AI views and the snoozed list.
    const threaded = getSettings(req.user.id).ui.conversationView;
    const countView = (view, unreadOnly) => {
      const { where, params } = scopeFor(req.user.id, { view }, sc);
      if (unreadOnly) where.push('m.is_read = 0');
      return get(`SELECT COUNT(${threaded ? 'DISTINCT m.thread_id' : '*'}) AS n FROM messages m LEFT JOIN ai_insights i ON i.message_id = m.id WHERE ${where.join(' AND ')}`, ...params).n;
    };
    // Unread conversations in some folders, through idx_messages_folder_unread (index only, no row reads).
    const unreadIn = (ids) => (ids.length ? get(`SELECT COUNT(${threaded ? 'DISTINCT thread_id' : '*'}) AS n FROM messages
      WHERE folder_id IN (${ids.map(() => '?').join(',')}) AND is_read = 0 AND snoozed_until IS NULL`, ...ids).n : 0);
    const counts = {
      unified: unreadIn(out.flatMap((a) => a.folders.filter((f) => f.specialUse === '\\Inbox').map((f) => f.id))), needsreply: countView('needsreply'), needsaction: countView('needsaction'), snoozed: countView('snoozed'),
      scheduled: get(`SELECT COUNT(*) AS n FROM outbox WHERE user_id = ? AND ${inIds('account_id', sc?.accountIds)} AND status IN ('queued','failed')`, req.user.id).n,
      // Messages that could not be sent (or are retrying after an error): the Outbox count turns red.
      outboxFailed: get(`SELECT COUNT(*) AS n FROM outbox WHERE user_id = ? AND ${inIds('account_id', sc?.accountIds)} AND (status = 'failed' OR (status = 'queued' AND error IS NOT NULL))`, req.user.id).n,
    };
    // Per folder through idx_messages_folder_unread (index only).
    const folderIds = out.flatMap((a) => a.folders.map((f) => f.id));
    const unreadByFolder = new Map(folderIds.length ? all(`SELECT folder_id AS id, COUNT(${threaded ? 'DISTINCT thread_id' : '*'}) AS n FROM messages
      WHERE folder_id IN (${folderIds.map(() => '?').join(',')}) AND is_read = 0 AND snoozed_until IS NULL GROUP BY folder_id`, ...folderIds).map((r) => [r.id, r.n]) : []);
    for (const a of out) for (const f of a.folders) f.unread = unreadByFolder.get(f.id) || 0;
    // Dynamic AI views: active topics and the categories present (excluding the generic ones), with unread counts.
    const recent = `FROM ai_insights i JOIN messages m ON m.id = i.message_id JOIN folders f ON f.id = m.folder_id
      WHERE m.user_id = ? AND ${acc} AND COALESCE(f.special_use, '') NOT IN ('\\Trash', '\\Junk') AND m.date > ?`;
    // Topics: those with something coming up soon (an open task's due date, an event, an open action) first, by how
    // soon; then the most recently active ones.
    const t0 = Date.now();
    const topics = all(`SELECT i.topic AS name, COUNT(*) AS count, COUNT(DISTINCT CASE WHEN m.is_read = 0 THEN m.thread_id END) AS unread, MAX(m.date) AS last,
        (SELECT MIN(t.due) FROM tasks t JOIN messages tm ON tm.id = t.source_message_id JOIN ai_insights ti ON ti.message_id = tm.id
          WHERE t.user_id = m.user_id AND t.done = 0 AND t.due > ${t0 - 864e5} AND lower(ti.topic) = lower(i.topic)) AS task_due,
        (SELECT MIN(e.start) FROM events e JOIN messages em ON em.id = e.source_message_id JOIN ai_insights ei ON ei.message_id = em.id
          WHERE em.user_id = m.user_id AND e.deleted = 0 AND e.start > ${t0} AND lower(ei.topic) = lower(i.topic)) AS event_at,
        SUM(CASE WHEN ${openActionSql(req.user.id)} THEN 1 ELSE 0 END) AS actions
      ${recent} AND i.topic IS NOT NULL GROUP BY lower(i.topic) HAVING count >= 2 ORDER BY last DESC LIMIT 40`, req.user.id, Date.now() - 60 * 864e5)
      .map((x) => ({ ...x, next: Math.min(x.task_due || Infinity, x.event_at || Infinity) }))
      .map((x) => ({ ...x, next: Number.isFinite(x.next) ? x.next : null }))
      .sort((a, b) => {
        const soon = (x) => (x.next && x.next < t0 + 14 * 864e5 ? x.next : null);
        if (soon(a) || soon(b)) return (soon(a) ?? Infinity) - (soon(b) ?? Infinity);
        return (b.actions > 0) - (a.actions > 0) || b.last - a.last;
      })
      .slice(0, 12).map(({ task_due: _t, event_at: _e, ...x }) => x);
    const categories = all(`SELECT i.category AS name, COUNT(*) AS count, COUNT(DISTINCT CASE WHEN m.is_read = 0 THEN m.thread_id END) AS unread ${recent} AND f.special_use = '\\Inbox'
      AND i.category NOT IN ('work', 'personal', 'other') GROUP BY i.category ORDER BY count DESC`, req.user.id, Date.now() - 30 * 864e5);
    return { accounts: out, counts, topics, categories, custom: listCategories(req.user.id) };
  });

  app.post('/api/folders', async (req, reply) => {
    const { accountId, name, parentPath } = req.body || {};
    const a = get('SELECT * FROM accounts WHERE id = ? AND user_id = ?', accountId, req.user.id);
    if (!a || !name) return httpError(reply, 400, 'Account and name required');
    const parent = parentPath && get('SELECT delimiter FROM folders WHERE account_id = ? AND path = ?', a.id, parentPath);
    const path = parentPath ? `${parentPath}${parent?.delimiter || '/'}${name}` : name;
    queueOp(a.id, 'createFolder', { path });
    return { ok: true, path };
  });

  app.patch('/api/folders/:id', async (req, reply) => {
    const f = get('SELECT f.* FROM folders f JOIN accounts a ON a.id = f.account_id WHERE f.id = ? AND a.user_id = ?', req.params.id, req.user.id);
    if (!f) return httpError(reply, 404, 'Not found');
    const { name, syncEnabled } = req.body || {};
    if (syncEnabled !== undefined) { run('UPDATE folders SET sync_enabled = ? WHERE id = ?', syncEnabled ? 1 : 0, f.id); syncManager.trigger(f.account_id, f.path); }
    if (name && name !== f.name) {
      const to = f.parent_path ? `${f.parent_path}${f.delimiter || '/'}${name}` : name;
      queueOp(f.account_id, 'renameFolder', { from: f.path, to });
    }
    return { ok: true };
  });

  app.delete('/api/folders/:id', async (req, reply) => {
    const f = get('SELECT f.* FROM folders f JOIN accounts a ON a.id = f.account_id WHERE f.id = ? AND a.user_id = ?', req.params.id, req.user.id);
    if (!f) return httpError(reply, 404, 'Not found');
    if (f.special_use) return httpError(reply, 400, 'System folders cannot be deleted');
    queueOp(f.account_id, 'deleteFolder', { path: f.path });
    return { ok: true };
  });

  app.post('/api/folders/:id/empty', async (req, reply) => {
    const f = get('SELECT f.* FROM folders f JOIN accounts a ON a.id = f.account_id WHERE f.id = ? AND a.user_id = ?', req.params.id, req.user.id);
    if (!f) return httpError(reply, 404, 'Not found');
    actions.deletePermanently(req.user.id, all('SELECT id FROM messages WHERE folder_id = ?', f.id).map((r) => r.id));
    return { ok: true };
  });

  app.post('/api/folders/:id/read-all', async (req) => {
    const list = all('SELECT id FROM messages WHERE folder_id = ? AND user_id = ? AND is_read = 0', req.params.id, req.user.id).map((r) => r.id);
    actions.setFlags(req.user.id, list, { read: true });
    return { ok: true, count: list.length };
  });

  app.post('/api/sync', async (req) => {
    for (const a of userAccounts(req.user.id)) syncManager.trigger(a.id);
    return { ok: true };
  });

  // ---- message lists
  // Unread conversations per tab of a list (Focused / Other / All), with the list's own filters.
  app.get('/api/messages/tab-counts', async (req) => {
    const sc = scope(req.user.id, reqSpace(req));
    const threaded = getSettings(req.user.id).ui.conversationView;
    // One pass over the unread mail of the view for all three tabs ("Other" = analysed and not focused).
    const { where, params } = scopeFor(req.user.id, { ...req.query, filter: undefined }, sc);
    where.push('m.is_read = 0');
    const unit = threaded ? 'm.thread_id' : 'm.id';
    const r = get(`SELECT COUNT(DISTINCT ${unit}) AS a, COUNT(DISTINCT CASE WHEN ${FOCUSED} THEN ${unit} END) AS f, COUNT(DISTINCT CASE WHEN NOT ${FOCUSED} THEN ${unit} END) AS o
      FROM messages m LEFT JOIN ai_insights i ON i.message_id = m.id WHERE ${where.join(' AND ')}`, ...params);
    return { focused: r.f, other: r.o, all: r.a };
  });

  app.get('/api/messages', async (req) => {
    const q = req.query;
    const sc = scope(req.user.id, reqSpace(req));
    const limit = Math.min(Number(q.limit) || 50, 200);
    if (q.q) {
      const found = await hybridSearch(req.user.id, q.q, { limit: 100, semantic: q.semantic !== '0', sc });
      if (!found.length) return { items: [], hasMore: false };
      const rows = all(`SELECT ${LIST_COLS} FROM messages m LEFT JOIN ai_insights i ON i.message_id = m.id WHERE m.id IN (${found.map(() => '?').join(',')})`, ...found);
      const byId = new Map(rows.map((r) => [r.id, r]));
      return { items: found.map((id) => byId.get(id)).filter(Boolean).map((r) => listItem(r, openChecker(req.user.id))), hasMore: false };
    }
    const { where, params } = scopeFor(req.user.id, q, sc);
    const threaded = q.threads !== '0' && getSettings(req.user.id).ui.conversationView;
    // Newest first pages by date (stable while mail arrives); other orders page by offset.
    const key = SORTS[q.sort] ? q.sort : 'date';
    const dir = q.dir === 'asc' ? 'ASC' : q.dir === 'desc' ? 'DESC' : (['date', 'size', 'flagged'].includes(key) ? 'DESC' : 'ASC');
    const byDate = key === 'date' && dir === 'DESC';
    const cursor = byDate ? Number(q.before) || 8.64e15 : 8.64e15;
    const offset = byDate ? 0 : Math.max(0, Number(q.offset) || 0);
    const order = (t) => `${SORTS[key](t)} ${dir}${key === 'date' ? '' : `, ${t}date DESC`}`;
    let rows;
    if (threaded && byDate) {
      // Newest conversations first: walk (id, thread, date) in date order — answered from an index, no row reads —
      // keeping each conversation's newest matching message, then load full rows for just those.
      const cond = where.join(' AND ');
      const reps = [];
      const seen = new Set();
      for (const r of db.prepare(`SELECT m.id, m.thread_id AS t, m.date FROM messages m LEFT JOIN ai_insights i ON i.message_id = m.id WHERE ${cond} ORDER BY m.date DESC`).iterate(...params)) {
        if (seen.has(r.t)) continue;
        seen.add(r.t);
        if (r.date >= cursor) continue;
        reps.push(r);
        if (reps.length > limit) break;
      }
      if (!reps.length) return { items: [], hasMore: false };
      const ph = (a) => a.map(() => '?').join(',');
      const threads = [...new Set(reps.map((r) => r.t))];
      const stats = new Map(all(`SELECT m.thread_id AS t, COUNT(*) AS n, SUM(1 - m.is_read) AS u FROM messages m LEFT JOIN ai_insights i ON i.message_id = m.id
        WHERE ${cond} AND m.thread_id IN (${ph(threads)}) GROUP BY m.thread_id`, ...params, ...threads).map((s) => [s.t, s]));
      const byId = new Map(all(`SELECT ${LIST_COLS}, m.size AS size FROM messages m LEFT JOIN ai_insights i ON i.message_id = m.id WHERE m.id IN (${ph(reps)})`, ...reps.map((r) => r.id)).map((r) => [r.id, r]));
      rows = reps.map((r) => byId.get(r.id)).filter(Boolean).map((r) => ({ ...r, thread_count: stats.get(r.thread_id)?.n || 1, thread_unread: stats.get(r.thread_id)?.u || 0 }));
    } else if (threaded) {
      rows = all(`WITH scoped AS (
          SELECT ${LIST_COLS}, m.size AS size, ROW_NUMBER() OVER (PARTITION BY m.thread_id ORDER BY m.date DESC) AS rn,
            COUNT(*) OVER (PARTITION BY m.thread_id) AS thread_count, SUM(1 - m.is_read) OVER (PARTITION BY m.thread_id) AS thread_unread
          FROM messages m LEFT JOIN ai_insights i ON i.message_id = m.id WHERE ${where.join(' AND ')})
        SELECT * FROM scoped WHERE rn = 1 AND date < ? ORDER BY ${order('')} LIMIT ? OFFSET ?`, ...params, cursor, limit + 1, offset);
    } else {
      rows = all(`SELECT ${LIST_COLS}, m.size AS size FROM messages m LEFT JOIN ai_insights i ON i.message_id = m.id WHERE ${where.join(' AND ')} AND m.date < ?
        ORDER BY ${order('m.')} LIMIT ? OFFSET ?`, ...params, cursor, limit + 1, offset);
    }
    return { items: rows.slice(0, limit).map((r) => listItem(r, openChecker(req.user.id))), hasMore: rows.length > limit };
  });

  function fullMessage(userId, m, allowRemote) {
    const settings = getSettings(userId);
    const sender = contactByEmail(userId, m.from_addr);
    const trusted = allowRemote || settings.mail.loadRemoteImages || !!sender;
    const { html, blockedRemote } = m.body_html ? sanitizeEmailHtml(m.body_html, { messageId: m.id, allowRemote: trusted }) : { html: null, blockedRemote: 0 };
    const ins = get('SELECT * FROM ai_insights WHERE message_id = ?', m.id);
    const folder = get('SELECT id, name, special_use FROM folders WHERE id = ?', m.folder_id);
    return serializeMessage(m, {
      html, text: m.body_text || (!m.body_html && m.calendar_ics ? inviteText(m.calendar_ics) : m.body_text), blockedRemote, attachments: json(m.attachments_json, []).filter((a) => !a.inline),
      listUnsubscribe: m.list_unsubscribe, insight: serializeInsight(ins), folder: folder && { id: folder.id, name: folder.name, specialUse: folder.special_use },
      senderContactId: sender?.id || null,
      myCategories: all("SELECT category_id AS id FROM message_tags WHERE message_id = ? AND source IN ('ai', 'user')", m.id).map((x) => x.id),
    });
  }

  // Tasks, events and draft replies that belong to these messages (shown at the top of the reader).
  function relatedTo(userId, msgIds) {
    if (!msgIds.length) return { tasks: [], events: [], drafts: [] };
    const inList = msgIds.map(Number).join(',');
    return {
      tasks: all(`SELECT id, title, due, done, source_message_id AS messageId FROM tasks WHERE user_id = ? AND source_message_id IN (${inList}) ORDER BY done, due`, userId),
      events: all(`SELECT e.id, e.title, e.start, e.end, e.all_day AS allDay, e.location, e.source_message_id AS messageId FROM events e JOIN calendars c ON c.id = e.calendar_id
        WHERE c.user_id = ? AND e.deleted = 0 AND e.source_message_id IN (${inList}) ORDER BY e.start`, userId).map((e) => ({ ...e, allDay: !!e.allDay })),
      // Replies to these messages, and drafts whose copy in the Drafts folder is part of the conversation; in full, so
      // the conversation shows them as editors.
      drafts: all(`SELECT * FROM drafts WHERE user_id = ? AND (in_reply_to IN (${inList})
          OR server_msgid IN (SELECT '<' || message_id || '>' FROM messages WHERE id IN (${inList}))) ORDER BY updated_at`, userId)
        .map((d) => { const p = json(d.payload_json, {}); return { ...draftOut(d), inReplyToId: d.in_reply_to, serverMsgid: d.server_msgid, snippet: htmlToText(String(p.html || '').split('data-quote')[0]).slice(0, 160) }; }),
    };
  }

  app.get('/api/messages/:id', async (req, reply) => {
    const m = get('SELECT * FROM messages WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!m) return httpError(reply, 404, 'Not found');
    await senderOf(m);
    await icsOf(m);
    return { ...fullMessage(req.user.id, m, req.query.images === '1'), related: relatedTo(req.user.id, [m.id]) };
  });

  // "Needs reply" set or cleared by the user, for one or many messages; it survives re-analysis.
  app.post('/api/messages/needs-reply', async (req) => {
    const value = req.body?.value ? 1 : 0;
    let own = ids(req.body?.ids).filter((id) => get('SELECT 1 AS x FROM messages WHERE id = ? AND user_id = ?', id, req.user.id));
    // The user's own verdict on the messages they chose — also taught to the AI for those senders (two "needs no
    // reply" in a row from a sender → not suggested again for them). Not for the rest of a conversation.
    for (const id of own) recordFeedback(req.user.id, get('SELECT * FROM messages WHERE id = ?', id), value ? 'reply' : 'noreply');
    // In conversation view a row stands for its conversation: "no reply needed" clears every message in it
    // (marking stays on the message itself).
    if (!value && req.body?.threads && own.length) {
      own = all(`SELECT DISTINCT i.message_id AS id FROM ai_insights i JOIN messages m ON m.id = i.message_id WHERE m.user_id = ? AND i.needs_reply = 1
        AND m.thread_id IN (SELECT thread_id FROM messages WHERE id IN (${own.join(',')}))`, req.user.id).map((r) => r.id).concat(own);
      own = [...new Set(own)];
    }
    for (const id of own) {
      if (get('SELECT 1 AS x FROM ai_insights WHERE message_id = ?', id)) run(`UPDATE ai_insights SET needs_reply = ?, needs_reply_user = ?, dismissed_at = CASE WHEN ? = 1 THEN NULL ELSE dismissed_at END,
        resolution = CASE WHEN ? = 1 AND resolution = 'replied' THEN NULL ELSE resolution END WHERE message_id = ?`, value, value, value, value, id);
      else run("INSERT INTO ai_insights (message_id, priority, needs_reply, needs_reply_user, category, model, created_at) VALUES (?, 50, ?, ?, 'other', 'user', ?)", id, value, value, Date.now());
      const m = get('SELECT thread_id FROM messages WHERE id = ?', id);
      notify(req.user.id, 'ai:insight', { messageId: id, threadId: m.thread_id, insight: serializeInsight(get('SELECT * FROM ai_insights WHERE message_id = ?', id)) });
    }
    return { ok: true, count: own.length };
  });

  app.get('/api/threads/:threadId', async (req) => {
    const rows = all('SELECT * FROM messages WHERE user_id = ? AND thread_id = ? ORDER BY date', req.user.id, req.params.threadId);
    // De-duplicate copies of the same message (e.g. in Sent and Inbox).
    // A copy that is still unread makes the message unread here, so opening the conversation marks every copy read
    // (Gmail keeps one in All Mail and one in the Inbox; Archive and Inbox can both hold one).
    const kept = new Map();
    // A sent message can share its Message-ID with the draft it was sent from (Gmail, Outlook): show the sent one.
    for (const m of rows) {
      const k = kept.get(m.message_id);
      if (!k) kept.set(m.message_id, { ...m });
      else {
        if (k.is_draft && !m.is_draft) kept.set(m.message_id, { ...m, is_read: k.is_read && m.is_read ? 1 : 0 });
        else if (!m.is_read) k.is_read = 0;
      }
    }
    const msgs = [...kept.values()];
    const summary = get('SELECT summary, message_count FROM thread_summaries WHERE user_id = ? AND thread_id = ?', req.user.id, req.params.threadId);
    for (const m of msgs) { await senderOf(m); await icsOf(m); }
    return { messages: msgs.map((m) => fullMessage(req.user.id, m, req.query.images === '1')), summary: summary?.summary || null, related: relatedTo(req.user.id, rows.map((m) => m.id)) };
  });

  app.get('/api/messages/:id/raw', async (req, reply) => {
    const m = get('SELECT * FROM messages WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    const raw = m && readRaw(m);
    if (!raw) return httpError(reply, 404, 'Not found');
    reply.header('content-type', 'message/rfc822');
    reply.header('content-disposition', `attachment; filename="${(m.subject || 'message').replace(/[^\w\- ]+/g, '').slice(0, 60) || 'message'}.eml"`);
    return raw;
  });

  async function attachmentOf(userId, id, pick) {
    const m = get('SELECT * FROM messages WHERE id = ? AND user_id = ?', id, userId);
    const raw = m && readRaw(m);
    if (!raw) return null;
    const parsed = await parseRaw(raw);
    return pick(parsed.attachments || []);
  }

  app.get('/api/messages/:id/attachments/:index', async (req, reply) => {
    const att = await attachmentOf(req.user.id, req.params.id, (list) => list[Number(req.params.index)]);
    if (!att) return httpError(reply, 404, 'Not found');
    reply.header('content-type', att.contentType || 'application/octet-stream');
    const disp = req.query.inline === '1' && /^(image\/|application\/pdf|text\/plain)/.test(att.contentType) ? 'inline' : 'attachment';
    reply.header('content-disposition', `${disp}; filename*=UTF-8''${encodeURIComponent(att.filename || 'attachment')}`);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-security-policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
    return att.content;
  });

  app.get('/api/messages/:id/cid/:cid', async (req, reply) => {
    const cid = decodeURIComponent(req.params.cid).replace(/^<|>$/g, '');
    const att = await attachmentOf(req.user.id, req.params.id, (list) => list.find((a) => (a.cid || '').replace(/^<|>$/g, '') === cid));
    if (!att || !/^image\//.test(att.contentType)) return httpError(reply, 404, 'Not found');
    reply.header('content-type', att.contentType);
    reply.header('cache-control', 'private, max-age=86400');
    reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox"); // e.g. scripted SVG opened directly
    return att.content;
  });

  app.post('/api/messages/actions', async (req, reply) => {
    const { action, folderId, until, labelId } = req.body || {};
    const list = ids(req.body?.ids);
    // Conversation view: act on the whole thread, except copies in Sent/Drafts.
    let target = list;
    if (req.body?.threads && list.length) {
      const threads = all(`SELECT DISTINCT thread_id FROM messages WHERE user_id = ? AND id IN (${list.map(() => '?').join(',')})`, req.user.id, ...list).map((r) => r.thread_id);
      target = all(`SELECT m.id FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.user_id = ? AND m.thread_id IN (${threads.map(() => '?').join(',')})
        AND COALESCE(f.special_use, '') NOT IN ('\\Sent', '\\Drafts')`, req.user.id, ...threads).map((r) => r.id);
      target = [...new Set([...target, ...list])];
    }
    const u = req.user.id;
    // Read / unread: the same email in other folders of the account (a copy in Archive, Gmail labels) follows, so it
    // does not stay unread elsewhere after it was read.
    if ((action === 'read' || action === 'unread') && target.length) {
      const copies = all(`SELECT c.id FROM messages c JOIN messages m ON m.account_id = c.account_id AND m.message_id = c.message_id
        WHERE m.user_id = ? AND m.id IN (${target.map(() => '?').join(',')}) AND c.id != m.id AND c.is_read = ?`, u, ...target, action === 'read' ? 0 : 1).map((r) => r.id);
      target = [...new Set([...target, ...copies])];
    }
    // Everything that moves mail can be undone: remember where it was.
    const undo = ['archive', 'trash', 'spam', 'notspam', 'move'].includes(action) ? actions.folderSnapshot(u, target) : null;
    switch (action) {
      case 'read': actions.setFlags(u, target, { read: true }); break;
      case 'unread': actions.setFlags(u, target, { read: false }); break;
      case 'flag': actions.setFlags(u, list, { flagged: true }); break;
      case 'unflag': actions.setFlags(u, target, { flagged: false }); break;
      case 'archive': await actions.archiveMessages(u, target); break;
      case 'trash': await actions.trashMessages(u, target); break;
      case 'delete': actions.deletePermanently(u, target); break;
      case 'spam': case 'notspam':
        // The user's verdict is remembered per sender (see ai/learning.js); the latest one wins.
        for (const id of list) recordFeedback(u, get('SELECT * FROM messages WHERE id = ? AND user_id = ?', id, u), action);
        await (action === 'spam' ? actions.spamMessages(u, target) : actions.notSpam(u, target));
        break;
      case 'move': await actions.moveMessages(u, target, Number(folderId)); break;
      case 'snooze': actions.snoozeMessages(u, target, Number(until)); break;
      case 'unsnooze': actions.snoozeMessages(u, target, null); break;
      case 'restore': await actions.restoreMessages(u, req.body.items); break;
      case 'label': actions.setLabels(u, target, { add: [labelId] }); break;
      case 'unlabel': actions.setLabels(u, target, { remove: [labelId] }); break;
      default: return httpError(reply, 400, 'Unknown action');
    }
    return { ok: true, count: target.length, undo };
  });

  // "Done" in the brief: the message leaves the brief, Important and Needs reply (it stays in its folder).
  app.post('/api/messages/:id/dismiss', async (req, reply) => {
    const m = get('SELECT id, thread_id FROM messages WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!m) return httpError(reply, 404, 'Not found');
    // resolution: 'done' (the user did it) or 'skipped' (decided not to act); both leave Action needed and the brief.
    const undo = req.body?.dismissed === false;
    // 'wrong': the AI was wrong — not an action for the user (learned for this sender, see ai/learning.js).
    const resolution = ['skipped', 'wrong'].includes(req.body?.resolution) ? req.body.resolution : 'done';
    if (!undo && resolution === 'wrong') recordFeedback(req.user.id, get('SELECT * FROM messages WHERE id = ?', m.id), 'noaction');
    run('UPDATE ai_insights SET dismissed_at = ?, resolution = ? WHERE message_id = ?', undo ? null : Date.now(), undo ? null : resolution, m.id);
    notify(req.user.id, 'ai:insight', { messageId: m.id, threadId: m.thread_id, insight: serializeInsight(get('SELECT * FROM ai_insights WHERE message_id = ?', m.id)) });
    return { ok: true };
  });

  // Corrections that teach the AI: kind = important | unimportant | category (value = category name).
  app.post('/api/messages/:id/feedback', async (req, reply) => {
    const m = get('SELECT * FROM messages WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!m) return httpError(reply, 404, 'Not found');
    const { kind, value, reason } = req.body || {};
    if (!['important', 'unimportant', 'category'].includes(kind) || (kind === 'category' && !CATEGORIES.includes(value))) return httpError(reply, 400, 'Invalid feedback');
    recordFeedback(req.user.id, m, kind, kind === 'category' ? value : null, reason);
    correctInsight(m.id, kind, value);
    // With a reason the AI applies it to similar mail: the recent mail it may fit is analysed again now.
    let rechecked = 0;
    if (String(reason || '').trim()) {
      const ids = similarRecent(req.user.id, { message_id: m.id, subject: m.subject, reason, domain: String(m.from_addr || '').toLowerCase().split('@')[1] || '' });
      for (const id of ids) enqueue(req.user.id, 'analyze', id, 40, { force: true });
      rechecked = ids.length;
    }
    const insight = serializeInsight(get('SELECT * FROM ai_insights WHERE message_id = ?', m.id));
    notify(req.user.id, 'ai:insight', { messageId: m.id, threadId: m.thread_id, insight });
    return { insight, sender: m.from_addr, rechecked };
  });

  app.post('/api/messages/:id/unsubscribe', async (req, reply) => {
    const m = get('SELECT * FROM messages WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!m?.list_unsubscribe) return httpError(reply, 400, 'No unsubscribe information');
    let header = m.list_unsubscribe;
    try { const o = JSON.parse(header); header = [o.url, o.mail && `mailto:${o.mail}`].filter(Boolean).map((x) => `<${x}>`).join(', '); } catch { /* raw header */ }
    const urls = [...header.matchAll(/<([^>]+)>/g)].map((x) => x[1]);
    const raw = readRaw(m);
    const oneClick = raw && /List-Unsubscribe-Post:\s*List-Unsubscribe=One-Click/i.test(raw.subarray(0, 20000).toString());
    const http = urls.find((u) => /^https:/i.test(u));
    if (http && oneClick) {
      try {
        const r = await fetch(http, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
        if (r.ok) return { ok: true, method: 'one-click' };
      } catch { /* fall through */ }
    }
    const mailto = urls.find((u) => /^mailto:/i.test(u));
    if (mailto) {
      const u = new URL(mailto);
      queueSend(req.user.id, { accountId: m.account_id, to: [u.pathname], subject: u.searchParams.get('subject') || 'unsubscribe', text: u.searchParams.get('body') || 'unsubscribe' });
      return { ok: true, method: 'mailto' };
    }
    if (http) return { ok: false, method: 'browser', url: http };
    return httpError(reply, 400, 'Unsubscribe not possible automatically');
  });

  app.get('/api/messages/:id/invitation', async (req) => invitationFor(req.user.id, Number(req.params.id)));
  // The calendar data as a file (open it in another calendar app when it cannot be read here).
  app.get('/api/messages/:id/invitation.ics', async (req, reply) => {
    const m = get('SELECT calendar_ics FROM messages WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!m?.calendar_ics) return httpError(reply, 404, 'No calendar data in this message');
    reply.header('content-type', 'text/calendar; charset=utf-8').header('content-disposition', 'attachment; filename="invitation.ics"');
    return m.calendar_ics;
  });

  // ---- sending
  app.post('/api/send', async (req, reply) => {
    const { sendAt, ...payload } = req.body || {};
    try {
      const delay = getSettings(req.user.id).mail.undoSendSeconds * 1000;
      return queueSend(req.user.id, payload, sendAt ? { sendAt: Number(sendAt) } : { delayMs: delay });
    } catch (e) { return httpError(reply, 400, e.message); }
  });

  app.get('/api/outbox', async (req) => all("SELECT id, account_id, payload_json, send_at, status, error, created_at, sent_at FROM outbox WHERE user_id = ? AND status != 'sent' ORDER BY send_at", req.user.id)
    .map((r) => { const p = json(r.payload_json, {}); return { id: r.id, accountId: r.account_id, sendAt: r.send_at, status: r.status, error: r.error, subject: p.subject, to: p.to, payload: p }; }));

  app.post('/api/outbox/:id/cancel', async (req, reply) => {
    const payload = cancelSend(req.user.id, Number(req.params.id));
    if (!payload) return httpError(reply, 409, 'Already sent');
    return { ok: true, payload };
  });

  app.post('/api/outbox/:id/retry', async (req) => {
    run("UPDATE outbox SET status = 'queued', attempts = 0, error = NULL, send_at = ? WHERE id = ? AND user_id = ? AND status != 'sent'", now(), req.params.id, req.user.id);
    notify(req.user.id, 'outbox:changed', {});
    return { ok: true };
  });

  // A message that could not be sent: keep it as a draft instead (nothing is sent).
  app.post('/api/outbox/:id/to-draft', async (req, reply) => {
    const row = get("SELECT * FROM outbox WHERE id = ? AND user_id = ? AND status IN ('queued', 'failed')", req.params.id, req.user.id);
    if (!row) return httpError(reply, 409, 'This message is being sent or was already sent');
    const p = json(row.payload_json, {});
    const d = saveDraft(req.user.id, { ...p, id: undefined, draftId: undefined, accountId: p.accountId || row.account_id });
    run('DELETE FROM outbox WHERE id = ?', row.id);
    notify(req.user.id, 'outbox:changed', {});
    return { ok: true, draftId: d.id };
  });

  // Sent mail stored only here (saving it on the server failed): store it on the server again.
  app.post('/api/messages/save-to-server', async (req) => {
    const b = req.body || {};
    const rows = all(`SELECT m.*, f.path AS folder_path FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.user_id = ? AND m.local_copy = 1 AND m.uid IS NULL
      ${b.all ? '' : `AND m.id IN (${ids(b.ids).join(',') || 0})`}`, req.user.id);
    let queued = 0;
    for (const m of rows) {
      const raw = readRaw(m);
      if (!raw) continue;
      run("DELETE FROM pending_ops WHERE account_id = ? AND op = 'append' AND json_extract(payload_json, '$.localId') = ?", m.account_id, m.id);
      queueOp(m.account_id, 'append', { folder: m.folder_path, raw: raw.toString('base64'), flags: ['\\Seen'], localId: m.id, kind: 'sent' });
      queued++;
    }
    return { queued };
  });

  // ---- drafts (stored locally, optionally saved to the IMAP Drafts folder)
  app.get('/api/messages/:id/draft', async (req, reply) => (await draftFromMessage(req.user.id, Number(req.params.id))) || httpError(reply, 404, 'Not a draft'));
  const draftOut = (d) => ({ ...json(d.payload_json, {}), id: d.id, accountId: d.account_id, updatedAt: d.updated_at, onServer: !!d.server_msgid });
  app.get('/api/drafts', async (req) => {
    const replyTo = ids(req.query.inReplyTo);
    return (replyTo.length ? all(`SELECT * FROM drafts WHERE user_id = ? AND in_reply_to IN (${replyTo.join(',')}) ORDER BY updated_at DESC`, req.user.id)
      : all('SELECT * FROM drafts WHERE user_id = ? ORDER BY updated_at DESC', req.user.id)).map(draftOut);
  });
  app.post('/api/drafts', async (req) => saveDraft(req.user.id, req.body || {}));
  app.delete('/api/drafts/:id', async (req) => { deleteDraft(req.user.id, Number(req.params.id)); return { ok: true }; });
  app.post('/api/drafts/:id/save-to-server', async (req, reply) => {
    try { return await saveDraftToServer(req.user.id, Number(req.params.id)); } catch (e) { return httpError(reply, 400, e.message); }
  });

  // ---- the user's own categories (ai/custom.js)
  app.get('/api/custom-categories', async (req) => listCategories(req.user.id));
  app.post('/api/custom-categories', async (req, reply) => { try { return saveCategory(req.user.id, req.body || {}); } catch (e) { return httpError(reply, 400, e.message); } });
  app.patch('/api/custom-categories/:id', async (req, reply) => { try { return saveCategory(req.user.id, req.body || {}, Number(req.params.id)); } catch (e) { return httpError(reply, 400, e.message); } });
  app.delete('/api/custom-categories/:id', async (req) => { run('DELETE FROM custom_categories WHERE id = ? AND user_id = ?', req.params.id, req.user.id); return { ok: true }; });
  // Add mail to a category by hand (value true) or take it out (false): the AI does not change that again.
  app.post('/api/custom-categories/:id/tag', async (req, reply) => {
    try { return { changed: setTag(req.user.id, Number(req.params.id), ids(req.body?.ids), req.body?.value !== false) }; } catch (e) { return httpError(reply, 400, e.message); }
  });
  app.post('/api/custom-categories/:id/rescan', async (req, reply) => {
    if (!categoryById(req.user.id, Number(req.params.id))) return httpError(reply, 404, 'Not found');
    enqueue(req.user.id, 'customcat', String(req.params.id), 55, { force: true });
    return { ok: true };
  });

  // ---- labels
  app.get('/api/labels', async (req) => all('SELECT id, name, color FROM labels WHERE user_id = ? ORDER BY name', req.user.id));
  app.post('/api/labels', async (req) => {
    const r = run('INSERT INTO labels (user_id, name, color) VALUES (?, ?, ?)', req.user.id, req.body.name, req.body.color || '#6b7280');
    return { id: r.lastInsertRowid };
  });
  app.patch('/api/labels/:id', async (req) => { run('UPDATE labels SET name = COALESCE(?, name), color = COALESCE(?, color) WHERE id = ? AND user_id = ?', req.body.name ?? null, req.body.color ?? null, req.params.id, req.user.id); return { ok: true }; });
  app.delete('/api/labels/:id', async (req) => { run('DELETE FROM labels WHERE id = ? AND user_id = ?', req.params.id, req.user.id); return { ok: true }; });

  // ---- rules
  const ruleOut = (r) => ({ id: r.id, name: r.name, enabled: !!r.enabled, matchAll: !!r.match_all, accountId: r.account_id, conditions: json(r.conditions_json, []), actions: json(r.actions_json, []), stop: !!r.stop, sortOrder: r.sort_order });
  const ruleCols = (b) => ({ name: b.name, enabled: b.enabled === undefined ? undefined : (b.enabled ? 1 : 0), match_all: b.matchAll === undefined ? undefined : (b.matchAll ? 1 : 0), account_id: b.accountId === undefined ? undefined : (b.accountId || null), conditions_json: b.conditions && JSON.stringify(b.conditions), actions_json: b.actions && JSON.stringify(b.actions), stop: b.stop === undefined ? undefined : (b.stop ? 1 : 0), sort_order: b.sortOrder });
  const RULE_COLS = ['name', 'enabled', 'match_all', 'account_id', 'conditions_json', 'actions_json', 'stop', 'sort_order'];
  app.get('/api/rules', async (req) => all('SELECT * FROM rules WHERE user_id = ? ORDER BY sort_order, id', req.user.id).map(ruleOut));
  app.post('/api/rules', async (req) => {
    const r = run('INSERT INTO rules (user_id, created_at) VALUES (?, ?)', req.user.id, now());
    update('rules', r.lastInsertRowid, ruleCols(req.body || {}), RULE_COLS);
    return ruleOut(get('SELECT * FROM rules WHERE id = ?', r.lastInsertRowid));
  });
  app.patch('/api/rules/:id', async (req, reply) => {
    if (!get('SELECT id FROM rules WHERE id = ? AND user_id = ?', req.params.id, req.user.id)) return httpError(reply, 404, 'Not found');
    update('rules', Number(req.params.id), ruleCols(req.body || {}), RULE_COLS);
    return ruleOut(get('SELECT * FROM rules WHERE id = ?', req.params.id));
  });
  app.delete('/api/rules/:id', async (req) => { run('DELETE FROM rules WHERE id = ? AND user_id = ?', req.params.id, req.user.id); return { ok: true }; });
  app.post('/api/rules/:id/run', async (req, reply) => {
    const rule = get('SELECT * FROM rules WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!rule) return httpError(reply, 404, 'Not found');
    const inbox = all("SELECT m.* FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.user_id = ? AND f.special_use = '\\Inbox' ORDER BY m.date DESC LIMIT 2000", req.user.id);
    const matched = await runRule(req.user.id, rule, inbox);
    notify(req.user.id, 'mail:changed', {});
    return { ok: true, matched };
  });

  // ---- templates
  app.get('/api/templates', async (req) => all('SELECT id, name, subject, body_html AS bodyHtml FROM templates WHERE user_id = ? ORDER BY name', req.user.id));
  app.post('/api/templates', async (req) => ({ id: run('INSERT INTO templates (user_id, name, subject, body_html) VALUES (?, ?, ?, ?)', req.user.id, req.body.name, req.body.subject || '', req.body.bodyHtml || '').lastInsertRowid }));
  app.patch('/api/templates/:id', async (req) => { run('UPDATE templates SET name = COALESCE(?, name), subject = COALESCE(?, subject), body_html = COALESCE(?, body_html) WHERE id = ? AND user_id = ?', req.body.name ?? null, req.body.subject ?? null, req.body.bodyHtml ?? null, req.params.id, req.user.id); return { ok: true }; });
  app.delete('/api/templates/:id', async (req) => { run('DELETE FROM templates WHERE id = ? AND user_id = ?', req.params.id, req.user.id); return { ok: true }; });

  app.get('/api/search/parse', async (req) => parseQuery(req.query.q));

  // Second phase of search: messages found by meaning (embeddings) that keyword search did not return. The client
  // shows keyword results instantly and adds these when the AI answers; a busy AI server only delays this part.
  app.get('/api/search/semantic', async (req) => {
    const sc = scope(req.user.id, reqSpace(req));
    const f = parseQuery(req.query.q);
    if (!f.terms.length) return { items: [] };
    const query = await embedQuery(req.user.id, f.terms.join(' '));
    if (!query) return { items: [], unavailable: true };
    const exclude = new Set(ids(req.query.exclude));
    const hits = messageHits(req.user.id, query, 40, sc).filter((h) => !exclude.has(h.id) && h.score > 0.3);
    if (!hits.length) return { items: [] };
    const { where, params } = buildWhere(req.user.id, { ...f, terms: [] }, sc);
    const rows = all(`SELECT ${LIST_COLS} FROM messages m LEFT JOIN ai_insights i ON i.message_id = m.id WHERE ${where.join(' AND ')} AND m.id IN (${hits.map(() => '?').join(',')})`, ...params, ...hits.map((h) => h.id));
    const byId = new Map(rows.map((r) => [r.id, r]));
    return { items: hits.map((h) => byId.get(h.id)).filter(Boolean).slice(0, 20).map((r) => listItem(r, openChecker(req.user.id))) };
  });
}

export { buildWhere };
