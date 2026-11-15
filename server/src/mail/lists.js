// Newsletters and mailing lists, told apart by their List-* headers (RFC 2369 / 2919 / 8058): a List-Post header means a
// discussion list — people write to it, so its mail is grouped by the list, never by the person who wrote — and
// List-Unsubscribe(-Post) says how to leave. unsubscribePlan says exactly what Halcyon will do before it does it:
// a one-click request to the sender's server, an email to the list's leave address, or the sender's page in the browser.
import fs from 'node:fs/promises';
import { get, all, run, tx } from '../db/index.js';
import { listHeaders } from './parse.js';

export { listHeaders };

export function saveListInfo(messageId, li) {
  if (!li) return;
  run('INSERT OR REPLACE INTO list_info (message_id, list_id, list_name, list_post, one_click) VALUES (?, ?, ?, ?, ?)', messageId, li.listId, li.listName, li.listPost ? 1 : 0, li.oneClick ? 1 : 0);
}

const headerOf = (head) => (name) => head.match(new RegExp(`^${name}:[ \\t]*(.*)$`, 'mi'))?.[1]?.trim() || null;

/** List mail stored before list_info existed: its headers read once from the originals (header blocks only, resumable). */
export async function backfillListInfo() {
  const key = 'listinfo:v1';
  let from = Number(get('SELECT value FROM app_state WHERE key = ?', key)?.value ?? 0);
  if (from < 0) return 0;
  let n = 0;
  for (;;) {
    const rows = all(`SELECT m.id, m.raw_path FROM messages m WHERE m.id > ? AND m.list_unsubscribe IS NOT NULL AND m.raw_path IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM list_info l WHERE l.message_id = m.id) ORDER BY m.id LIMIT 300`, from);
    if (!rows.length) break;
    const found = [];
    for (const r of rows) {
      let fh;
      try {
        fh = await fs.open(r.raw_path, 'r');
        const { buffer, bytesRead } = await fh.read(Buffer.alloc(65536), 0, 65536, 0);
        const head = buffer.subarray(0, bytesRead).toString('latin1').split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');
        const li = listHeaders(headerOf(head));
        if (li) found.push([r.id, li]);
      } catch { /* original gone */ } finally { await fh?.close(); }
    }
    from = rows.at(-1).id;
    tx(() => { for (const [id, li] of found) saveListInfo(id, li); });
    run('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)', key, String(from));
    n += found.length;
    await new Promise((r) => setTimeout(r, 20));
  }
  run('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)', key, '-1');
  return n;
}

/** The addresses of a List-Unsubscribe header (as sent, or the older stored form {url, mail}). */
export function unsubscribeTargets(value) {
  let header = String(value || '');
  try { const o = JSON.parse(header); header = [o.url, o.mail && `mailto:${o.mail}`].filter(Boolean).map((x) => `<${x}>`).join(', '); } catch { /* as sent */ }
  const urls = [...header.matchAll(/<([^>]+)>/g)].map((x) => x[1].trim());
  const web = urls.find((u) => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } });
  const mail = urls.find((u) => { try { const x = new URL(u); return x.protocol === 'mailto:' && x.pathname.includes('@'); } catch { return false; } });
  return { web: web || null, mailto: mail || null };
}

/**
 * What unsubscribing from this email does, or null when it cannot be done from here. m: messages row (with
 * list_unsubscribe, account_id), li: its list_info row. { method: 'one-click'|'mailto'|'web', target, text, list }.
 */
export function unsubscribePlan(m, li = get('SELECT * FROM list_info WHERE message_id = ?', m.id)) {
  if (!m?.list_unsubscribe) return null;
  const { web, mailto } = unsubscribeTargets(m.list_unsubscribe);
  const list = li?.list_post ? (li.list_name || li.list_id || 'this mailing list') : null;
  const what = list ? `leaves the mailing list “${list}” (all its mail, whoever writes there)` : 'stops this newsletter';
  if (web && /^https:/i.test(web) && li?.one_click) {
    const host = new URL(web).hostname;
    return { method: 'one-click', target: host, list, text: `Sends the sender's automatic unsubscribe request to ${host} — ${what}. No email is sent and no page opens.` };
  }
  if (mailto) {
    const u = new URL(mailto);
    const from = get('SELECT email FROM accounts WHERE id = ?', m.account_id)?.email || 'your account';
    return { method: 'mailto', target: decodeURIComponent(u.pathname), list, subject: u.searchParams.get('subject') || 'unsubscribe', body: u.searchParams.get('body') || 'unsubscribe',
      text: `Sends an email from ${from} to ${decodeURIComponent(u.pathname)} (subject “${u.searchParams.get('subject') || 'unsubscribe'}”) — ${what}.` };
  }
  if (web) {
    const host = new URL(web).hostname;
    return { method: 'web', target: host, url: web, list, text: `Opens the unsubscribe page on ${host} in your browser; finish there — ${what}.` };
  }
  return null;
}

/** Key a subscription is remembered by: the list for a discussion list, else the sender. */
export const subscriptionKey = (m, li) => (li?.list_post && li.list_id ? `list:${li.list_id}` : String(m.from_addr || '').toLowerCase());
