// Firebase Cloud Messaging (HTTP v1) for the native Android app: a data message per device token, signed in with the
// Firebase project's service account (OAuth2 JWT bearer, no Google SDK). Only what the notification shows travels
// (title, body, where it opens); the message itself stays on this server.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { config } from './config.js';

let account, accountErr, access = null;

/** The service account from HALCYON_FCM_SERVICE_ACCOUNT, or null when Android push is not set up. */
export function fcmAccount() {
  if (account !== undefined) return account;
  account = null;
  if (!config.fcm.serviceAccount) return account;
  try {
    const a = JSON.parse(fs.readFileSync(config.fcm.serviceAccount, 'utf8'));
    if (!a.project_id || !a.client_email || !a.private_key) throw new Error('not a service-account key (project_id, client_email, private_key)');
    account = a;
  } catch (e) { accountErr = `HALCYON_FCM_SERVICE_ACCOUNT: ${e.message}`; }
  return account;
}
export const fcmError = () => (fcmAccount(), accountErr || null);

const b64url = (b) => Buffer.from(b).toString('base64url');
async function accessToken(a) {
  if (access && access.until > Date.now() + 60e3) return access.token;
  const tokenUri = a.token_uri || 'https://oauth2.googleapis.com/token';
  const t = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({
    iss: a.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: tokenUri, iat: t, exp: t + 3600,
  }))}`;
  const jwt = `${unsigned}.${crypto.sign('RSA-SHA256', Buffer.from(unsigned), a.private_key).toString('base64url')}`;
  const r = await fetch(tokenUri, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error(`Firebase sign-in: ${r.status} ${d.error_description || d.error || ''}`.trim());
  access = { token: d.access_token, until: Date.now() + (Number(d.expires_in) || 3600) * 1000 };
  return access.token;
}

/**
 * Sends one message. data: flat string values. notification ({ title, body, channel, tag, silent }): also shown by
 * Google Play services itself while the app is in the background — it does not depend on the app being woken (which
 * battery savers on many phones delay or refuse); in the foreground the app draws it from the data.
 * Resolves { ok } or { gone } (the token is no longer valid: the app
 * was uninstalled or its data cleared); other failures throw.
 */
export async function fcmSend(token, data, { ttlSeconds = 6 * 3600, notification = null } = {}) {
  const a = fcmAccount();
  if (!a) throw new Error(accountErr || 'Android push is not set up (HALCYON_FCM_SERVICE_ACCOUNT)');
  const send = async () => fetch(`${config.fcm.url}/v1/projects/${encodeURIComponent(a.project_id)}/messages:send`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${await accessToken(a)}` },
    body: JSON.stringify({ message: {
      token, data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v == null ? '' : String(v)])),
      ...(notification ? { notification: { title: notification.title, body: notification.body || '' } } : {}),
      android: { priority: 'HIGH', ttl: `${ttlSeconds}s`, ...(notification ? { notification: {
        channel_id: notification.channel, tag: notification.tag, icon: 'ic_notify', color: '#2563EB', default_sound: !notification.silent,
        notification_priority: notification.silent ? 'PRIORITY_LOW' : 'PRIORITY_HIGH', visibility: 'PRIVATE',
      } } : {}) },
    } }),
  });
  let r = await send();
  if (r.status === 401) { access = null; r = await send(); } // the access token was revoked or expired early
  if (r.ok) return { ok: true };
  const d = await r.json().catch(() => ({}));
  const code = d.error?.details?.find((x) => x.errorCode)?.errorCode || d.error?.status || '';
  if (r.status === 404 || code === 'UNREGISTERED' || (r.status === 400 && code === 'INVALID_ARGUMENT' && /token/i.test(d.error?.message || ''))) return { gone: true };
  throw new Error(`${r.status} ${code} ${d.error?.message || ''}`.trim());
}
