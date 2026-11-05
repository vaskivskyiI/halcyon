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
export function registerFcm(userId, token, device = '', version = null) {
  token = String(token || '').trim();
  if (!/^[\w:.-]{20,4096}$/.test(token)) throw new Error('Not an FCM token');
  run(`INSERT INTO fcm_tokens (user_id, token, device, created_at, app_version) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, device = excluded.device, app_version = COALESCE(excluded.app_version, app_version)`,
  userId, token, String(device || '').slice(0, 80), now(), Number(version) || null);
  // The app replaces Chrome's Web Push on Android (the earlier app): both would notify twice, and Chrome warns about
  // a site that keeps notifying through it.
  return run("DELETE FROM push_subscriptions WHERE user_id = ? AND device = 'Android'", userId).changes;
}
/** A device removed in Settings → Notifications (kind 'android': the app; else a browser's Web Push). */
export const removeDevice = (userId, kind, id) => run(`DELETE FROM ${kind === 'android' ? 'fcm_tokens' : 'push_subscriptions'} WHERE user_id = ? AND id = ?`, userId, Number(id)).changes;
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
 * kind: 'mail' (new mail; data.important for mail the AI rates important, data.modes: the settings it is for) | 'reminder'. data: { title, body, url, tag,
 * accountId, important, type ('mail' | 'event' | 'task': the icon), about (when to take it back, see sweepNotifications) }.
 * Each recipient's settings decide; allowed notifications go to the open app and to push.
 */
