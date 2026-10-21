// OAuth2 (XOAUTH2) for Google and Microsoft mailboxes. The OAuth client comes from env config, or else from what an
// administrator saved in Settings → Accounts (stored encrypted in app_state).
import { config } from '../config.js';
import { encrypt, decrypt } from '../util/crypto.js';
import { run, get } from '../db/index.js';

/** { clientId, clientSecret, tenant, source: 'env' | 'settings' | null } */
export function oauthClient(provider) {
  const env = config.oauth[provider] || {};
  if (env.clientId) return { ...env, source: 'env' };
  const saved = get('SELECT value FROM app_state WHERE key = ?', `oauth:${provider}`)?.value;
  const v = saved ? JSON.parse(decrypt(saved) || '{}') : {};
  return { clientId: v.clientId || '', clientSecret: v.clientSecret || '', tenant: v.tenant || env.tenant || 'common', source: v.clientId ? 'settings' : null };
}

export function saveOAuthClient(provider, { clientId, clientSecret, tenant }) {
  if (!clientId) { run('DELETE FROM app_state WHERE key = ?', `oauth:${provider}`); return; }
  run('INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)', `oauth:${provider}`, encrypt(JSON.stringify({ clientId: String(clientId).trim(), clientSecret: String(clientSecret || '').trim(), tenant: tenant || undefined })));
}

export const PROVIDERS = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://mail.google.com/ https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/carddav openid email profile',
    extra: { access_type: 'offline', prompt: 'consent' },
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    caldav: 'https://apidata.googleusercontent.com/caldav/v2/',
    carddav: 'https://www.googleapis.com/.well-known/carddav',
  },
  microsoft: {
    get authUrl() { return `https://login.microsoftonline.com/${oauthClient('microsoft').tenant}/oauth2/v2.0/authorize`; },
    get tokenUrl() { return `https://login.microsoftonline.com/${oauthClient('microsoft').tenant}/oauth2/v2.0/token`; },
    scope: 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email profile',
    extra: { prompt: 'select_account' },
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
  },
};

export const oauthAvailable = () => ({
  google: !!oauthClient('google').clientId,
  microsoft: !!oauthClient('microsoft').clientId,
});

export function redirectUri(req) {
  // Behind a TLS-terminating proxy (nginx) the request arrives as http; the proxy's X-Forwarded-Proto tells the
  // address the browser used (Google and Microsoft only accept https redirect addresses).
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || req.protocol;
  const base = config.publicUrl || `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  return `${base}/api/oauth/callback`;
}

export function authorizeUrl(provider, state, redirect) {
  const p = PROVIDERS[provider];
  const q = new URLSearchParams({ client_id: oauthClient(provider).clientId, redirect_uri: redirect, response_type: 'code', scope: p.scope, state, ...p.extra });
  return `${p.authUrl}?${q}`;
}

async function tokenRequest(provider, params) {
  const p = PROVIDERS[provider];
  const c = oauthClient(provider);
  const body = new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...params });
  const r = await fetch(p.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const data = await r.json();
  if (!r.ok) throw new Error(`OAuth error: ${data.error_description || data.error || r.status}`);
  return data;
}

export async function exchangeCode(provider, code, redirect) {
  const t = await tokenRequest(provider, { grant_type: 'authorization_code', code, redirect_uri: redirect });
  let email = null, name = null;
  if (t.id_token) {
    const claims = JSON.parse(Buffer.from(t.id_token.split('.')[1], 'base64url').toString());
    email = claims.email || claims.preferred_username; name = claims.name;
  }
  return { email, name, tokens: { provider, access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + (t.expires_in - 60) * 1000 } };
}

// Returns a valid access token for an account, refreshing if needed.
export async function accessToken(account) {
  const tok = JSON.parse(decrypt(account.oauth_enc) || '{}');
  if (tok.access_token && tok.expires_at > Date.now()) return tok.access_token;
  if (!tok.refresh_token) throw new Error('OAuth session expired — please reconnect the account');
  const t = await tokenRequest(tok.provider, { grant_type: 'refresh_token', refresh_token: tok.refresh_token });
  const next = { ...tok, access_token: t.access_token, refresh_token: t.refresh_token || tok.refresh_token, expires_at: Date.now() + (t.expires_in - 60) * 1000 };
  run('UPDATE accounts SET oauth_enc = ? WHERE id = ?', encrypt(JSON.stringify(next)), account.id);
  return next.access_token;
}

export const isOAuth = (account) => account.auth_type?.startsWith('oauth');
export const reloadAccount = (id) => get('SELECT * FROM accounts WHERE id = ?', id);
