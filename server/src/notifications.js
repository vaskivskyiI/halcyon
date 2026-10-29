// Notifications on the user's devices: the open app (over the event socket), Web Push to phones and browsers that
// subscribed (also when Halcyon is closed — no Google/Firebase account needed; the browser's push service is used) and
// Firebase Cloud Messaging to the native Android app (fcm.js; only when the server has a Firebase service account).
// One place decides what notifies, by the user's settings: which mail (all / important / none), reminders, quiet
// hours, muted accounts and shared spaces, and whether the content is shown on the lock screen.
import webpush from 'web-push';
import { get, all, run, json, now } from './db/index.js';
import { getSettings } from './settings.js';
import { notify } from './util/events.js';
import { logger } from './util/log.js';
import { fcmSend } from './fcm.js';

const log = logger('notify');

/** The server's VAPID key pair (made once, kept in app_state). */
export function vapidKeys() {
  const row = get("SELECT value FROM app_state WHERE key = 'vapid'");
  if (row) return JSON.parse(row.value);
  const keys = webpush.generateVAPIDKeys();
  run("INSERT OR REPLACE INTO app_state (key, value) VALUES ('vapid', ?)", JSON.stringify(keys));
  return keys;
}

export function subscribe(userId, sub, device = '') {
  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('Not a push subscription');
  run(`INSERT INTO push_subscriptions (user_id, endpoint, keys_json, device, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys_json = excluded.keys_json, device = excluded.device`,
  userId, String(sub.endpoint), JSON.stringify(sub.keys), String(device || '').slice(0, 80), now());
}
export const unsubscribe = (userId, endpoint) => run('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', userId, String(endpoint || '')).changes;
export const devices = (userId) => [
  ...all('SELECT id, device, created_at AS createdAt, last_ok_at AS lastOkAt FROM push_subscriptions WHERE user_id = ? ORDER BY id', userId),
  ...all("SELECT id, device, created_at AS createdAt, last_ok_at AS lastOkAt, 'android' AS kind FROM fcm_tokens WHERE user_id = ? ORDER BY id", userId),
];

/** The Android app on this device registers its FCM token (moves to this user if another had it). */
export function registerFcm(userId, token, device = '') {
  token = String(token || '').trim();
  if (!/^[\w:.-]{20,4096}$/.test(token)) throw new Error('Not an FCM token');
  run(`INSERT INTO fcm_tokens (user_id, token, device, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, device = excluded.device`, userId, token, String(device || '').slice(0, 80), now());
}
export const unregisterFcm = (userId, token) => run('DELETE FROM fcm_tokens WHERE user_id = ? AND token = ?', userId, String(token || '')).changes;

/** The notification settings with defaults (older settings: newMail / onlyImportant). */
export function prefsOf(userId) {
  const n = getSettings(userId).notifications || {};
  return {
    mail: n.mail || (n.newMail === false ? 'none' : n.onlyImportant ? 'important' : 'all'),
    reminders: n.reminders !== false, hideContent: !!n.hideContent, sound: n.sound !== false,
    quiet: { enabled: !!n.quiet?.enabled, start: n.quiet?.start || '22:00', end: n.quiet?.end || '07:00' },
    muteAccounts: (n.muteAccounts || []).map(Number), muteShared: (n.muteShared || []).map(Number),
  };
}

const minutes = (hm) => { const [h, m] = String(hm).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
/** Within the user's quiet hours now (in their time zone)? */
export function inQuietHours(userId, p = prefsOf(userId), t = now()) {
  if (!p.quiet.enabled) return false;
  const tz = getSettings(userId).calendar.timezone;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const cur = Number(parts.hour) * 60 + Number(parts.minute), a = minutes(p.quiet.start), b = minutes(p.quiet.end);
  return a <= b ? cur >= a && cur < b : cur >= a || cur < b;
}

/** Who is told about something of `ownerId` (a person, or a shared space's members). */
const recipients = (ownerId) => {
  const kind = get('SELECT kind FROM users WHERE id = ?', ownerId)?.kind;
  return kind === 'shared' ? all('SELECT user_id AS id FROM shared_members WHERE shared_id = ?', ownerId).map((r) => ({ id: r.id, shared: ownerId })) : [{ id: ownerId, shared: null }];
};

/**
 * kind: 'mail' (new mail; data.important for mail the AI rates important) | 'reminder'. data: { title, body, url, tag,
 * accountId, important }. Each recipient's settings decide; allowed notifications go to the open app and to push.
 */
export function notifyUser(ownerId, kind, data) {
  for (const r of recipients(ownerId)) {
    const p = prefsOf(r.id);
    if (kind === 'mail') {
      if (p.mail === 'none' || (p.mail === 'important' && !data.important)) continue;
      if (data.accountId && p.muteAccounts.includes(Number(data.accountId))) continue;
      if (r.shared && p.muteShared.includes(r.shared)) continue;
    }
    if (kind === 'reminder' && !p.reminders) continue;
    if (inQuietHours(r.id, p)) continue;
    const msg = {
      title: p.hideContent && kind === 'mail' ? (data.important ? 'Important email' : 'New email') : data.title,
      body: p.hideContent && kind === 'mail' ? '' : data.body || '', url: data.url || '#/mail/unified', tag: data.tag || kind, silent: !p.sound, as: r.shared,
    };
    notify(r.id, 'notify:show', msg);
    push(r.id, msg).catch((e) => log.warn(`push: ${e.message}`));
    pushFcm(r.id, kind, msg).catch((e) => log.warn(`fcm: ${e.message}`));
  }
}

async function push(userId, msg) {
  const subs = all('SELECT * FROM push_subscriptions WHERE user_id = ?', userId);
  if (!subs.length) return;
  const keys = vapidKeys();
  const host = get("SELECT value FROM app_state WHERE key = 'public_host'")?.value || 'localhost';
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: json(s.keys_json, {}) }, JSON.stringify(msg),
        { vapidDetails: { subject: `mailto:postmaster@${host}`, publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 6 * 3600, urgency: msg.tag === 'reminder' ? 'high' : 'normal' });
      run('UPDATE push_subscriptions SET last_ok_at = ? WHERE id = ?', now(), s.id);
    } catch (e) {
      // Gone (the app was uninstalled or the permission withdrawn): forget it.
      if ([404, 410].includes(e.statusCode)) run('DELETE FROM push_subscriptions WHERE id = ?', s.id);
      else log.warn(`push to ${s.device || s.id}: ${e.statusCode || ''} ${e.message}`);
    }
  }
}

async function pushFcm(userId, kind, msg) {
  const tokens = all('SELECT * FROM fcm_tokens WHERE user_id = ?', userId);
  for (const t of tokens) {
    try {
      const r = await fcmSend(t.token, { ...msg, kind, as: msg.as || '' }, { ttlSeconds: kind === 'reminder' ? 3600 : 6 * 3600 });
      if (r.gone) run('DELETE FROM fcm_tokens WHERE id = ?', t.id);
      else run('UPDATE fcm_tokens SET last_ok_at = ? WHERE id = ?', now(), t.id);
    } catch (e) { log.warn(`fcm to ${t.device || t.id}: ${e.message}`); }
  }
}
