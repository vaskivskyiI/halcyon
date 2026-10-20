import { get, all, run, json, now, update } from '../db/index.js';
import { requireUser } from '../auth.js';
import { ids, httpError } from './util.js';
import { serializeMessage, readRaw, parseRaw, messageRow } from '../mail/store.js';
import { sanitizeEmailHtml } from '../mail/sanitize.js';
import * as actions from '../mail/actions.js';
import { queueSend, cancelSend, buildMime } from '../mail/send.js';
import { queueOp, syncManager } from '../mail/sync.js';
import { serializeInsight } from '../ai/tasks.js';
import { hybridSearch, parseQuery, buildWhere } from '../search.js';
import { invitationFor } from '../calendar/invites.js';
import { getSettings } from '../settings.js';
import { userAccounts } from '../accounts.js';
import { runRule } from '../rules.js';
import { contactByEmail } from '../contacts/service.js';
import { notify } from '../util/events.js';
import { scope, reqSpace, inIds } from '../spaces.js';

const NOISE = "('newsletter','promotion','social','notification')";
const LIST_COLS = `m.id, m.account_id, m.folder_id, m.uid, m.message_id, m.thread_id, m.subject, m.from_name, m.from_addr, m.to_json, m.cc_json, m.bcc_json, m.reply_to_json,
  m.date, m.snippet, m.has_attachments, m.is_read, m.is_flagged, m.is_answered, m.is_draft, m.snoozed_until, m.labels_json, m.ai_status, m.calendar_ics,
  i.summary AS ai_summary, i.category AS ai_category, i.priority AS ai_priority, i.needs_reply AS ai_needs_reply, i.is_phishing AS ai_phishing, i.draft_reply IS NOT NULL AS ai_has_draft,
  (SELECT special_use FROM folders WHERE id = m.folder_id) AS folder_special`;

function listItem(r) {
  return serializeMessage(r, {
    ai: r.ai_summary != null || r.ai_category != null ? { summary: r.ai_summary, category: r.ai_category, priority: r.ai_priority, needsReply: !!r.ai_needs_reply, isPhishing: !!r.ai_phishing, hasDraft: !!r.ai_has_draft } : null,
    threadCount: r.thread_count || 1, threadUnread: r.thread_unread || 0, folder: { id: r.folder_id, specialUse: r.folder_special },
  });
}

