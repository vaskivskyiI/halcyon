// Hooks executed after new messages are stored: contact collection, rules, AI queueing, notifications.
import { get, all, run, json } from '../db/index.js';
import { getSettings } from '../settings.js';
import { applyRules } from '../rules.js';
import { enqueue, queueMemory } from '../ai/queue.js';
import { resolve } from '../ai/router.js';
import { invalidateAll } from '../ai/memory.js';
import { collectAddresses } from '../contacts/service.js';
import { processIncomingIcs } from '../calendar/invites.js';
import { senderPreference } from '../ai/learning.js';
import { spamMessages } from './actions.js';
import { notify } from '../util/events.js';
import { logger } from '../util/log.js';

const log = logger('pipeline');
const NEVER_ANALYZE = ['\\Trash', '\\Junk', '\\Drafts'];
// Recent mail first: priority decays with age (0–100).
const analyzePriority = (date) => Math.max(10, Math.round(90 - ((Date.now() - date) / 864e5) * 2));

export async function afterIngest(account, folder, ids, { initial = false } = {}) {
  const settings = getSettings(account.user_id);
  const isInbox = folder.special_use === '\\Inbox';
  const isSent = folder.special_use === '\\Sent';
  const messages = ids.map((id) => get('SELECT id, date, from_addr, from_name, to_json, cc_json, subject, is_read, snippet, calendar_ics FROM messages WHERE id = ?', id)).filter(Boolean);

  if (settings.mail.autoCollectContacts && isSent) {
    for (const m of messages) collectAddresses(account.user_id, [...json(m.to_json, []), ...json(m.cc_json, [])], m.date, true, account.id);
  } else if (isInbox) {
    for (const m of messages) collectAddresses(account.user_id, [{ address: m.from_addr, name: m.from_name }], m.date, false, account.id);
  }

  // Invitation replies / cancellations update the calendar whether or not AI is enabled.
  if (isInbox) {
    for (const m of messages) {
      if (m.calendar_ics) try { processIncomingIcs(account.user_id, m.id); } catch (e) { log.warn(`ics ${m.id}: ${e.message}`); }
    }
    applyRules(account.user_id, ids, 'ingest');
    // Senders the user marked as spam (their own decision, not an AI one) go straight to Junk.
    const spam = messages.filter((m) => senderPreference(account.user_id, m.from_addr).spam).map((m) => m.id);
    if (spam.length) spamMessages(account.user_id, spam).catch((e) => log.warn(`spam filing: ${e.message}`));
  }

  const cutoff = Date.now() - settings.ai.analyzeDays * 864e5;
  // Sent mail is analysed too: it holds the user's own commitments and the other half of every conversation.
  const analyzeHere = isInbox || isSent || (settings.ai.analyzeFolders === 'all' && !NEVER_ANALYZE.includes(folder.special_use));
  for (const m of messages) {
    if (settings.ai.enabled && settings.ai.autoAnalyze && analyzeHere && m.date >= cutoff) enqueue(account.user_id, 'analyze', m.id, analyzePriority(m.date));
    else run("UPDATE messages SET ai_status = 'none' WHERE id = ? AND ai_status = 'pending'", m.id);
    if (folder.special_use !== '\\Trash' && folder.special_use !== '\\Junk') queueMemory(account.user_id, 'message', m.id);
  }

  if (!initial && isInbox) {
    const unread = messages.filter((m) => !m.is_read);
    if (unread.length) {
      notify(account.user_id, 'mail:new', {
        accountId: account.id, folderId: folder.id, count: unread.length,
        messages: unread.slice(0, 5).map((m) => ({ id: m.id, from: m.from_name || m.from_addr, subject: m.subject, snippet: m.snippet?.slice(0, 120) })),
      });
    }
  }
}

/**
 * Catch-up: queue analysis for eligible messages that have neither an insight nor a job (mail that arrived
 * while AI was off, before a provider existed, or after the analysis window/folders were widened).
 * Messages whose job failed are left alone so a broken model is not retried forever.
 */
export function backfillAnalysis(userId) {
  const s = getSettings(userId);
  if (!s.ai.enabled) return 0;
  let n = 0;
  if (s.ai.autoAnalyze) {
    const folderCond = s.ai.analyzeFolders === 'all' ? "COALESCE(f.special_use, '') NOT IN ('\\Trash', '\\Junk', '\\Drafts')" : "f.special_use IN ('\\Inbox', '\\Sent')";
    const rows = all(`SELECT m.id, m.date FROM messages m JOIN folders f ON f.id = m.folder_id
      WHERE m.user_id = ? AND m.date >= ? AND ${folderCond}
        AND NOT EXISTS (SELECT 1 FROM ai_insights i WHERE i.message_id = m.id)
        AND NOT EXISTS (SELECT 1 FROM ai_jobs j WHERE j.user_id = m.user_id AND j.type = 'analyze' AND j.ref_id = CAST(m.id AS TEXT) AND j.status != 'done')
      ORDER BY m.date DESC LIMIT 5000`, userId, Date.now() - s.ai.analyzeDays * 864e5);
    for (const m of rows) enqueue(userId, 'analyze', m.id, analyzePriority(m.date), { force: true });
    n += rows.length;
  }
  if (s.ai.embeddings) n += backfillMemory(userId);
  return n;
}

