import { get, all, run, update, now, json } from '../db/index.js';
import { requireUser } from '../auth.js';
import { httpError } from './util.js';
import { userAccounts, userAccount, serializeAccount, accountFields, createAccount, ACCOUNT_COLS } from '../accounts.js';
import { discover } from '../mail/autoconfig.js';
import { testAccount } from '../mail/connection.js';
import { syncManager } from '../mail/sync.js';
import { encrypt, randomToken } from '../util/crypto.js';
import { PROVIDERS, oauthAvailable, authorizeUrl, exchangeCode, redirectUri } from '../mail/oauth.js';
import { syncDav } from '../scheduler.js';
import { invalidate } from '../ai/memory.js';
import { purgeMemory } from '../mail/pipeline.js';
import { smtpStatus } from '../mail/send.js';

const pendingOAuth = new Map(); // state -> { userId, provider, accountId, t }

export default async function accountRoutes(app) {
  app.get('/api/accounts', { preHandler: requireUser }, async (req) => userAccounts(req.user.id).map(serializeAccount));

  app.get('/api/accounts/discover', { preHandler: requireUser }, async (req, reply) => {
    try { return { ...(await discover(String(req.query.email || ''))), oauthAvailable: oauthAvailable() }; } catch (e) { return httpError(reply, 400, e.message); }
  });

  app.post('/api/accounts/test', { preHandler: requireUser }, async (req) => {
    const b = req.body || {};
    const existing = b.id ? userAccount(req.user.id, b.id) : null;
    const draft = { ...(existing || {}), ...Object.fromEntries(Object.entries(accountFields(b)).filter(([, v]) => v !== undefined)) };
    draft.auth_type ||= 'password';
    return testAccount(draft);
  });

  // Connection health of every account: IMAP sync worker, queued server operations, last SMTP result, outbox problems.
  app.get('/api/accounts/status', { preHandler: requireUser }, async (req) => userAccounts(req.user.id).map((a) => ({
    id: a.id, email: a.email, syncEnabled: !!a.sync_enabled, state: a.sync_state, error: a.sync_error, lastSyncAt: a.last_sync_at,
    imap: syncManager.status(a.id),
    pendingOps: get('SELECT COUNT(*) AS n FROM pending_ops WHERE account_id = ? AND attempts < 5', a.id).n,
    failedOps: all('SELECT id, op, error, attempts, created_at AS createdAt FROM pending_ops WHERE account_id = ? AND attempts > 0 ORDER BY id DESC LIMIT 5', a.id),
    smtp: smtpStatus.get(a.id) || null,
    outboxFailed: get("SELECT COUNT(*) AS n FROM outbox WHERE account_id = ? AND status = 'failed'", a.id).n,
    outboxRetrying: get("SELECT COUNT(*) AS n FROM outbox WHERE account_id = ? AND status = 'queued' AND attempts > 0", a.id).n,
    // Messages on the server vs. downloaded (synced folders), and whether older mail is still being downloaded.
    mailbox: get(`SELECT COALESCE(SUM(server_total), 0) AS onServer, SUM(CASE WHEN history_done = 0 AND last_synced_at IS NOT NULL THEN 1 ELSE 0 END) AS foldersPending,
      (SELECT COUNT(*) FROM messages m JOIN folders f2 ON f2.id = m.folder_id WHERE f2.account_id = ? AND f2.sync_enabled = 1) AS downloaded
      FROM folders WHERE account_id = ? AND sync_enabled = 1`, a.id, a.id),
    history: a.sync_history || '90',
    historyFolders: all("SELECT name FROM folders WHERE account_id = ? AND sync_enabled = 1 AND history_done = 0 AND last_synced_at IS NOT NULL AND COALESCE(special_use, '') NOT IN ('\\Trash', '\\Junk') LIMIT 5", a.id).map((f) => f.name),
  })));

  // Everything that currently needs the user's attention (shown as the red indicator): mail server connections,
  // sending, server changes that failed, sent mail that is not on the server yet. Never silent.
  app.get('/api/status/problems', { preHandler: requireUser }, async (req) => {
    const out = [];
    const t = now();
    for (const a of userAccounts(req.user.id)) {
      const who = a.email;
      const st = syncManager.status(a.id);
      if (a.sync_enabled && !st?.connected && (a.sync_state === 'error' || st?.lastError)) {
        out.push({ key: `imap:${a.id}`, level: 'error', accountId: a.id, title: `${who}: cannot connect to the mail server`, text: st?.lastError || a.sync_error || '', at: st?.lastErrorAt, actions: ['reconnect'] });
      }
      for (const [folder, err] of Object.entries(st?.folderErrors || {})) {
        out.push({ key: `folder:${a.id}:${folder}`, level: 'warn', accountId: a.id, title: `${who}: folder “${folder}” cannot be synchronised`, text: err });
      }
      const smtp = smtpStatus.get(a.id);
      if (smtp && !smtp.ok) out.push({ key: `smtp:${a.id}`, level: 'error', accountId: a.id, title: `${who}: sending failed`, text: smtp.error || 'no details from the server', at: smtp.at, actions: ['test'] });
      for (const o of all('SELECT id, op, error, attempts, created_at FROM pending_ops WHERE account_id = ? AND attempts > 0 ORDER BY id DESC LIMIT 20', a.id)) {
        out.push({ key: `op:${o.id}`, level: o.attempts >= 5 ? 'error' : 'warn', accountId: a.id, opId: o.id,
          title: `${who}: ${o.op === 'append' ? 'saving a copy on the server' : `server change “${o.op}”`} ${o.attempts >= 5 ? 'failed' : 'is being retried'}`,
          text: o.error || '', at: o.created_at, actions: o.attempts >= 5 ? ['retry-op', 'dismiss-op'] : [] });
      }
      for (const r of all("SELECT id, payload_json, status, error, attempts, send_at FROM outbox WHERE account_id = ? AND (status = 'failed' OR (status = 'queued' AND attempts > 0))", a.id)) {
        const p = json(r.payload_json, {});
        out.push({ key: `outbox:${r.id}`, level: r.status === 'failed' ? 'error' : 'warn', accountId: a.id, outboxId: r.id,
          title: `${r.status === 'failed' ? 'Not sent' : `Not sent yet (try ${r.attempts + 1} at ${new Date(r.send_at).toLocaleTimeString()})`}: “${p.subject || '(no subject)'}”`,
          text: r.error || '', actions: ['retry-send', 'to-draft'] });
      }
      const unsaved = get(`SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND local_copy = 1 AND uid IS NULL AND created_at < ?
        AND id NOT IN (SELECT json_extract(payload_json, '$.localId') FROM pending_ops WHERE account_id = ? AND op = 'append' AND attempts < 5 AND json_extract(payload_json, '$.localId') IS NOT NULL)`,
        a.id, t - 120e3, a.id).n;
      if (unsaved) out.push({ key: `unsaved:${a.id}`, level: 'error', accountId: a.id, title: `${who}: ${unsaved} sent message${unsaved > 1 ? 's are' : ' is'} not saved on the server`, text: 'They were sent, but other mail apps will not show them in Sent.', actions: ['save-unsaved'] });
    }
    return { problems: out.sort((x, y) => (x.level === y.level ? 0 : x.level === 'error' ? -1 : 1)) };
  });

  // A server change that keeps failing: try it again now, or drop it (only the queued change; local mail stays as it is).
  app.post('/api/accounts/:id/ops/:opId/retry', { preHandler: requireUser }, async (req, reply) => {
    const a = userAccount(req.user.id, req.params.id);
    if (!a) return httpError(reply, 404, 'Not found');
    run('UPDATE pending_ops SET attempts = 0, error = NULL WHERE id = ? AND account_id = ?', req.params.opId, a.id);
    syncManager.trigger(a.id);
    return { ok: true };
  });
  app.delete('/api/accounts/:id/ops/:opId', { preHandler: requireUser }, async (req, reply) => {
    const a = userAccount(req.user.id, req.params.id);
    if (!a) return httpError(reply, 404, 'Not found');
    run('DELETE FROM pending_ops WHERE id = ? AND account_id = ? AND attempts > 0', req.params.opId, a.id);
    return { ok: true };
  });

  // Test the stored IMAP + SMTP settings of an existing account (read-only: logs in, lists folders, verifies SMTP).
  app.post('/api/accounts/:id/test', { preHandler: requireUser }, async (req, reply) => {
    const a = userAccount(req.user.id, req.params.id);
    if (!a) return httpError(reply, 404, 'Not found');
    const r = await testAccount(a);
    if (r.smtp) smtpStatus.set(a.id, { ...r.smtp, at: Date.now(), tested: true });
    return { ...r, at: Date.now() };
  });

  app.post('/api/accounts', { preHandler: requireUser }, async (req, reply) => {
    const b = req.body || {};
    if (!b.email || !b.imap?.host || !b.smtp?.host) return httpError(reply, 400, 'Email, IMAP and SMTP settings are required');
    if (all('SELECT id FROM accounts WHERE user_id = ? AND lower(email) = lower(?)', req.user.id, b.email).length) return httpError(reply, 400, 'This account already exists');
    const a = createAccount(req.user.id, b);
    syncManager.start(a.id);
    if (a.caldav_url || a.carddav_url) syncDav(a);
    return serializeAccount(a);
  });

  app.patch('/api/accounts/:id', { preHandler: requireUser }, async (req, reply) => {
    const a = userAccount(req.user.id, req.params.id);
    if (!a) return httpError(reply, 404, 'Not found');
    update('accounts', a.id, accountFields(req.body || {}), ACCOUNT_COLS);
    const fresh = userAccount(req.user.id, a.id);
    // A wider history window: continue downloading older mail (a narrower one keeps what is already here).
    if (req.body?.syncHistory !== undefined && fresh.sync_history !== a.sync_history) {
      run('UPDATE folders SET history_done = 0 WHERE account_id = ?', a.id);
      syncManager.trigger(a.id);
    }
    const connChanged = ['imap', 'smtp', 'syncEnabled'].some((k) => req.body?.[k] !== undefined);
    if (connChanged) { if (fresh.sync_enabled) await syncManager.restart(a.id); else await syncManager.stop(a.id); }
    if (req.body?.caldavUrl !== undefined || req.body?.carddavUrl !== undefined) syncDav(fresh);
    return serializeAccount(fresh);
  });

  app.delete('/api/accounts/:id', { preHandler: requireUser }, async (req, reply) => {
    const a = userAccount(req.user.id, req.params.id);
    if (!a) return httpError(reply, 404, 'Not found');
    await syncManager.stop(a.id);
    run('DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE account_id = ?)', a.id);
    run('DELETE FROM accounts WHERE id = ?', a.id);
    run('DELETE FROM calendars WHERE account_id = ?', a.id);
    run('DELETE FROM address_books WHERE account_id = ?', a.id);
    // Nothing learned from a removed account stays in the AI memory.
    run('DELETE FROM memory WHERE user_id = ? AND owner = ?', req.user.id, `a:${a.id}`);
    run('DELETE FROM facts WHERE user_id = ? AND owner = ?', req.user.id, `a:${a.id}`);
    purgeMemory();
    invalidate(req.user.id);
    return { ok: true };
  });

  app.post('/api/accounts/:id/sync', { preHandler: requireUser }, async (req, reply) => {
    const a = userAccount(req.user.id, req.params.id);
    if (!a) return httpError(reply, 404, 'Not found');
    await syncManager.restart(a.id);
    syncDav(a);
    return { ok: true };
  });

  // ---- OAuth (Google / Microsoft)
  app.get('/api/oauth/:provider/start', { preHandler: requireUser }, async (req, reply) => {
    const provider = req.params.provider;
    if (!PROVIDERS[provider] || !oauthAvailable()[provider]) return httpError(reply, 400, `${provider} OAuth is not configured on this server`);
    const state = randomToken(16);
    pendingOAuth.set(state, { userId: req.user.id, provider, accountId: req.query.accountId ? Number(req.query.accountId) : null, t: Date.now() });
    return reply.redirect(authorizeUrl(provider, state, redirectUri(req)));
  });

  app.get('/api/oauth/callback', async (req, reply) => {
    const { state, code, error } = req.query;
    const p = pendingOAuth.get(state);
    pendingOAuth.delete(state);
    const done = (msg) => reply.type('text/html').send(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px"><p>${msg}</p><script>setTimeout(()=>{ if (window.opener) { window.opener.postMessage({type:'halcyon-oauth'}, '*'); window.close(); } else location.href='/#/settings/accounts'; }, 800)</script>`);
    if (!p || Date.now() - p.t > 15 * 60e3) return done('Sign-in session expired. Please try again.');
    if (error) return done(`Sign-in failed: ${String(error).replace(/[<>]/g, '')}`);
    try {
      const { email, name, tokens } = await exchangeCode(p.provider, code, redirectUri(req));
      const prov = PROVIDERS[p.provider];
      const fields = { auth_type: `oauth-${p.provider}`, oauth_enc: encrypt(JSON.stringify(tokens)) };
      let account = p.accountId ? userAccount(p.userId, p.accountId) : get('SELECT * FROM accounts WHERE user_id = ? AND lower(email) = lower(?)', p.userId, email);
      if (account) {
        update('accounts', account.id, fields, ACCOUNT_COLS);
        await syncManager.restart(account.id);
      } else {
        account = createAccount(p.userId, {
          email, name: email, displayName: name || '', imap: { ...prov.imap, user: email }, smtp: { ...prov.smtp, user: email },
          caldavUrl: prov.caldav || undefined, carddavUrl: prov.carddav || undefined,
        }, fields);
        syncManager.start(account.id);
        if (prov.caldav || prov.carddav) syncDav(userAccount(p.userId, account.id));
      }
      return done(`Connected ${email}. You can close this window.`);
    } catch (e) {
      return done(`Sign-in failed: ${String(e.message).replace(/[<>]/g, '')}`);
    }
  });
}
