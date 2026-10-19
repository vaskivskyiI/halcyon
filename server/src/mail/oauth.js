// OAuth2 (XOAUTH2) for Google and Microsoft mailboxes. Client IDs come from env config.
import { config } from '../config.js';
import { encrypt, decrypt } from '../util/crypto.js';
import { run, get } from '../db/index.js';

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
    get authUrl() { return `https://login.microsoftonline.com/${config.oauth.microsoft.tenant}/oauth2/v2.0/authorize`; },
    get tokenUrl() { return `https://login.microsoftonline.com/${config.oauth.microsoft.tenant}/oauth2/v2.0/token`; },
    scope: 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email profile',
    extra: { prompt: 'select_account' },
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
  },
};

export const oauthAvailable = () => ({
  google: !!config.oauth.google.clientId,
  microsoft: !!config.oauth.microsoft.clientId,
});

export function redirectUri(req) {
  const base = config.publicUrl || `${req.protocol}://${req.headers.host}`;
  return `${base}/api/oauth/callback`;
}

export function authorizeUrl(provider, state, redirect) {
  const p = PROVIDERS[provider];
  const q = new URLSearchParams({ client_id: config.oauth[provider].clientId, redirect_uri: redirect, response_type: 'code', scope: p.scope, state, ...p.extra });
  return `${p.authUrl}?${q}`;
}

async function tokenRequest(provider, params) {
  const p = PROVIDERS[provider];
  const body = new URLSearchParams({ client_id: config.oauth[provider].clientId, client_secret: config.oauth[provider].clientSecret, ...params });
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