export function notifyUser(ownerId, kind, data) {
  if (data.about) showing.set(`${ownerId}\n${data.tag || kind}`, { ownerId, tag: data.tag || kind, about: data.about, at: now() });
  for (const r of recipients(ownerId)) {
    const p = prefsOf(r.id);
    if (kind === 'mail') {
      // modes: who a notification is for — 'focused' gets new mail once it is in Focused (after the AI's sorting), so
      // the arrival of mail the AI is still to read is told to 'all' only. Important mail goes to every mode but none.
      if (p.mail === 'none') continue;
      if (!data.important && (p.mail === 'important' || (data.modes && !data.modes.includes(p.mail)))) continue;
      if (data.accountId && p.muteAccounts.includes(Number(data.accountId))) continue;
      if (r.shared && p.muteShared.includes(r.shared)) continue;
    }
    if (kind === 'reminder' && !p.reminders) continue;
    if (inQuietHours(r.id, p)) continue;
    const msg = {
      title: p.hideContent && kind === 'mail' ? (data.important ? 'Important email' : 'New email') : data.title,
      body: p.hideContent && kind === 'mail' ? '' : data.body || '', url: data.url || '#/mail/unified', tag: data.tag || kind, silent: !p.sound, as: r.shared,
      type: data.type || (kind === 'mail' ? 'mail' : 'event'),
    };
    notify(r.id, 'notify:show', msg);
    push(r.id, msg).catch((e) => log.warn(`push: ${e.message}`));
    pushFcm(r.id, kind, msg, remember(r.id, kind, msg, data.about ? `${ownerId}\n${msg.tag}` : null)).catch((e) => log.warn(`fcm: ${e.message}`));
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

async function pushFcm(userId, kind, msg, entry) {
  const tokens = all('SELECT * FROM fcm_tokens WHERE user_id = ?', userId);
  for (const t of tokens) {
    try {
      // The app's own connection took it (it answered): Firebase is not needed. No answer in time: Firebase too.
      const d = live.get(t.token);
      if (d?.userId === userId && (await deliver(d, entry))) { run('UPDATE fcm_tokens SET last_ok_at = ? WHERE id = ?', now(), t.id); continue; }
      // route: the extra the app reads when the system's own notification is tapped (data travels as intent extras).
      const r = await fcmSend(t.token, { ...msg, kind, as: msg.as || '', route: msg.url }, {
        ttlSeconds: kind === 'reminder' ? 3600 : 6 * 3600,
        notification: { title: msg.title, body: msg.body, tag: msg.tag, silent: msg.silent, icon: `ic_notify_${msg.type}`,
          channel: kind === 'reminder' ? 'reminders' : msg.silent ? 'mail_silent' : 'mail' },
      });
      if (r.gone) run('DELETE FROM fcm_tokens WHERE id = ?', t.id);
      else run('UPDATE fcm_tokens SET last_ok_at = ? WHERE id = ?', now(), t.id);
    } catch (e) { log.warn(`fcm to ${t.device || t.id}: ${e.message}`); }
  }
}

// ---- taking notifications back: what was notified and no longer applies (the mail read or moved out of the inbox, the
// task done, the event over) is removed from every device. Kept in memory: after a restart devices keep what they show.
const showing = new Map(); // `${ownerId}\n${tag}` -> { ownerId, tag, about: { mail: [ids] } | { task: id } | { until: ms }, at }

export async function closeNotifications(ownerId, tags) {
  tags = [...new Set(tags.filter(Boolean).map(String))];
  if (!tags.length) return;
  for (const t of tags) showing.delete(`${ownerId}\n${t}`);
  for (const r of recipients(ownerId)) {
    notify(r.id, 'notify:close', { tags });
    for (const e of sent.get(r.id) || []) if (tags.includes(e.msg.tag) && !e.closedAt) e.closedAt = now();
    // Data only and normal priority: nothing is shown, so the phone is not woken for it. Older app versions would
    // draw an empty notification for it, so only versions that know it get it.
    for (const t of all('SELECT * FROM fcm_tokens WHERE user_id = ? AND app_version IS NOT NULL', r.id)) {
      const d = live.get(t.token);
      if (d?.userId === r.id) { d.send({ type: 'notify:close', payload: { tags, at: now() } }); continue; }
      try {
        const res = await fcmSend(t.token, { action: 'close', tags: tags.join('\n') }, { ttlSeconds: 6 * 3600, priority: 'NORMAL' });
        if (res.gone) run('DELETE FROM fcm_tokens WHERE id = ?', t.id);
      } catch (e) { log.warn(`fcm close to ${t.device || t.id}: ${e.message}`); }
    }
  }
}

const stillApplies = (about) => {
  if (about.until) return now() < about.until;
  if (about.task) return !!get('SELECT 1 AS x FROM tasks WHERE id = ? AND done = 0', about.task);
  const ids = (about.mail || []).map(Number).filter(Boolean);
  return !!ids.length && !!get(`SELECT 1 AS x FROM messages m JOIN folders f ON f.id = m.folder_id
    WHERE m.id IN (${ids.map(() => '?').join(',')}) AND m.is_read = 0 AND f.special_use = '\\Inbox' LIMIT 1`, ...ids);
};

/** Checks what is showing (every few seconds, and right after mail is marked read or moved here). */
export async function sweepNotifications() {
  const gone = new Map();
  for (const [key, s] of showing) {
    if (now() - s.at > 3 * 864e5) { showing.delete(key); continue; }
    if (!stillApplies(s.about)) { if (!gone.has(s.ownerId)) gone.set(s.ownerId, []); gone.get(s.ownerId).push(s.tag); }
  }
  for (const [ownerId, tags] of gone) await closeNotifications(ownerId, tags);
}
let soon = null;
export const sweepSoon = () => { if (!soon && showing.size) soon = setTimeout(() => { soon = null; sweepNotifications().catch((e) => log.warn(`sweep: ${e.message}`)); }, 1500); };

// ---- the Android app's own connection (android LiveService): a WebSocket the app keeps open, so notifications do not
// depend on Firebase alone, which phones hold back for apps not opened in a while. Each notification is answered by
// the app; one not answered in time goes through Firebase as well. What was sent while the app was away is sent again
// when it is back (still applying, and not yet answered by that device), and so are the notifications taken back.
const live = new Map(); // FCM token -> { userId, send, waits: Map(id -> done) }
const sent = new Map(); // recipient user id -> [{ id, at, kind, msg, key, answered: Set(token), closedAt }]
let lastId = 0;
const KEEP = 864e5, RESEND = 6 * 3600e3;

function remember(userId, kind, msg, key) {
  const e = { id: ++lastId, at: now(), kind, msg, key, answered: new Set(), closedAt: 0 };
  const list = (sent.get(userId) || []).filter((x) => e.at - x.at < KEEP).slice(-199);
  list.push(e);
  sent.set(userId, list);
  return e;
}

let answerMs = 15e3;
export const setAnswerMs = (ms) => { answerMs = ms; }; // tests
function deliver(d, e, ms = answerMs) {
  if (!e) return Promise.resolve(false);
  return new Promise((done) => {
    const t = setTimeout(() => { d.waits.delete(e.id); done(false); }, ms);
    d.waits.set(e.id, (ok) => { clearTimeout(t); d.waits.delete(e.id); if (ok) e.answered.add(d.token); done(ok); });
    d.send({ type: 'notify:show', payload: { ...e.msg, kind: e.kind, id: e.id, at: e.at } });
  });
}

/** The app connected (index.js /api/ws?device=…): `since` is the server time it last heard from us. */
export function attachDevice(userId, token, since, send) {
  const d = { userId, token, send, waits: new Map() };
  const before = live.get(token);
  live.set(token, d);
  before?.waits.forEach((w) => w(false));
  since = Number(since) || 0;
  if (since > 0) {
    const closed = [];
    for (const e of sent.get(userId) || []) {
      if (e.closedAt) { if (e.closedAt > since) closed.push(e.msg.tag); continue; }
      if (e.at <= since || e.answered.has(token)) continue;
      if (e.key ? showing.has(e.key) : now() - e.at < RESEND) deliver(d, e);
    }
    if (closed.length) send({ type: 'notify:close', payload: { tags: [...new Set(closed)], at: now() } });
  }
  send({ type: 'hello', payload: { userId, now: now() } });
  return {
    answer: (id) => d.waits.get(Number(id))?.(true),
    detach: () => { if (live.get(token) === d) live.delete(token); d.waits.forEach((w) => w(false)); },
  };
}
export const isLive = (token) => live.has(token);
