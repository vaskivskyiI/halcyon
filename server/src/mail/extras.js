// Outlook-style conveniences: automatic replies (out of office), muted ("ignored") conversations, blocking a sender,
// sweeping a sender's mail, follow-up flags, quick steps and exporting a folder.
import { get, all, run, json, now } from '../db/index.js';
import { queueSend } from './send.js';
import { setFlags, archiveMessages } from './actions.js';
import { readRaw } from './store.js';
import { isAutomated } from '../ai/verify.js';
import { ownAddresses } from '../ai/open-items.js';
import { contactByEmail } from '../contacts/service.js';
import { textToHtml } from '../util/text.js';
import { notify } from '../util/events.js';
import { logger } from '../util/log.js';

const log = logger('extras');

// ---- automatic replies (per account)

export const autoReplyOf = (account) => ({ enabled: false, start: null, end: null, subject: '', message: '', onlyContacts: false, days: 4, ...json(account.auto_reply_json, {}) });

/** Whether the reply is on now (switched on, and within its dates when given). */
export const autoReplyActive = (cfg, t = now()) => !!cfg.enabled && !!String(cfg.message || '').trim() && (!cfg.start || t >= cfg.start) && (!cfg.end || t < cfg.end);

/**
 * New mail in the Inbox while the account's automatic reply is on: one reply per sender every few days — never to
 * the user's own addresses, mailing lists, automated or bulk mail, other automatic replies, spam, or (if chosen) people
 * who are not contacts. Sent through the outbox like any mail (visible there, and in Sent).
 */
export function autoReply(account, messages) {
  const cfg = autoReplyOf(account);
  if (!autoReplyActive(cfg)) return 0;
  const mine = ownAddresses(account.user_id);
  let n = 0;
  for (const m of messages) {
    const full = get('SELECT * FROM messages WHERE id = ?', m.id);
    const from = String(full?.from_addr || '').toLowerCase();
    if (!full || !from || mine.has(from) || full.list_unsubscribe || isAutomated(full) || now() - full.date > 864e5) continue;
    if (cfg.start && full.date < cfg.start) continue;
    const head = (readRaw(full) || Buffer.alloc(0)).toString('latin1', 0, 16384).split(/\r?\n\r?\n/)[0];
    if (/^auto-submitted:\s*(?!no\b)/mi.test(head) || /^precedence:\s*(bulk|list|junk)/mi.test(head) || /^x-auto-response-suppress:/mi.test(head) || /^list-id:/mi.test(head)) continue;
    if (cfg.onlyContacts && !contactByEmail(account.user_id, from)) continue;
    const last = get('SELECT at FROM auto_replied WHERE account_id = ? AND address = ?', account.id, from);
    if (last && now() - last.at < (Number(cfg.days) || 4) * 864e5) continue;
    try {
      queueSend(account.user_id, {
        accountId: account.id, to: [{ name: full.from_name || '', address: from }], subject: cfg.subject || `Automatic reply: ${full.subject || ''}`,
        html: textToHtml(cfg.message), inReplyToId: full.id, autoReply: true,
      }, { delayMs: 0 });
      run('INSERT OR REPLACE INTO auto_replied (account_id, address, at) VALUES (?, ?, ?)', account.id, from, now());
      n++;
    } catch (e) { log.warn(`auto-reply to ${from}: ${e.message}`); }
  }
  return n;
}

// ---- muted conversations: later messages are archived and marked read on arrival

export const isMuted = (userId, threadId) => !!get('SELECT 1 AS x FROM muted_threads WHERE user_id = ? AND thread_id = ?', userId, threadId);

export function setMuted(userId, threadId, muted) {
  if (muted) run('INSERT OR IGNORE INTO muted_threads (user_id, thread_id, created_at) VALUES (?, ?, ?)', userId, threadId, now());
  else run('DELETE FROM muted_threads WHERE user_id = ? AND thread_id = ?', userId, threadId);
}

export async function applyMuted(userId, ids) {
  const muted = all(`SELECT m.id FROM messages m JOIN muted_threads t ON t.user_id = m.user_id AND t.thread_id = m.thread_id WHERE m.id IN (${ids.map(Number).join(',') || 0})`).map((r) => r.id);
  if (!muted.length) return 0;
  setFlags(userId, muted, { read: true });
  await archiveMessages(userId, muted);
  return muted.length;
}

// ---- block a sender: a rule (sender → Junk), which the user can see and remove in Settings → Rules

