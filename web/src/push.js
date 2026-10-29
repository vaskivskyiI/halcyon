// Web Push on this device (phone, browser): the service worker shows notifications even when the app
// is closed. While push is on here, the open app leaves notifications to it (no doubles).
import { api } from './api.js';
import { navigate } from './util.js';
import { store } from './store.js';
import { enterShared } from './data.js';

// In the native Android app (android/) the page runs in a WebView that has no Web Push: the app's bridge
// (window.halcyonAndroid) gets a Firebase Cloud Messaging token instead, registered here with this session.
const android = () => window.halcyonAndroid || null;
let seq = 0;
const waiting = {};
window.halcyonAndroidResolve = (id, res) => { const w = waiting[id]; delete waiting[id]; if (!w) return; if (res?.error) w[1](new Error(res.error)); else w[0](res); };
const ask = (method) => new Promise((ok, no) => { const id = ++seq; waiting[id] = [ok, no]; android().call(id, method); });
const androidState = () => { try { return JSON.parse(android().pushState()); } catch { return {}; } };
let fcm = null;
const serverFcm = async () => (fcm ||= await api.get('/api/push/fcm').catch(() => ({ available: false })));

/** Android app: a token that changed while the app was closed is registered again on each start. */
async function androidStart() {
  const s = androidState();
  // A tapped notification or launcher shortcut opens its place (and the shared space it belongs to).
  window.halcyonOpen = async (url, as) => {
    // Right after the start the signed-in state is still loading: which space is open is known only then.
    for (let i = 0; i < 50 && !store.get().settings; i++) await new Promise((r) => setTimeout(r, 200));
    const st = store.get();
    if (as && Number(as) !== st.acting?.id && !st.settings?.ui?.showShared) return enterShared(Number(as));
    if (url) navigate(url);
  };
  android().ready?.();
  if (s.on && s.token && (await serverFcm()).available) api.post('/api/push/fcm/register', { token: s.token, device: s.device || 'Android' }).catch(() => {});
}

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;

let reg = null;
export async function registerWorker() {
  if (android()) androidStart().catch(() => {});
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
  try { reg = await navigator.serviceWorker.register('./sw.js', { scope: './' }); } catch { reg = null; }
  // A tapped notification opens its place in the running app.
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'halcyon:open' && e.data.url) navigate(e.data.url);
    // The service worker showed its copy and has the fresh answer now: the app asks again.
    if (e.data?.type === 'halcyon:fresh') window.dispatchEvent(new Event('halcyon:refresh'));
  });
  return reg;
}

export async function pushState() {
  if (android()) {
    const s = androidState(), f = await serverFcm();
    return { supported: !!s.available && f.available, on: !!s.on && f.available, permission: s.permission || 'default', android: true,
      problem: !s.available ? 'This build of the app has no Firebase setup (google-services.json), so it cannot receive notifications.' : !f.available ? `This server is not set up for Android notifications${f.error ? `: ${f.error}` : ' (HALCYON_FCM_SERVICE_ACCOUNT)'}.` : '' };
  }
  if (!supported()) return { supported: false, on: false, permission: 'unsupported' };
  const r = reg || (await navigator.serviceWorker.getRegistration());
  const sub = r && (await r.pushManager.getSubscription());
  return { supported: true, on: !!sub, permission: Notification.permission };
}

const b64 = (s) => { const p = '='.repeat((4 - (s.length % 4)) % 4); const raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); };
const deviceName = () => { const ua = navigator.userAgent; return /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iPhone / iPad' : /Windows/i.test(ua) ? 'Windows' : /Mac/i.test(ua) ? 'Mac' : /Linux/i.test(ua) ? 'Linux' : 'Browser'; };

export async function enablePush() {
  if (android()) {
    const { token, device } = await ask('enable'); // asks for the notification permission (Android 13+) and a token
    await api.post('/api/push/fcm/register', { token, device: device || 'Android' });
    android().setOn(true);
    return true;
  }
  if (!supported()) throw new Error('This browser cannot receive push notifications (on iPhone: add Halcyon to the home screen first)');
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked for Halcyon in this browser');
  const r = reg || (await registerWorker());
  const { publicKey } = await api.get('/api/push/key');
  const sub = (await r.pushManager.getSubscription()) || (await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(publicKey) }));
  await api.post('/api/push/subscribe', { subscription: sub.toJSON(), device: deviceName() });
  return true;
}

export async function disablePush() {
  if (android()) {
    const { token } = androidState();
    android().setOn(false);
    if (token) await api.post('/api/push/fcm/unregister', { token }).catch(() => {});
    return;
  }
  const r = reg || (await navigator.serviceWorker?.getRegistration());
  const sub = r && (await r.pushManager.getSubscription());
  if (sub) { await api.post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
}

let pushOn = null;
/** Whether this device gets push (then the open app does not show its own notifications). */
export async function pushIsOn() {
  if (pushOn === null) pushOn = (await pushState()).on;
  return pushOn;
}
export const resetPushCache = () => { pushOn = null; };
