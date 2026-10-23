// Diagnostics: numbers about this installation for finding what is slow, failing or inaccurate — without mail
// content. No subjects, bodies, names or addresses; error texts have addresses and quoted parts removed. Meant to be
// copied and shared (e.g. with a developer), so it stays free of anything personal.
import fs from 'node:fs';
import { requireUser } from '../auth.js';
import { get, all, json, now } from '../db/index.js';
import { config } from '../config.js';
import { getSettings } from '../settings.js';
import { userAccounts } from '../accounts.js';
import { syncManager } from '../mail/sync.js';
import { openReplySql, openActionSql, NOISE } from '../ai/open-items.js';
import { timingSummary } from '../util/metrics.js';

const DAY = 864e5;
const started = Date.now();
const size = (p) => { try { return Math.round(fs.statSync(p).size / 1048576); } catch { return 0; } };
const ago = (t) => (t ? `${Math.round((now() - t) / 60e3)} min ago` : null);
/** Error text without addresses, quoted strings, folder paths in quotes or long numbers. */
export const redact = (s) => (s == null ? null : String(s)
  .replace(/[^\s<>"'@]+@[^\s<>"'@]+/g, '<address>').replace(/"[^"]{0,200}"|“[^”]{0,200}”|'[^']{3,200}'/g, '"…"').replace(/\d{6,}/g, '<n>').slice(0, 240));

export function diagnostics(userId) {
  const s = getSettings(userId);
  const since30 = now() - 30 * DAY;
  const accounts = userAccounts(userId).map((a, i) => {
    const st = syncManager.status(a.id);
    const folders = all('SELECT special_use AS kind, COUNT(*) AS n FROM folders WHERE account_id = ? GROUP BY special_use', a.id);
    return {
      account: `#${i + 1}`, kind: a.auth_type || 'password', syncEnabled: !!a.sync_enabled,
      connected: !!st?.connected, push: !!st?.push, lastFullSync: ago(st?.lastFullAt), lastFullSyncSeconds: st?.lastFullMs != null ? Math.round(st.lastFullMs / 1000) : null,
      lastNewMail: ago(st?.lastNewMailAt), lastError: redact(st?.lastError), lastErrorAt: ago(st?.lastErrorAt), foldersWithErrors: Object.keys(st?.folderErrors || {}).length,
      folders: folders.reduce((n, f) => n + f.n, 0),
      messages: get('SELECT COUNT(*) AS n FROM messages WHERE account_id = ?', a.id).n,
      pendingServerChanges: all('SELECT op, COUNT(*) AS n, SUM(attempts > 0) AS retrying FROM pending_ops WHERE account_id = ? GROUP BY op', a.id),
      lastPendingError: redact(get('SELECT error FROM pending_ops WHERE account_id = ? AND error IS NOT NULL ORDER BY id DESC LIMIT 1', a.id)?.error),
      notOnServer: get('SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND local_copy = 1 AND uid IS NULL', a.id).n,
    };
  });
  const byFolder = all(`SELECT COALESCE(f.special_use, 'other') AS folder, COUNT(*) AS messages, SUM(1 - m.is_read) AS unread, SUM(m.date > ?) AS last30d
    FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.user_id = ? GROUP BY 1 ORDER BY 2 DESC`, since30, userId);

  const inbox30 = `FROM messages m JOIN folders f ON f.id = m.folder_id LEFT JOIN ai_insights i ON i.message_id = m.id
    WHERE m.user_id = ? AND f.special_use = '\\Inbox' AND m.date > ?`;
  const analysis = {
    inboxLast30d: get(`SELECT COUNT(*) AS n, COUNT(i.message_id) AS analysed ${inbox30}`, userId, since30),
    byCategory: all(`SELECT COALESCE(i.category, '(none)') AS category, COUNT(*) AS n, ROUND(AVG(i.priority)) AS avgPriority,
        SUM(i.needs_reply = 1) AS needsReplyByAi, SUM(i.needs_reply_user = 1) AS needsReplyByYou, SUM(i.needs_action = 1) AS actionByAi
      ${inbox30} GROUP BY 1 ORDER BY 2 DESC`, userId, since30),
    priorityHistogram: all(`SELECT (i.priority / 20) * 20 AS fromPriority, COUNT(*) AS n ${inbox30} AND i.priority IS NOT NULL GROUP BY 1 ORDER BY 1`, userId, since30),
    expired: get(`SELECT COUNT(*) AS n ${inbox30} AND i.expires_at < ?`, userId, since30, now()).n,
  };
  const open = {
    needsReply: get(`SELECT COUNT(*) AS n FROM messages m JOIN ai_insights i ON i.message_id = m.id JOIN folders f ON f.id = m.folder_id WHERE m.user_id = ? AND f.special_use = '\\Inbox' AND ${openReplySql(userId)}`, userId).n,
    actionNeeded: get(`SELECT COUNT(*) AS n FROM messages m JOIN ai_insights i ON i.message_id = m.id JOIN folders f ON f.id = m.folder_id WHERE m.user_id = ? AND f.special_use = '\\Inbox' AND ${openActionSql(userId)}`, userId).n,
    // How open items were closed in the last 30 days: by your reply in the conversation / by the AI (resolved_by set
    // and not in the conversation) / by you (done, not doing it, AI was wrong).
    closedLast30d: all(`SELECT COALESCE(i.resolution, 'dismissed') AS how, CASE WHEN i.resolved_by IS NULL THEN 'by you' WHEN r.thread_id = m.thread_id THEN 'by your reply (same conversation)' ELSE 'by the AI (other email)' END AS who, COUNT(*) AS n
      FROM ai_insights i JOIN messages m ON m.id = i.message_id LEFT JOIN messages r ON r.id = i.resolved_by
      WHERE m.user_id = ? AND i.dismissed_at > ? GROUP BY 1, 2 ORDER BY 3 DESC`, userId, since30),
    noiseFlaggedForReply: get(`SELECT COUNT(*) AS n ${inbox30} AND i.needs_reply = 1 AND i.category IN ${NOISE}`, userId, since30).n,
  };
  const corrections = all('SELECT kind, COUNT(*) AS n, COUNT(DISTINCT from_addr) AS senders FROM ai_feedback WHERE user_id = ? AND created_at > ? GROUP BY kind ORDER BY 2 DESC', userId, since30);
  const ai = {
    providers: all('SELECT type, enabled FROM ai_providers WHERE user_id = ?', userId),
    queue: all('SELECT type, status, COUNT(*) AS n FROM ai_jobs WHERE user_id = ? GROUP BY type, status ORDER BY type', userId),
    failures7d: all("SELECT type, COUNT(*) AS n, MAX(updated_at) AS last, error FROM ai_jobs WHERE user_id = ? AND status = 'failed' AND updated_at > ? GROUP BY type ORDER BY 2 DESC", userId, now() - 7 * DAY)
      .map((r) => ({ type: r.type, n: r.n, last: ago(r.last), example: redact(r.error) })),
    callsLast7d: all(`SELECT task, model, COUNT(*) AS calls, ROUND(AVG(ms)) AS avgMs, MAX(ms) AS maxMs, SUM(1 - ok) AS errors, ROUND(AVG(input_tokens)) AS avgIn, ROUND(AVG(output_tokens)) AS avgOut
      FROM ai_usage WHERE user_id = ? AND created_at > ? GROUP BY task, model ORDER BY calls DESC`, userId, now() - 7 * DAY),
    contactProfiles: get('SELECT COUNT(*) AS n FROM contact_profiles WHERE user_id = ? AND profile_json IS NOT NULL', userId).n,
  };
  return {
    generatedAt: new Date().toISOString(),
    server: { node: process.version, uptimeHours: Math.round((Date.now() - started) / 36e5 * 10) / 10, memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      dbMb: size(config.dbPath), walMb: size(`${config.dbPath}-wal`) },
    settings: {
      conversationView: s.ui.conversationView, markReadAfterMs: s.mail.markReadAfterMs, undoSendSeconds: s.mail.undoSendSeconds, focusedInbox: s.mail.focusedInbox,
      ai: { enabled: s.ai.enabled, autoAnalyze: s.ai.autoAnalyze, analyzeFolders: s.ai.analyzeFolders, openItemsDays: s.ai.openItemsDays, openMinPriority: s.ai.openMinPriority,
        embeddings: s.ai.embeddings, threadSummaries: s.ai.threadSummaries, contactProfiles: s.ai.contactProfiles, privacyMode: !!s.ai.privacyMode },
    },
    accounts, folders: byFolder,
    outbox: all('SELECT status, COUNT(*) AS n FROM outbox WHERE user_id = ? AND created_at > ? GROUP BY status', userId, since30),
    lastSendError: redact(get("SELECT error FROM outbox WHERE user_id = ? AND error IS NOT NULL ORDER BY id DESC LIMIT 1", userId)?.error),
    drafts: get('SELECT COUNT(*) AS n, SUM(server_msgid IS NOT NULL) AS onServer FROM drafts WHERE user_id = ?', userId),
    openItems: open, analysis, correctionsLast30d: corrections, ai,
    requests: timingSummary(),
  };
}

export default async function diagnosticsRoutes(app) {
  app.get('/api/diagnostics', { preHandler: requireUser }, async (req) => diagnostics(req.user.id));
}
