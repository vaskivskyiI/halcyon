// Per-account IMAP synchronisation: folder list, incremental message download, flag reconciliation,
// expunge detection, IDLE push for INBOX, and replay of locally queued operations (offline-first).
import { get, run, all, json, now, tx } from '../db/index.js';
import { imapClient } from './connection.js';
import { ingestMessage, deleteMessages, recountFolder, flagsToCols } from './store.js';
import { afterIngest } from './pipeline.js';
import { config } from '../config.js';
import { logger } from '../util/log.js';
import { notify } from '../util/events.js';

const log = logger('sync');
const SPECIAL_ORDER = ['\\Inbox', '\\Drafts', '\\Sent', '\\Archive', '\\Junk', '\\Trash'];
const HISTORY_BATCH = Number(process.env.HALCYON_HISTORY_BATCH || 300); // older messages per folder per round
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class AccountSync {
  constructor(accountId) {
    this.accountId = accountId;
    this.client = null;
    this.stopped = false;
    this.wake = null;            // resolves the idle wait so a sync runs immediately
    this.dirtyFolders = new Set();
    this.backoff = 5000;
    this.running = false;
    this.fullRequested = false;  // "Sync now": run a full cycle at the next opportunity
    // Shown in Settings → Accounts: what the connection is doing and what went wrong last.
    this.status = { connectedAt: null, lastFullAt: null, lastFullMs: null, lastError: null, lastErrorAt: null, folderErrors: {}, lastNewMailAt: null };
  }

  get account() { return get('SELECT * FROM accounts WHERE id = ?', this.accountId); }

  setState(state, error = null) {
    const a = this.account;
    if (!a) return;
    run('UPDATE accounts SET sync_state = ?, sync_error = ?, last_sync_at = CASE WHEN ? = \'idle\' THEN ? ELSE last_sync_at END WHERE id = ?', state, error, state, now(), a.id);
    notify(a.user_id, 'sync:state', { accountId: a.id, state, error });
  }

  trigger(folderPath) {
    if (folderPath) this.dirtyFolders.add(folderPath);
    else this.fullRequested = true;
    this.wake?.();
  }

  // Work that arrived while a sync was running must not wait for the next poll interval.
  get hasPendingWork() { return this.fullRequested || this.dirtyFolders.size > 0; }

  async start() {
    this.running = true;
    while (!this.stopped) {
      const account = this.account;
      if (!account || !account.sync_enabled) break;
      try {
        await this.connect(account);
        this.backoff = 5000;
        await this.fullCycle();
        await this.loop();
      } catch (e) {
        if (this.stopped) break;
        const msg = e.responseText || e.message || String(e);
        log.warn(`account ${this.accountId}: ${msg}`);
        this.status.lastError = msg; this.status.lastErrorAt = now(); this.status.connectedAt = null;
        this.setState('error', msg);
        await this.closeClient();
        await this.waitFor(this.backoff);
        this.backoff = Math.min(this.backoff * 2, 5 * 60e3);
      }
    }
    await this.closeClient();
    this.running = false;
  }

  async stop() {
    this.stopped = true;
    this.wake?.();
    await this.closeClient();
  }

  async closeClient() {
    const c = this.client;
    this.client = null;
    if (c) { try { await c.logout(); } catch { try { c.close(); } catch { /* ignore */ } } }
  }

  waitFor(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); resolve(); }
      this.wake = () => { this.wake = null; done(); };
    });
  }

  async connect(account) {
    this.setState('connecting');
    const client = await imapClient(account);
    client.on('error', (e) => log.warn(`imap error ${this.accountId}: ${e.message}`));
    client.on('close', () => { if (this.client === client) { this.client = null; this.wake?.(); } });
    client.on('exists', (d) => { if (d.count > d.prevCount) this.trigger(d.path); });
    client.on('flags', (d) => this.trigger(d.path));
    client.on('expunge', (d) => this.trigger(d.path));
    await client.connect();
    this.client = client;
    this.status.connectedAt = now();
  }

  async loop() {
    let lastFull = now();
    while (!this.stopped && this.client) {
      // Keep INBOX selected so the server pushes EXISTS via IDLE.
      const inbox = get("SELECT path FROM folders WHERE account_id = ? AND special_use = '\\Inbox'", this.accountId);
      if (inbox && this.client.mailbox?.path !== inbox.path) await this.client.mailboxOpen(inbox.path);
      // While older mail is still being downloaded, continue after a short pause instead of the full poll interval.
      const history = this.historyPending;
      if (!this.hasPendingWork) await this.waitFor(history ? 3000 : config.pollIntervalSec * 1000);
      if (!this.client || this.stopped) break;
      await this.processOps();
      if (this.fullRequested || now() - lastFull >= config.pollIntervalSec * 1000) {
        this.fullRequested = false;
        await this.fullCycle();
        lastFull = now();
      } else if (this.dirtyFolders.size) {
        this.setState('syncing');
        const paths = [...this.dirtyFolders];
        this.dirtyFolders.clear();
        for (const p of paths) {
          const f = get('SELECT * FROM folders WHERE account_id = ? AND path = ?', this.accountId, p);
          if (f) await this.syncFolder(f);
        }
        this.setState('idle');
      } else if (history) {
        await this.backfillHistory();
      }
    }
  }

  async fullCycle() {
    const t0 = now();
    this.setState('syncing');
    await this.processOps();
    await this.syncFolderList();
    const folders = all('SELECT * FROM folders WHERE account_id = ? AND sync_enabled = 1', this.accountId);
    folders.sort((a, b) => rank(a) - rank(b));
    for (const f of folders) {
      if (this.stopped || !this.client) return;
      try { await this.syncFolder(f); delete this.status.folderErrors[f.path]; } catch (e) {
        if (!this.client?.usable) throw e;
        log.warn(`folder ${f.path}: ${e.responseText || e.message}`);
        this.status.folderErrors[f.path] = e.responseText || e.message;
      }
    }
    this.dirtyFolders.clear();
    this.reconcileOrphans();
    this.status.lastFullAt = now(); this.status.lastFullMs = now() - t0;
    this.setState('idle');
  }

  // Rows moved locally get uid NULL until the target folder sync re-discovers them. If no operation is
  // pending any more (succeeded or permanently failed), leftovers are stale: the server copy is
  // re-ingested from wherever it really is.
  reconcileOrphans() {
    if (get('SELECT 1 AS x FROM pending_ops WHERE account_id = ? AND attempts < 5', this.accountId)) return;
    const orphans = all(`SELECT m.id FROM messages m JOIN folders f ON f.id = m.folder_id
      WHERE m.account_id = ? AND m.uid IS NULL AND f.sync_enabled = 1 AND m.created_at < ?`, this.accountId, now() - 10 * 60e3).map((r) => r.id);
    if (orphans.length) { deleteMessages(orphans); log.info(`account ${this.accountId}: removed ${orphans.length} stale local copies`); }
    run('DELETE FROM pending_ops WHERE account_id = ? AND attempts >= 5 AND created_at < ?', this.accountId, now() - 7 * 864e5);
  }

  async syncFolderList() {
    const account = this.account;
    const list = await this.client.list();
    const seen = new Set();
    tx(() => {
      for (const box of list) {
        if (box.flags?.has('\\Noselect') || box.flags?.has('\\NonExistent')) continue;
        seen.add(box.path);
        const special = box.specialUse || (box.path.toUpperCase() === 'INBOX' ? '\\Inbox' : null);
        const existing = get('SELECT id FROM folders WHERE account_id = ? AND path = ?', account.id, box.path);
        if (existing) {
          run('UPDATE folders SET name = ?, delimiter = ?, special_use = ?, parent_path = ?, subscribed = ? WHERE id = ?',
            box.name, box.delimiter, special, box.parentPath || null, box.subscribed ? 1 : 0, existing.id);
        } else {
          // Gmail's "All Mail" duplicates every message; don't sync it by default.
          const syncEnabled = special === '\\All' || special === '\\Flagged' || special === '\\Important' ? 0 : 1;
          run('INSERT INTO folders (account_id, path, name, delimiter, special_use, parent_path, subscribed, sync_enabled) VALUES (?,?,?,?,?,?,?,?)',
            account.id, box.path, box.name, box.delimiter, special, box.parentPath || null, box.subscribed ? 1 : 0, syncEnabled);
        }
      }
      for (const f of all('SELECT id, path FROM folders WHERE account_id = ?', account.id)) {
        if (!seen.has(f.path)) run('DELETE FROM folders WHERE id = ?', f.id);
      }
    });
    notify(account.user_id, 'folders:changed', { accountId: account.id });
  }

  async syncFolder(folder) {
    const account = this.account;
    const client = this.client;
    const lock = await client.getMailboxLock(folder.path);
    let newIds = [];
    try {
      const box = client.mailbox;
      const uidValidity = String(box.uidValidity);
      if (folder.uidvalidity && folder.uidvalidity !== uidValidity) {
        log.info(`UIDVALIDITY changed for ${folder.path}, resetting`);
        deleteMessages(all('SELECT id FROM messages WHERE folder_id = ?', folder.id).map((r) => r.id));
        folder.last_uid = 0;
        folder.highest_modseq = null;
        run('UPDATE folders SET oldest_uid = NULL, history_done = 0 WHERE id = ?', folder.id);
      }

      // 1) New messages.
      let uids = [];
      if (box.exists > 0) {
        if (!folder.last_uid) {
          const since = new Date(now() - config.initialSyncDays * 864e5);
          uids = (await client.search({ since }, { uid: true })) || [];
          uids = uids.sort((a, b) => a - b).slice(-config.maxMessagesPerFolderInitial);
        } else if (!box.uidNext || box.uidNext > folder.last_uid + 1) {
          uids = ((await client.search({ uid: `${folder.last_uid + 1}:*` }, { uid: true })) || []).filter((u) => u > folder.last_uid);
        }
      }
      let maxUid = folder.last_uid || 0;
      // Newest first so the user sees recent mail quickly during initial sync.
      uids.sort((a, b) => b - a);
      for (let i = 0; i < uids.length; i += 25) {
        const batch = uids.slice(i, i + 25);
        for await (const msg of client.fetch(batch, { uid: true, flags: true, source: true, internalDate: true }, { uid: true })) {
          if (!msg.source) continue;
          try {
            const r = await ingestMessage({ account, folder, uid: msg.uid, flags: [...(msg.flags || [])], raw: msg.source, internalDate: msg.internalDate });
            if (r.isNew) newIds.push(r.id);
          } catch (e) { log.warn(`ingest ${folder.path}/${msg.uid}: ${e.message}`); }
          if (msg.uid > maxUid) maxUid = msg.uid;
        }
        if (!folder.last_uid && newIds.length) notify(account.user_id, 'mail:progress', { accountId: account.id, folderId: folder.id, count: newIds.length, total: uids.length });
      }

      // 2) Flag changes (CONDSTORE when available, otherwise full flag scan of known range).
      if (folder.last_uid) {
        const useModseq = box.highestModseq && folder.highest_modseq && client.enabled?.has('CONDSTORE');
        if (!useModseq || String(box.highestModseq) !== folder.highest_modseq) {
          const opts = { uid: true };
          if (useModseq) opts.changedSince = BigInt(folder.highest_modseq);
          const updates = [];
          for await (const msg of client.fetch(`1:${folder.last_uid}`, { uid: true, flags: true }, opts)) updates.push(msg);
          tx(() => {
            for (const msg of updates) {
              const f = flagsToCols([...(msg.flags || [])]);
              run('UPDATE messages SET is_read = ?, is_flagged = ?, is_answered = ?, is_draft = ? WHERE folder_id = ? AND uid = ?',
                f.is_read, f.is_flagged, f.is_answered, f.is_draft, folder.id, msg.uid);
            }
          });
        }
        // 3) Expunged messages.
        const serverUids = new Set((await client.search({ all: true }, { uid: true })) || []);
        const gone = all('SELECT id, uid FROM messages WHERE folder_id = ? AND uid IS NOT NULL', folder.id).filter((m) => !serverUids.has(m.uid)).map((m) => m.id);
        if (gone.length) deleteMessages(gone);
      }

      const fetchedMin = uids.length ? Math.min(...uids) : null;
      run(`UPDATE folders SET uidvalidity = ?, last_uid = ?, highest_modseq = ?, last_synced_at = ?, server_total = ?,
        oldest_uid = CASE WHEN ? IS NULL THEN oldest_uid WHEN oldest_uid IS NULL OR ? < oldest_uid THEN ? ELSE oldest_uid END WHERE id = ?`,
        uidValidity, maxUid, box.highestModseq ? String(box.highestModseq) : null, now(), box.exists ?? null, fetchedMin, fetchedMin, fetchedMin, folder.id);
    } finally {
      lock.release();
    }
    recountFolder(folder.id);
    if (newIds.length) {
      const fresh = get('SELECT * FROM folders WHERE id = ?', folder.id);
      await afterIngest(account, fresh, newIds, { initial: !folder.last_uid });
    }
    if (newIds.length) this.status.lastNewMailAt = now();
    notify(account.user_id, 'folder:synced', { accountId: account.id, folderId: folder.id, newCount: newIds.length });
  }

  // ---- history: older mail, downloaded after the quick first sync, back to the account's sync_history window.

  get historyPending() {
    return !!get("SELECT 1 AS x FROM folders WHERE account_id = ? AND sync_enabled = 1 AND history_done = 0 AND last_synced_at IS NOT NULL AND COALESCE(special_use, '') NOT IN ('\\Trash', '\\Junk')", this.accountId);
  }

  /** One batch of older messages per folder (Inbox first). New mail is never held up: work waiting for a sync wins. */
  async backfillHistory() {
    const account = this.account;
    const days = account.sync_history === 'all' ? 0 : Number(account.sync_history) || config.initialSyncDays;
    const folders = all("SELECT * FROM folders WHERE account_id = ? AND sync_enabled = 1 AND history_done = 0 AND last_synced_at IS NOT NULL AND COALESCE(special_use, '') NOT IN ('\\Trash', '\\Junk')", this.accountId)
      .sort((a, b) => rank(a) - rank(b));
    for (const folder of folders) {
      if (this.stopped || !this.client || this.hasPendingWork) return;
      const client = this.client;
      const lock = await client.getMailboxLock(folder.path);
      const newIds = [];
      let oldest = folder.oldest_uid, newest = 0, done = 0;
      try {
        const below = oldest || (client.mailbox.uidNext ? Number(client.mailbox.uidNext) : 0);
        if (!client.mailbox.exists || below <= 1) done = 1;
        else {
          const crit = { uid: `1:${below - 1}` };
          if (days) crit.since = new Date(now() - days * 864e5);
          const older = ((await client.search(crit, { uid: true })) || []).filter((u) => u < below).sort((a, b) => b - a);
          const batch = older.slice(0, HISTORY_BATCH);
          for (let i = 0; i < batch.length; i += 25) {
            for await (const msg of client.fetch(batch.slice(i, i + 25), { uid: true, flags: true, source: true, internalDate: true }, { uid: true })) {
              if (!msg.source) continue;
              try {
                const r = await ingestMessage({ account, folder, uid: msg.uid, flags: [...(msg.flags || [])], raw: msg.source, internalDate: msg.internalDate });
                if (r.isNew) newIds.push(r.id);
              } catch (e) { log.warn(`history ${folder.path}/${msg.uid}: ${e.message}`); }
            }
          }
          if (batch.length) { oldest = Math.min(...batch); newest = Math.max(...batch); }
          if (older.length <= HISTORY_BATCH) done = 1;
        }
        // last_uid only grows (a folder with no recent mail gets its first last_uid here, so new-mail checks start above it).
        run('UPDATE folders SET oldest_uid = ?, history_done = ?, last_uid = MAX(COALESCE(last_uid, 0), ?) WHERE id = ?', oldest ?? null, done, newest, folder.id);
      } finally { lock.release(); }
      recountFolder(folder.id);
      // Old mail: indexed for search/memory; analysed only within the analysis window (as on first sync).
      if (newIds.length) await afterIngest(account, get('SELECT * FROM folders WHERE id = ?', folder.id), newIds, { initial: true });
      notify(account.user_id, 'folder:synced', { accountId: account.id, folderId: folder.id, newCount: 0, history: newIds.length });
    }
  }

  // Replays locally-applied operations against the server.
  async processOps() {
    if (!this.client) return;
    const ops = all('SELECT id FROM pending_ops WHERE account_id = ? AND attempts < 5 ORDER BY id', this.accountId);
    for (const { id } of ops) {
      // Re-read: an undo may have shrunk or cancelled the op since the list was taken.
      const op = get('SELECT * FROM pending_ops WHERE id = ?', id);
      if (!op) continue;
      const p = json(op.payload_json, {});
      runningOps.add(op.id);
      try {
        await this.applyOp(op.op, p);
        run('DELETE FROM pending_ops WHERE id = ?', op.id);
      } catch (e) {
        log.warn(`op ${op.op} failed: ${e.responseText || e.message}`);
        run('UPDATE pending_ops SET attempts = attempts + 1, error = ? WHERE id = ?', e.message, op.id);
        if (!this.client?.usable) throw e;
      } finally { runningOps.delete(op.id); }
    }
  }

  async applyOp(type, p) {
    const c = this.client;
    switch (type) {
      case 'flags': {
        const lock = await c.getMailboxLock(p.folder);
        try {
          if (p.add?.length) await c.messageFlagsAdd(p.uids, p.add, { uid: true });
          if (p.remove?.length) await c.messageFlagsRemove(p.uids, p.remove, { uid: true });
        } finally { lock.release(); }
        break;
      }
      case 'move': {
        const lock = await c.getMailboxLock(p.from);
        try {
          const res = await c.messageMove(p.uids, p.to, { uid: true });
          const target = get('SELECT id FROM folders WHERE account_id = ? AND path = ?', this.accountId, p.to);
          if (res?.uidMap && target) {
            for (const [oldUid, newUid] of res.uidMap) {
              const localId = p.map?.[oldUid];
              if (localId) run('UPDATE messages SET uid = ? WHERE id = ? AND folder_id = ?', newUid, localId, target.id);
            }
          }
        } finally { lock.release(); }
        break;
      }
      case 'delete': {
        const lock = await c.getMailboxLock(p.folder);
        try { await c.messageDelete(p.uids, { uid: true }); } finally { lock.release(); }
        break;
      }
      case 'append': {
        await c.append(p.folder, Buffer.from(p.raw, 'base64'), p.flags || ['\\Seen']);
        this.dirtyFolders.add(p.folder);
        break;
      }
      case 'deleteByMessageId': {
        // Replaced / discarded draft copies: only the message carrying this exact Message-ID.
        const lock = await c.getMailboxLock(p.folder);
        try {
          const uids = await c.search({ header: { 'message-id': p.messageId } }, { uid: true });
          if (uids?.length) await c.messageDelete(uids, { uid: true });
        } finally { lock.release(); }
        break;
      }
      case 'createFolder': await c.mailboxCreate(p.path); await this.syncFolderList(); break;
      case 'renameFolder': await c.mailboxRename(p.from, p.to); await this.syncFolderList(); break;
      case 'deleteFolder': await c.mailboxDelete(p.path); await this.syncFolderList(); break;
      case 'emptyFolder': {
        const lock = await c.getMailboxLock(p.folder);
        try { await c.messageDelete('1:*', { uid: true }); } finally { lock.release(); }
        break;
      }
      default: log.warn('unknown op', type);
    }
  }
}

