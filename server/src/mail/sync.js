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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class AccountSync {
  constructor(accountId) {
    this.accountId = accountId;
    this.client = null;
    this.stopped = false;
    this.wake = null;            // resolves the idle wait so a sync runs immediately
    this.dirtyFolders = new Set();
    this.backoff = 5000;
    this.running = false;
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
    this.wake?.();
  }

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
  }

  async loop() {
    let lastFull = now();
    while (!this.stopped && this.client) {
      // Keep INBOX selected so the server pushes EXISTS via IDLE.
      const inbox = get("SELECT path FROM folders WHERE account_id = ? AND special_use = '\\Inbox'", this.accountId);
      if (inbox && this.client.mailbox?.path !== inbox.path) await this.client.mailboxOpen(inbox.path);
      await this.waitFor(config.pollIntervalSec * 1000);
      if (!this.client || this.stopped) break;
      await this.processOps();
      if (now() - lastFull >= config.pollIntervalSec * 1000) {
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
      }
    }
  }

  async fullCycle() {
    this.setState('syncing');
    await this.processOps();
    await this.syncFolderList();
    const folders = all('SELECT * FROM folders WHERE account_id = ? AND sync_enabled = 1', this.accountId);
    folders.sort((a, b) => rank(a) - rank(b));
    for (const f of folders) {
      if (this.stopped || !this.client) return;
      try { await this.syncFolder(f); } catch (e) {
        if (!this.client?.usable) throw e;
        log.warn(`folder ${f.path}: ${e.responseText || e.message}`);
      }
    }
    this.dirtyFolders.clear();
    this.reconcileOrphans();
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

      run('UPDATE folders SET uidvalidity = ?, last_uid = ?, highest_modseq = ?, last_synced_at = ? WHERE id = ?',
        uidValidity, maxUid, box.highestModseq ? String(box.highestModseq) : null, now(), folder.id);
    } finally {
      lock.release();
    }
    recountFolder(folder.id);
    if (newIds.length) {
      const fresh = get('SELECT * FROM folders WHERE id = ?', folder.id);
      await afterIngest(account, fresh, newIds, { initial: !folder.last_uid });
    }
    notify(account.user_id, 'folder:synced', { accountId: account.id, folderId: folder.id, newCount: newIds.length });
  }

  // Replays locally-applied operations against the server.
  async processOps() {
    if (!this.client) return;
    const ops = all('SELECT * FROM pending_ops WHERE account_id = ? AND attempts < 5 ORDER BY id', this.accountId);
    for (const op of ops) {
      const p = json(op.payload_json, {});
      try {
        await this.applyOp(op.op, p);
        run('DELETE FROM pending_ops WHERE id = ?', op.id);
      } catch (e) {
        log.warn(`op ${op.op} failed: ${e.responseText || e.message}`);
        run('UPDATE pending_ops SET attempts = attempts + 1, error = ? WHERE id = ?', e.message, op.id);
        if (!this.client?.usable) throw e;
      }
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

  async stopAll() { await Promise.all([...this.workers.keys()].map((id) => this.stop(id))); }
}

export const syncManager = new SyncManager();

// Queue a server-side operation and wake the account's worker.
export function queueOp(accountId, op, payload) {
  run('INSERT INTO pending_ops (account_id, op, payload_json, created_at) VALUES (?, ?, ?, ?)', accountId, op, JSON.stringify(payload), now());
  syncManager.trigger(accountId);
}