export function blockSender(userId, address) {
  const a = String(address || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(a)) throw new Error('Not an email address');
  const name = `Blocked: ${a}`;
  if (get('SELECT id FROM rules WHERE user_id = ? AND name = ?', userId, name)) return { name };
  run(`INSERT INTO rules (user_id, name, enabled, match_all, conditions_json, actions_json, stop, sort_order, created_at) VALUES (?, ?, 1, 1, ?, ?, 1, -1, ?)`,
    userId, name, JSON.stringify([{ field: 'from', op: 'contains', value: a }]), JSON.stringify([{ type: 'spam' }]), now());
  return { name };
}
export function unblockSender(userId, address) {
  return run('DELETE FROM rules WHERE user_id = ? AND name = ?', userId, `Blocked: ${String(address || '').trim().toLowerCase()}`).changes;
}

/** Sweep: the Inbox messages from a sender (optionally all but the newest) — the client archives / deletes them (undoable). */
export function fromSender(userId, address, { keepLatest = false } = {}) {
  const ids = all(`SELECT m.id FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.user_id = ? AND lower(m.from_addr) = ? AND f.special_use = '\\Inbox' ORDER BY m.date DESC, m.id DESC`,
    userId, String(address || '').toLowerCase()).map((r) => r.id);
  return keepLatest ? ids.slice(1) : ids;
}

// ---- follow-up: flag + a task with the due date (its reminder comes at that time)

export function followUp(userId, messageId, due) {
  const m = get('SELECT * FROM messages WHERE id = ? AND user_id = ?', messageId, userId);
  if (!m) throw new Error('Message not found');
  setFlags(userId, [m.id], { flagged: true });
  const existing = get("SELECT id FROM tasks WHERE user_id = ? AND source_message_id = ? AND done = 0 AND title LIKE 'Follow up:%'", userId, m.id);
  if (existing) run('UPDATE tasks SET due = ?, updated_at = ? WHERE id = ?', due || null, now(), existing.id);
  else run("INSERT INTO tasks (user_id, title, notes, due, priority, list, source_message_id, created_at, updated_at) VALUES (?, ?, '', ?, 1, 'Tasks', ?, ?, ?)",
    userId, `Follow up: ${m.subject || '(no subject)'}`.slice(0, 300), due || null, m.id, now(), now());
  notify(userId, 'tasks:changed', {});
  return { ok: true };
}

// ---- quick steps: the user's own one-click combinations of actions

const STEP_TYPES = new Set(['markRead', 'markUnread', 'flag', 'archive', 'trash', 'move', 'label', 'category', 'followUp']);
export const listQuickSteps = (userId) => all('SELECT id, name, actions_json FROM quick_steps WHERE user_id = ? ORDER BY sort_order, id', userId).map((q) => ({ id: q.id, name: q.name, actions: json(q.actions_json, []) }));
export function saveQuickStep(userId, b, id = null) {
  const name = String(b.name || '').trim().slice(0, 40);
  const actions = (Array.isArray(b.actions) ? b.actions : []).filter((a) => a && STEP_TYPES.has(a.type)).slice(0, 8);
  if (!name || !actions.length) throw new Error('A quick step needs a name and at least one action');
  if (id) run('UPDATE quick_steps SET name = ?, actions_json = ? WHERE id = ? AND user_id = ?', name, JSON.stringify(actions), id, userId);
  else id = Number(run('INSERT INTO quick_steps (user_id, name, actions_json, created_at) VALUES (?, ?, ?, ?)', userId, name, JSON.stringify(actions), now()).lastInsertRowid);
  return { id };
}

/** Plan of a quick step for the client: flags / labels / categories / follow-ups now, and one "move" kind of action. */
export function quickStepPlan(userId, id) {
  const q = get('SELECT * FROM quick_steps WHERE id = ? AND user_id = ?', id, userId);
  if (!q) throw new Error('Quick step not found');
  return json(q.actions_json, []);
}

// ---- export: a folder as an .mbox file (readable by Thunderbird, Apple Mail, …)

export function* mboxOf(folderId) {
  for (const m of all('SELECT * FROM messages WHERE folder_id = ? ORDER BY date', folderId)) {
    const raw = readRaw(m);
    if (!raw) continue;
    const from = (m.from_addr || 'MAILER-DAEMON').replace(/\s/g, '');
    yield Buffer.from(`From ${from} ${new Date(m.date).toUTCString().replace(/,/g, '')}\n`);
    // mboxrd: lines starting with "From " (after any ">") get one more ">".
    yield Buffer.from(raw.toString('latin1').replace(/\r\n/g, '\n').replace(/^(>*From )/gm, '>$1'), 'latin1');
    yield Buffer.from('\n');
  }
}
