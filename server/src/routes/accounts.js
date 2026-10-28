import { get, all, run, update, now, json } from '../db/index.js';
import { requireUser } from '../auth.js';
import { httpError } from './util.js';
import { userAccounts, userAccount, serializeAccount, accountFields, createAccount, ACCOUNT_COLS } from '../accounts.js';
import { discover } from '../mail/autoconfig.js';
import { testAccount } from '../mail/connection.js';
import { syncManager } from '../mail/sync.js';
import { encrypt, randomToken } from '../util/crypto.js';
import { PROVIDERS, oauthAvailable, authorizeUrl, exchangeCode, redirectUri, oauthClient, saveOAuthClient, providerServices } from '../mail/oauth.js';
import { notify } from '../util/events.js';
import { syncDav, davStatus } from '../scheduler.js';
import { getSettings } from '../settings.js';
import { sharedOf } from '../shared.js';
import { autoReplyOf, autoReplyActive } from '../mail/extras.js';
import { invalidate } from '../ai/memory.js';
import { purgeMemory } from '../mail/pipeline.js';
import { smtpStatus } from '../mail/send.js';

const pendingOAuth = new Map(); // state -> { userId, provider, accountId, t }

export default async function accountRoutes(app) {
  // With "shared mail in My mail" on, the shared spaces' accounts are listed too (to reply from them), marked.
  // Automatic replies (out of office) of an account (mail/extras.js).
  app.get('/api/accounts/:id/auto-reply', { preHandler: requireUser }, async (req, reply) => {
    const a = userAccount(req.user.id, req.params.id);
    return a ? { ...autoReplyOf(a), active: autoReplyActive(autoReplyOf(a)) } : httpError(reply, 404, 'Not found');
  });
  app.put('/api/accounts/:id/auto-reply', { preHandler: requireUser }, async (req, reply) => {
    const a = userAccount(req.user.id, req.params.id);
    if (!a) return httpError(reply, 404, 'Not found');
    const b = req.body || {};
    const cfg = { enabled: !!b.enabled, start: Number(b.start) || null, end: Number(b.end) || null, subject: String(b.subject || '').slice(0, 200),
      message: String(b.message || '').slice(0, 5000), onlyContacts: !!b.onlyContacts, days: Math.max(1, Math.min(30, Number(b.days) || 4)) };
    if (cfg.enabled && !cfg.message.trim()) return httpError(reply, 400, 'Write the reply first');
    run('UPDATE accounts SET auto_reply_json = ? WHERE id = ?', JSON.stringify(cfg), a.id);
    // A new period: everyone may get the reply again.
    if (cfg.enabled && !autoReplyOf(a).enabled) run('DELETE FROM auto_replied WHERE account_id = ?', a.id);
    return { ...cfg, active: autoReplyActive(cfg) };
  });

  app.get('/api/accounts', { preHandler: requireUser }, async (req) => [
    ...userAccounts(req.user.id).map(serializeAccount),
    ...(!req.person && getSettings(req.user.id).ui.showShared ? sharedOf(req.user.id).flatMap((sp) => userAccounts(sp.id).map((a) => ({ ...serializeAccount(a), owner: sp.id, ownerName: sp.name }))) : []),
  ]);

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
        // An OAuth account whose sign-in expired or was revoked needs the user to sign in again.
        const oauth = a.auth_type?.startsWith('oauth') ? a.auth_type.slice(6) : null;
        out.push({ key: `imap:${a.id}`, level: 'error', accountId: a.id, provider: oauth, title: `${who}: cannot connect to the mail server`, text: st?.lastError || a.sync_error || '', at: st?.lastErrorAt,
          actions: oauth ? ['reauth', 'reconnect'] : ['reconnect'] });
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
      // Sent, but some recipients were refused by the mail server (last 3 days).
      for (const r of all("SELECT id, payload_json, error FROM outbox WHERE account_id = ? AND status = 'sent' AND error IS NOT NULL AND sent_at > ?", a.id, t - 3 * 864e5)) {
        out.push({ key: `partial:${r.id}`, level: 'error', accountId: a.id, title: `Not delivered to everyone: “${json(r.payload_json, {}).subject || '(no subject)'}”`, text: r.error || '', actions: [] });
      }
      const unsaved = get(`SELECT COUNT(*) AS n FROM messages WHERE account_id = ? AND local_copy = 1 AND uid IS NULL AND created_at < ?
        AND id NOT IN (SELECT json_extract(payload_json, '$.localId') FROM pending_ops WHERE account_id = ? AND op = 'append' AND attempts < 5 AND json_extract(payload_json, '$.localId') IS NOT NULL)`,
        a.id, t - 120e3, a.id).n;
      if (unsaved) out.push({ key: `unsaved:${a.id}`, level: 'error', accountId: a.id, title: `${who}: ${unsaved} sent message${unsaved > 1 ? 's are' : ' is'} not saved on the server`, text: 'They were sent, but other mail apps will not show them in Sent.', actions: ['save-unsaved'] });
    }
    for (const a of userAccounts(req.user.id)) {
      const d = davStatus.get(a.id);
      if (d?.error && (a.caldav_url || a.carddav_url)) out.push({ key: `dav:${a.id}`, level: 'error', accountId: a.id, title: `${a.email}: calendars / contacts are not synced`, text: d.error, at: d.at, actions: ['retry-dav'] });
    }
    for (const c of all('SELECT id, name, source, sync_error FROM calendars WHERE user_id = ? AND sync_error IS NOT NULL', req.user.id)) {
      out.push({ key: `cal:${c.id}`, level: c.source === 'caldav' ? 'error' : 'warn', calendarId: c.id,
        title: c.source === 'caldav' ? `Calendar “${c.name}”: changes not saved on the server` : `Calendar “${c.name}” could not be refreshed`, text: c.sync_error, actions: ['refresh-calendar'] });
    }
    for (const s of all('SELECT id, name, error FROM calendar_sources WHERE user_id = ? AND error IS NOT NULL', req.user.id)) {
      out.push({ key: `calsrc:${s.id}`, level: 'warn', sourceId: s.id, title: `Calendars from “${s.name}” could not be refreshed`, text: s.error, actions: ['refresh-source'] });
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

  // services: what the account is for — ['mail'] (default; IMAP/SMTP), ['calendar'] (CalDAV), ['contacts'] (CardDAV),
  // or several. A calendar / contacts account is waited for once, so the user sees what was found or why not.
  app.post('/api/accounts', { preHandler: requireUser }, async (req, reply) => {
    const b = req.body || {};
    const services = Array.isArray(b.services) && b.services.length ? b.services : ['mail', ...(b.caldavUrl ? ['calendar'] : []), ...(b.carddavUrl ? ['contacts'] : [])];
    const mail = services.includes('mail');
    if (mail && (!b.email || !b.imap?.host || !b.smtp?.host)) return httpError(reply, 400, 'Email, IMAP and SMTP settings are required');
    if (services.includes('calendar') && !b.caldavUrl) return httpError(reply, 400, 'Enter the CalDAV address');
    if (services.includes('contacts') && !b.carddavUrl) return httpError(reply, 400, 'Enter the CardDAV address');
    if (!mail && !services.includes('calendar') && !services.includes('contacts')) return httpError(reply, 400, 'Choose what to add');
    // A calendar / contacts account is named by its login (or server) when it has no email address.
    const email = String(b.email || b.davUser || (() => { try { return new URL(b.caldavUrl || b.carddavUrl).host; } catch { return 'Calendar'; } })()).trim();
    if (mail && all('SELECT id FROM accounts WHERE user_id = ? AND lower(email) = lower(?) AND mail != 0', req.user.id, email).length) return httpError(reply, 400, 'This account already exists');
    const a = createAccount(req.user.id, {
      ...b, email, caldavUrl: services.includes('calendar') ? b.caldavUrl : undefined, carddavUrl: services.includes('contacts') ? b.carddavUrl : undefined,
    }, mail ? {} : { mail: 0, sync_enabled: 0 });
    if (mail) syncManager.start(a.id);
    let dav = null;
    if (a.caldav_url || a.carddav_url) dav = mail ? (syncDav(a), null) : await Promise.race([syncDav(a), new Promise((r) => setTimeout(() => r({ pending: true }), 30e3))]);
    return { ...serializeAccount(userAccount(req.user.id, a.id)), dav };
  });

  // One service added to an account later: calendar / contacts ({ url, davUser?, davPassword? } — for a Google
  // account signed in with OAuth the address is Google's), or mail ({ imap, smtp } with passwords).
  app.post('/api/accounts/:id/services/:service', { preHandler: requireUser }, async (req, reply) => {
    const a = userAccount(req.user.id, req.params.id);
    if (!a || a.kind === 'archive') return httpError(reply, 404, 'Not found');
    const b = req.body || {};
    const google = a.auth_type === 'oauth-google';
    const { service } = req.params;
    if (service === 'calendar' || service === 'contacts') {
      const url = String(b.url || (google ? PROVIDERS.google[service === 'calendar' ? 'caldav' : 'carddav'] : '')).trim();
      if (!/^https?:\/\//.test(url)) return httpError(reply, 400, `Enter the ${service === 'calendar' ? 'CalDAV' : 'CardDAV'} address`);
      update('accounts', a.id, accountFields({ [service === 'calendar' ? 'caldavUrl' : 'carddavUrl']: url, davUser: b.davUser, davPassword: b.davPassword }), ACCOUNT_COLS);
      const fresh = userAccount(req.user.id, a.id);
      const dav = await Promise.race([syncDav(fresh), new Promise((r) => setTimeout(() => r({ pending: true }), 30e3))]);
      return { ...serializeAccount(userAccount(req.user.id, a.id)), dav };
    }
    if (service === 'mail') {
      if (!google && (!b.imap?.host || !b.smtp?.host)) return httpError(reply, 400, 'IMAP and SMTP settings are required');
      update('accounts', a.id, { ...accountFields(google ? { imap: { ...PROVIDERS.google.imap, user: a.email }, smtp: { ...PROVIDERS.google.smtp, user: a.email } } : b), mail: 1, sync_enabled: 1 }, [...ACCOUNT_COLS, 'mail']);
      await syncManager.restart(a.id);
      notify(req.user.id, 'folders:changed', {});
      return serializeAccount(userAccount(req.user.id, a.id));
    }
    return httpError(reply, 400, 'Unknown service');
  });

  // One service removed: what Halcyon keeps of it is deleted here — never anything on the server (the calendars,
  // contacts and mail stay there and can be added again). An account with nothing left is removed.
  app.delete('/api/accounts/:id/services/:service', { preHandler: requireUser }, async (req, reply) => {
    const a = userAccount(req.user.id, req.params.id);
    if (!a || a.kind === 'archive') return httpError(reply, 404, 'Not found');
    const { service } = req.params;
    if (service === 'calendar') {
      run("DELETE FROM calendars WHERE account_id = ? AND source = 'caldav'", a.id);
      run('UPDATE accounts SET caldav_url = NULL WHERE id = ?', a.id);
      notify(req.user.id, 'calendar:changed', {});
    } else if (service === 'contacts') {
      run("DELETE FROM address_books WHERE account_id = ? AND source = 'carddav'", a.id);
      run('UPDATE accounts SET carddav_url = NULL WHERE id = ?', a.id);
      notify(req.user.id, 'contacts:changed', {});
    } else if (service === 'mail') {
      await syncManager.stop(a.id);
      run('DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE account_id = ?)', a.id);
      run('DELETE FROM folders WHERE account_id = ?', a.id);
      run('DELETE FROM pending_ops WHERE account_id = ?', a.id);
      run("DELETE FROM memory WHERE user_id = ? AND owner = ? AND kind = 'message'", req.user.id, `a:${a.id}`);
      run('UPDATE accounts SET mail = 0, sync_enabled = 0 WHERE id = ?', a.id);
      notify(req.user.id, 'folders:changed', {});
    } else return httpError(reply, 400, 'Unknown service');
    davStatus.delete(a.id);
    const left = userAccount(req.user.id, a.id);
    if (left.mail === 0 && !left.caldav_url && !left.carddav_url) {
      run('DELETE FROM accounts WHERE id = ?', a.id);
      invalidate(req.user.id);
      return { removed: true };
    }
    return serializeAccount(left);
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
    // Calendars / contacts: the first sync is waited for (up to 30 s), so the user sees what was found — or why not.
    let dav = null;
    const davChanged = (fresh.caldav_url || fresh.carddav_url) && (fresh.caldav_url !== a.caldav_url || fresh.carddav_url !== a.carddav_url
      || fresh.dav_user !== a.dav_user || !!req.body?.davPassword || !davStatus.has(a.id) || !!davStatus.get(a.id)?.error);
    if (davChanged) dav = await Promise.race([syncDav(fresh), new Promise((r) => setTimeout(() => r({ pending: true }), 30e3))]);
    return { ...serializeAccount(fresh), dav };
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
    // ?dav=1: calendars and contacts only, waited for (the problems panel's "Try again").
    if (req.query.dav === '1') return { ok: true, dav: await syncDav(a) };
    await syncManager.restart(a.id);
    syncDav(a);
    return { ok: true };
  });

  // ---- OAuth client setup (administrators): needed once per server for "Sign in with Google / Microsoft".
  app.get('/api/admin/oauth', { preHandler: requireUser }, async (req, reply) => {
    if (!req.user.is_admin) return httpError(reply, 403, 'Admin only');
    const out = (p) => { const c = oauthClient(p); return { configured: !!c.clientId, clientId: c.clientId, source: c.source, tenant: p === 'microsoft' ? c.tenant : undefined }; };
    return { redirectUri: redirectUri(req), google: out('google'), microsoft: out('microsoft') };
  });
  app.put('/api/admin/oauth/:provider', { preHandler: requireUser }, async (req, reply) => {
    if (!req.user.is_admin) return httpError(reply, 403, 'Admin only');
    const p = req.params.provider;
    if (!PROVIDERS[p]) return httpError(reply, 404, 'Unknown provider');
    if (oauthClient(p).source === 'env') return httpError(reply, 400, 'This server sets it in its environment (GOOGLE_CLIENT_ID / MICROSOFT_CLIENT_ID)');
    const { clientId, clientSecret, tenant } = req.body || {};
    if (clientId && !clientSecret) return httpError(reply, 400, 'The client secret is needed too');
    saveOAuthClient(p, { clientId, clientSecret, tenant });
    return { ok: true, configured: !!clientId };
  });

  // ---- OAuth (Google / Microsoft)
  app.get('/api/oauth/:provider/start', { preHandler: requireUser }, async (req, reply) => {
    const provider = req.params.provider;
    if (!PROVIDERS[provider] || !oauthAvailable()[provider]) return httpError(reply, 400, `${provider} OAuth is not configured on this server`);
    const state = randomToken(16);
    // ?services=mail,calendar,contacts — what to add (an existing account keeps what it has).
    const services = providerServices(provider, String(req.query.services || '').split(',').filter(Boolean));
    pendingOAuth.set(state, { userId: req.user.id, provider, accountId: req.query.accountId ? Number(req.query.accountId) : null, services, t: Date.now() });
    return reply.redirect(authorizeUrl(provider, state, redirectUri(req), services));
  });

  app.get('/api/oauth/callback', async (req, reply) => {
    const { state, code, error } = req.query;
    const p = pendingOAuth.get(state);
    pendingOAuth.delete(state);
    // Google / Microsoft sign-in pages cut the link to the opening window (window.opener), so the result is also told
    // through a same-origin BroadcastChannel; the window then closes itself, or asks to be closed when it may not.
    const done = (msg, ok = false) => reply.type('text/html').send(`<!doctype html><meta charset="utf-8"><title>Halcyon</title>
<body style="font-family:system-ui;padding:40px;line-height:1.5"><p>${msg}</p><p id="c" style="color:#5b6474;display:none">You can close this window now.</p>
<script>
const m = { type: 'halcyon-oauth', ok: ${ok ? 'true' : 'false'} };
try { new BroadcastChannel('halcyon-oauth').postMessage(m); } catch (e) {}
try { localStorage.setItem('halcyon-oauth', JSON.stringify({ ...m, t: Date.now() })); } catch (e) {}
try { window.opener && window.opener.postMessage(m, location.origin); } catch (e) {}
setTimeout(() => { window.close(); setTimeout(() => { document.getElementById('c').style.display = 'block'; }, 300); }, ${ok ? 600 : 2500});
</script>`);
    if (!p || Date.now() - p.t > 15 * 60e3) return done('Sign-in session expired. Please try again.');
    if (error) return done(`Sign-in failed: ${String(error).replace(/[<>]/g, '')}`);
    try {
      const { email, name, tokens } = await exchangeCode(p.provider, code, redirectUri(req));
      const prov = PROVIDERS[p.provider];
      const want = new Set(p.services || providerServices(p.provider));
      const fields = { auth_type: `oauth-${p.provider}`, oauth_enc: encrypt(JSON.stringify(tokens)) };
      let account = p.accountId ? userAccount(p.userId, p.accountId) : get("SELECT * FROM accounts WHERE user_id = ? AND lower(email) = lower(?) AND COALESCE(kind, 'mail') != 'archive'", p.userId, email);
      // Only the services chosen are added; an existing account keeps the ones it has.
      const add = {
        ...(want.has('mail') ? { mail: 1, sync_enabled: 1 } : {}),
        ...(want.has('calendar') && prov.caldav ? { caldav_url: prov.caldav } : {}),
        ...(want.has('contacts') && prov.carddav ? { carddav_url: prov.carddav } : {}),
      };
      if (account) {
        update('accounts', account.id, { ...fields, ...add }, [...ACCOUNT_COLS, 'mail']);
        if (userAccount(p.userId, account.id).mail !== 0) await syncManager.restart(account.id);
      } else {
        account = createAccount(p.userId, {
          email, name: email, displayName: name || '', imap: { ...prov.imap, user: email }, smtp: { ...prov.smtp, user: email },
        }, { ...fields, ...add, ...(want.has('mail') ? {} : { mail: 0, sync_enabled: 0 }) });
        if (want.has('mail')) syncManager.start(account.id);
      }
      const fresh = userAccount(p.userId, account.id);
      if ((want.has('calendar') || want.has('contacts')) && (fresh.caldav_url || fresh.carddav_url)) syncDav(fresh);
      return done(`Connected ${String(email).replace(/[<>]/g, '')}.`, true);
    } catch (e) {
      return done(`Sign-in failed: ${String(e.message).replace(/[<>]/g, '')}`);
    }
  });
}
