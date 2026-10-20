import { get, all, run, update } from '../db/index.js';
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
