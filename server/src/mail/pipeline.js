// Hooks executed after new messages are stored: contact collection, rules, AI queueing, notifications.
import { get, all, json } from '../db/index.js';
import { getSettings } from '../settings.js';
import { applyRules } from '../rules.js';
import { enqueue } from '../ai/queue.js';
import { collectAddresses } from '../contacts/service.js';
import { notify } from '../util/events.js';

export async function afterIngest(account, folder, ids, { initial = false } = {}) {
  const settings = getSettings(account.user_id);
  const isInbox = folder.special_use === '\\Inbox';
  const isSent = folder.special_use === '\\Sent';
  const messages = ids.map((id) => get('SELECT id, date, from_addr, from_name, to_json, cc_json, subject, is_read, snippet FROM messages WHERE id = ?', id)).filter(Boolean);

  if (settings.mail.autoCollectContacts && isSent) {
    for (const m of messages) collectAddresses(account.user_id, [...json(m.to_json, []), ...json(m.cc_json, [])], m.date, true);
  } else if (isInbox) {
    for (const m of messages) collectAddresses(account.user_id, [{ address: m.from_addr, name: m.from_name }], m.date, false);
  }

  if (isInbox) applyRules(account.user_id, ids, 'ingest');

  if (settings.ai.enabled) {
    const cutoff = Date.now() - settings.ai.analyzeDays * 864e5;
    const analyzeHere = isInbox || (settings.ai.analyzeFolders === 'all' && !['\\Trash', '\\Junk', '\\Drafts'].includes(folder.special_use));
    for (const m of messages) {
      if (settings.ai.autoAnalyze && analyzeHere && m.date >= cutoff) {
        // Recent mail first: priority decays with age (0–100).
        const ageDays = (Date.now() - m.date) / 864e5;
        enqueue(account.user_id, 'analyze', m.id, Math.max(10, Math.round(90 - ageDays * 2)));
      }
      if (settings.ai.embeddings && folder.special_use !== '\\Trash' && folder.special_use !== '\\Junk') {
        enqueue(account.user_id, 'embed', m.id, 5);
      }
    }
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

export function inboxFolderIds(userId) {
  return all("SELECT f.id FROM folders f JOIN accounts a ON a.id = f.account_id WHERE a.user_id = ? AND f.special_use = '\\Inbox'", userId).map((r) => r.id);
}