/**
 * Memory catch-up: items with no memory for the current embedding model (new, changed since indexing, or indexed
 * with a previous model) and no pending job. Changing the embedding model therefore re-indexes everything.
 */
function backfillMemory(userId) {
  let model;
  try { const r = resolve(userId, 'embeddings'); model = `${r.row.type}:${r.model}`; } catch { return 0; }
  const active = (type, ref) => `NOT EXISTS (SELECT 1 FROM ai_jobs j WHERE j.user_id = ? AND j.type = '${type}' AND j.ref_id = ${ref} AND j.status IN ('queued', 'running', 'waiting', 'failed'))`;
  const fresh = (kind, ref, changed = 'NULL') => `NOT EXISTS (SELECT 1 FROM memory x WHERE x.user_id = ? AND x.kind = '${kind}' AND x.ref_id = CAST(${ref} AS TEXT) AND x.model = ? AND (${changed} IS NULL OR x.created_at >= ${changed}))`;
  const lists = [
    ['message', all(`SELECT m.id FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.user_id = ? AND COALESCE(f.special_use, '') NOT IN ('\\Trash', '\\Junk')
      AND ${fresh('message', 'm.id')} AND ${active('embed', 'CAST(m.id AS TEXT)')} ORDER BY m.date DESC LIMIT 20000`, userId, userId, model, userId)],
    ['thread', all(`SELECT t.thread_id AS id FROM thread_summaries t WHERE t.user_id = ? AND ${fresh('thread', 't.thread_id', 't.updated_at')}
      AND ${active('memory', "'thread:' || t.thread_id")} LIMIT 5000`, userId, userId, model, userId)],
    ['event', all(`SELECT e.id FROM events e JOIN calendars c ON c.id = e.calendar_id WHERE c.user_id = ? AND e.deleted = 0 AND ${fresh('event', 'e.id', 'e.updated_at')}
      AND ${active('memory', "'event:' || e.id")} ORDER BY e.start DESC LIMIT 5000`, userId, userId, model, userId)],
    ['contact', all(`SELECT c.id FROM contacts c WHERE c.user_id = ? AND c.deleted = 0 AND (c.auto_collected = 0 OR c.favorite = 1) AND ${fresh('contact', 'c.id', 'c.updated_at')}
      AND ${active('memory', "'contact:' || c.id")} LIMIT 5000`, userId, userId, model, userId)],
    ['fact', all(`SELECT f.id FROM facts f WHERE f.user_id = ? AND ${fresh('fact', 'f.id')} AND ${active('memory', "'fact:' || f.id")} LIMIT 5000`, userId, userId, model, userId)],
  ];
  let n = 0;
  for (const [kind, rows] of lists) { for (const r of rows) queueMemory(userId, kind, r.id); n += rows.length; }
  return n;
}

/** Removes memory whose source no longer exists (sync deletes rows directly). Returns the number of rows removed. */
export function purgeMemory() {
  let n = 0;
  n += run("DELETE FROM memory WHERE kind = 'message' AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = CAST(memory.ref_id AS INTEGER))").changes;
  n += run("DELETE FROM memory WHERE kind = 'event' AND NOT EXISTS (SELECT 1 FROM events e WHERE e.id = CAST(memory.ref_id AS INTEGER) AND e.deleted = 0)").changes;
  n += run("DELETE FROM memory WHERE kind = 'contact' AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = CAST(memory.ref_id AS INTEGER) AND c.deleted = 0)").changes;
  n += run("DELETE FROM memory WHERE kind = 'fact' AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.id = CAST(memory.ref_id AS INTEGER))").changes;
  n += run("DELETE FROM memory WHERE kind = 'thread' AND NOT EXISTS (SELECT 1 FROM thread_summaries t WHERE t.user_id = memory.user_id AND t.thread_id = memory.ref_id)").changes;
  if (n) invalidateAll();
  return n;
}

export function inboxFolderIds(userId) {
  return all("SELECT f.id FROM folders f JOIN accounts a ON a.id = f.account_id WHERE a.user_id = ? AND f.special_use = '\\Inbox'", userId).map((r) => r.id);
}
