// Problems that fix themselves when tried again are tried again by themselves, with growing pauses; the problems
// panel shows them as "trying again" until it works (then they disappear) or the tries are used up.
// - server changes (pending_ops) that failed 5 times in a row (e.g. during an outage of the mail server)
// - sends that failed because the mail server could not be reached at all (the message certainly did not go out —
//   other failures stay with the user: the message may have been delivered, and sending again would duplicate it)
// - copies of sent mail not saved in the server's Sent folder
// - "sending failed" for an account: its SMTP server is checked again, and the warning goes once it answers
import { all, get, run, now } from '../db/index.js';
import { queueOp, syncManager } from './sync.js';
import { readRaw } from './store.js';
import { smtpStatus } from './send.js';
import { smtpTransport } from './connection.js';
import { logger } from '../util/log.js';

const log = logger('retry');
/** Pauses before the 1st, 2nd, … automatic retry: 15 min, 30 min, 1 h, 2 h, 4 h, 8 h, 16 h, 24 h. */
export const RETRY_STEPS = [15, 30, 60, 120, 240, 480, 960, 1440].map((m) => m * 60e3);
export const SEND_RETRIES = 6;
/** Errors from before the mail server was reached (nothing was transmitted). */
export const UNREACHED = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|getaddrinfo|Greeting never received|Connection timeout|connect ETIMEDOUT/i;

const step = (n) => RETRY_STEPS[Math.min(n, RETRY_STEPS.length - 1)];

export async function autoRetry(t = now()) {
  // Server changes: given one more try (sync.js runs ops with attempts < 5) when their pause is over.
  for (const op of all('SELECT id, account_id, auto_retries, next_retry_at FROM pending_ops WHERE attempts >= 5 AND auto_retries < ?', RETRY_STEPS.length)) {
    if (op.next_retry_at == null) { run('UPDATE pending_ops SET next_retry_at = ? WHERE id = ?', t + step(op.auto_retries), op.id); continue; }
    if (op.next_retry_at > t) continue;
    run('UPDATE pending_ops SET attempts = 4, auto_retries = auto_retries + 1, next_retry_at = ? WHERE id = ?', t + step(op.auto_retries + 1), op.id);
    syncManager.trigger(op.account_id);
  }
  // Sends that never reached the server: queued again (processOutbox sends it once more).
  for (const o of all("SELECT id, error, auto_retries, send_at FROM outbox WHERE status = 'failed' AND auto_retries < ?", SEND_RETRIES)) {
    if (!UNREACHED.test(o.error || '') || (o.send_at || 0) + step(o.auto_retries) > t) continue;
    run("UPDATE outbox SET status = 'queued', attempts = 4, auto_retries = auto_retries + 1, send_at = ? WHERE id = ? AND status = 'failed'", t, o.id);
  }
  // Sent mail whose copy is not in the server's Sent folder yet, and that nothing is trying to save anymore.
  for (const m of all(`SELECT m.*, f.path AS folder_path FROM messages m JOIN folders f ON f.id = m.folder_id JOIN accounts a ON a.id = m.account_id
      WHERE m.local_copy = 1 AND m.uid IS NULL AND m.created_at < ? AND a.sync_enabled = 1 AND COALESCE(a.kind, 'mail') != 'archive'
        AND NOT EXISTS (SELECT 1 FROM pending_ops p WHERE p.account_id = m.account_id AND p.op = 'append' AND json_extract(p.payload_json, '$.localId') = m.id)
      LIMIT 50`, t - 15 * 60e3)) {
    const raw = readRaw(m);
    if (raw) queueOp(m.account_id, 'append', { folder: m.folder_path, raw: raw.toString('base64'), flags: ['\\Seen'], localId: m.id, kind: 'sent' });
  }
  // "Sending failed": the SMTP server checked again (every 10 minutes); the warning goes when it answers.
  for (const [accountId, st] of smtpStatus) {
    if (st.ok || t - (st.checkedAt || st.at) < 10 * 60e3) continue;
    const account = get('SELECT * FROM accounts WHERE id = ?', accountId);
    if (!account) { smtpStatus.delete(accountId); continue; }
    try {
      const tr = await smtpTransport(account);
      await tr.verify();
      tr.close();
      smtpStatus.set(accountId, { ok: true, at: now() });
    } catch (e) {
      smtpStatus.set(accountId, { ...st, checkedAt: now() });
      log.info(`SMTP of account ${accountId} still not reachable: ${e.message}`);
    }
  }
}