function rank(f) {
  const i = SPECIAL_ORDER.indexOf(f.special_use);
  return i === -1 ? 100 : i;
}

class SyncManager {
  constructor() { this.workers = new Map(); }

  startAll() {
    for (const a of all('SELECT id FROM accounts WHERE sync_enabled = 1')) this.start(a.id);
  }

  start(accountId) {
    if (this.workers.has(accountId)) return this.workers.get(accountId);
    const w = new AccountSync(accountId);
    this.workers.set(accountId, w);
    w.start().finally(() => { if (this.workers.get(accountId) === w) this.workers.delete(accountId); });
    return w;
  }

  async restart(accountId) {
    await this.stop(accountId);
    this.start(accountId);
  }

  async stop(accountId) {
    const w = this.workers.get(accountId);
    this.workers.delete(accountId);
    if (w) await w.stop();
  }

  trigger(accountId, folderPath) {
    const w = this.workers.get(accountId);
    if (w) w.trigger(folderPath); else this.start(accountId);
  }

  /** Live connection details of an account's sync worker (null when not running). */
  status(accountId) {
    const w = this.workers.get(accountId);
    if (!w) return null;
    const c = w.client;
    return { ...w.status, connected: !!c?.usable, push: !!(c?.usable && c.idling), selected: c?.mailbox?.path || null };
  }

  async stopAll() { await Promise.all([...this.workers.keys()].map((id) => this.stop(id))); }
}

export const syncManager = new SyncManager();

// Queue a server-side operation and wake the account's worker.
/** Ids of pending_ops currently being executed against the server (an undo must not edit those). */
export const runningOps = new Set();

export function queueOp(accountId, op, payload) {
  run('INSERT INTO pending_ops (account_id, op, payload_json, created_at) VALUES (?, ?, ?, ?)', accountId, op, JSON.stringify(payload), now());
  syncManager.trigger(accountId);
}