function scopeFor(userId, q, sc) {
  const where = ['m.user_id = ?', inIds('m.account_id', sc?.accountIds)], params = [userId];
  const view = q.view || 'unified';
  if (view === 'folder' && q.folderId) { where.push('m.folder_id = ?'); params.push(Number(q.folderId)); }
  else if (view === 'unified') where.push("m.folder_id IN (SELECT f.id FROM folders f WHERE f.special_use = '\\Inbox')");
  else if (view === 'flagged') where.push("m.is_flagged = 1 AND m.folder_id NOT IN (SELECT id FROM folders WHERE special_use IN ('\\Trash','\\Junk'))");
  else if (view === 'snoozed') where.push('m.snoozed_until IS NOT NULL');
  else if (view === 'needsreply') where.push("m.is_answered = 0 AND m.id IN (SELECT message_id FROM ai_insights WHERE needs_reply = 1) AND m.folder_id IN (SELECT id FROM folders WHERE special_use = '\\Inbox')");
  else if (view === 'important') where.push("m.id IN (SELECT message_id FROM ai_insights WHERE priority >= 70) AND m.folder_id IN (SELECT id FROM folders WHERE special_use = '\\Inbox')");
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
    case 'focused': where.push(`(i.message_id IS NULL OR (i.priority >= 40 AND COALESCE(i.category, '') NOT IN ${NOISE}) OR i.priority >= 70)`); break;
    case 'other': where.push(`i.message_id IS NOT NULL AND i.priority < 70 AND (i.priority < 40 OR i.category IN ${NOISE})`); break;
    default: break;
  }
  if (q.category) { where.push('i.category = ?'); params.push(q.category); }
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
    const counts = {
      unified: get(`SELECT COUNT(*) AS n FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.user_id = ? AND ${acc} AND f.special_use = '\\Inbox' AND m.is_read = 0 AND m.snoozed_until IS NULL`, req.user.id).n,
      flagged: get(`SELECT COUNT(*) AS n FROM messages m WHERE m.user_id = ? AND ${acc} AND m.is_flagged = 1`, req.user.id).n,
      snoozed: get(`SELECT COUNT(*) AS n FROM messages m WHERE m.user_id = ? AND ${acc} AND m.snoozed_until IS NOT NULL`, req.user.id).n,
      needsreply: get(`SELECT COUNT(*) AS n FROM messages m JOIN ai_insights i ON i.message_id = m.id JOIN folders f ON f.id = m.folder_id WHERE m.user_id = ? AND ${acc} AND i.needs_reply = 1 AND m.is_answered = 0 AND f.special_use = '\\Inbox'`, req.user.id).n,
      scheduled: get(`SELECT COUNT(*) AS n FROM outbox WHERE user_id = ? AND ${inIds('account_id', sc?.accountIds)} AND status IN ('queued','failed')`, req.user.id).n,
    };
    return { accounts: out, counts };
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
  app.get('/api/messages', async (req) => {
    const q = req.query;
    const sc = scope(req.user.id, reqSpace(req));
    const limit = Math.min(Number(q.limit) || 50, 200);
    if (q.q) {
      const found = await hybridSearch(req.user.id, q.q, { limit: 100, semantic: q.semantic !== '0', sc });
      if (!found.length) return { items: [], hasMore: false };
      const rows = all(`SELECT ${LIST_COLS} FROM messages m LEFT JOIN ai_insights i ON i.message_id = m.id WHERE m.id IN (${found.map(() => '?').join(',')})`, ...found);
      const byId = new Map(rows.map((r) => [r.id, r]));
      return { items: found.map((id) => byId.get(id)).filter(Boolean).map(listItem), hasMore: false };
    }
    const { where, params } = scopeFor(req.user.id, q, sc);
    const cursor = Number(q.before) || 8.64e15;
    const threaded = q.threads !== '0' && getSettings(req.user.id).ui.conversationView;
    let rows;
    if (threaded) {
      rows = all(`WITH scoped AS (
          SELECT ${LIST_COLS}, ROW_NUMBER() OVER (PARTITION BY m.thread_id ORDER BY m.date DESC) AS rn,
            COUNT(*) OVER (PARTITION BY m.thread_id) AS thread_count, SUM(1 - m.is_read) OVER (PARTITION BY m.thread_id) AS thread_unread
          FROM messages m LEFT JOIN ai_insights i ON i.message_id = m.id WHERE ${where.join(' AND ')})
        SELECT * FROM scoped WHERE rn = 1 AND date < ? ORDER BY date DESC LIMIT ?`, ...params, cursor, limit + 1);
    } else {
      rows = all(`SELECT ${LIST_COLS} FROM messages m LEFT JOIN ai_insights i ON i.message_id = m.id WHERE ${where.join(' AND ')} AND m.date < ? ORDER BY m.date DESC LIMIT ?`, ...params, cursor, limit + 1);
    }
    return { items: rows.slice(0, limit).map(listItem), hasMore: rows.length > limit };
  });

  function fullMessage(userId, m, allowRemote) {
    const settings = getSettings(userId);
    const sender = contactByEmail(userId, m.from_addr);
    const trusted = allowRemote || settings.mail.loadRemoteImages || !!sender;
    const { html, blockedRemote } = m.body_html ? sanitizeEmailHtml(m.body_html, { messageId: m.id, allowRemote: trusted }) : { html: null, blockedRemote: 0 };
    const ins = get('SELECT * FROM ai_insights WHERE message_id = ?', m.id);
    const folder = get('SELECT id, name, special_use FROM folders WHERE id = ?', m.folder_id);
    return serializeMessage(m, {
      html, text: m.body_text, blockedRemote, attachments: json(m.attachments_json, []).filter((a) => !a.inline),
      listUnsubscribe: m.list_unsubscribe, insight: serializeInsight(ins), folder: folder && { id: folder.id, name: folder.name, specialUse: folder.special_use },
      senderContactId: sender?.id || null,
    });
  }

  app.get('/api/messages/:id', async (req, reply) => {
    const m = get('SELECT * FROM messages WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!m) return httpError(reply, 404, 'Not found');
    return fullMessage(req.user.id, m, req.query.images === '1');
  });

  app.get('/api/threads/:threadId', async (req) => {
    const rows = all('SELECT * FROM messages WHERE user_id = ? AND thread_id = ? ORDER BY date', req.user.id, req.params.threadId);
    // De-duplicate copies of the same message (e.g. in Sent and Inbox).
    const seen = new Set();
    const msgs = rows.filter((m) => (seen.has(m.message_id) ? false : seen.add(m.message_id)));
    const summary = get('SELECT summary, message_count FROM thread_summaries WHERE user_id = ? AND thread_id = ?', req.user.id, req.params.threadId);
    return { messages: msgs.map((m) => fullMessage(req.user.id, m, req.query.images === '1')), summary: summary?.summary || null };
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
    switch (action) {
      case 'read': actions.setFlags(u, target, { read: true }); break;
      case 'unread': actions.setFlags(u, target, { read: false }); break;
      case 'flag': actions.setFlags(u, list, { flagged: true }); break;
      case 'unflag': actions.setFlags(u, target, { flagged: false }); break;
      case 'archive': await actions.archiveMessages(u, target); break;
      case 'trash': await actions.trashMessages(u, target); break;
      case 'delete': actions.deletePermanently(u, target); break;
      case 'spam': await actions.spamMessages(u, target); break;
      case 'notspam': await actions.notSpam(u, target); break;
      case 'move': await actions.moveMessages(u, target, Number(folderId)); break;
      case 'snooze': actions.snoozeMessages(u, target, Number(until)); break;
      case 'unsnooze': actions.snoozeMessages(u, target, null); break;
      case 'label': actions.setLabels(u, target, { add: [labelId] }); break;
      case 'unlabel': actions.setLabels(u, target, { remove: [labelId] }); break;
      default: return httpError(reply, 400, 'Unknown action');
    }
    return { ok: true, count: target.length };
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
    run("UPDATE outbox SET status = 'queued', attempts = 0, send_at = ? WHERE id = ? AND user_id = ?", now(), req.params.id, req.user.id);
    return { ok: true };
  });

  // ---- drafts (stored locally, optionally saved to the IMAP Drafts folder)
  app.get('/api/drafts', async (req) => all('SELECT * FROM drafts WHERE user_id = ? ORDER BY updated_at DESC', req.user.id).map((d) => ({ id: d.id, accountId: d.account_id, updatedAt: d.updated_at, ...json(d.payload_json, {}) })));
  app.post('/api/drafts', async (req) => {
    const b = req.body || {};
    if (b.id && get('SELECT id FROM drafts WHERE id = ? AND user_id = ?', b.id, req.user.id)) {
      run('UPDATE drafts SET account_id = ?, payload_json = ?, updated_at = ? WHERE id = ?', b.accountId || null, JSON.stringify(b), now(), b.id);
      return { id: b.id };
    }
    const r = run('INSERT INTO drafts (user_id, account_id, payload_json, updated_at) VALUES (?, ?, ?, ?)', req.user.id, b.accountId || null, JSON.stringify(b), now());
    return { id: r.lastInsertRowid };
  });
  app.delete('/api/drafts/:id', async (req) => { run('DELETE FROM drafts WHERE id = ? AND user_id = ?', req.params.id, req.user.id); return { ok: true }; });
  app.post('/api/drafts/:id/save-to-server', async (req, reply) => {
    const d = get('SELECT * FROM drafts WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    const p = d && json(d.payload_json, {});
    const account = p && get('SELECT * FROM accounts WHERE id = ? AND user_id = ?', p.accountId, req.user.id);
    if (!account) return httpError(reply, 400, 'Draft needs an account');
    const folder = actions.findSpecialFolder(account.id, '\\Drafts', 'Drafts');
    if (!folder) return httpError(reply, 400, 'No Drafts folder');
    const raw = await buildMime(account, p);
    queueOp(account.id, 'append', { folder: folder.path, raw: raw.toString('base64'), flags: ['\\Draft', '\\Seen'] });
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
}

export { buildWhere };
