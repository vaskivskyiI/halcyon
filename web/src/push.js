// Web Push on this device (phone, browser, the Android app): the service worker shows notifications even when the app
// is closed. While push is on here, the open app leaves notifications to it (no doubles).
import { api } from './api.js';
import { navigate } from './util.js';

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;

let reg = null;
export async function registerWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return null;
  try { reg = await navigator.serviceWorker.register('./sw.js', { scope: './' }); } catch { reg = null; }
  // A tapped notification opens its place in the running app.
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'halcyon:open' && e.data.url) navigate(e.data.url); });
  return reg;
}

export async function pushState() {
  if (!supported()) return { supported: false, on: false, permission: 'unsupported' };
  const r = reg || (await navigator.serviceWorker.getRegistration());
  const sub = r && (await r.pushManager.getSubscription());
  return { supported: true, on: !!sub, permission: Notification.permission };
}

const b64 = (s) => { const p = '='.repeat((4 - (s.length % 4)) % 4); const raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); };
const deviceName = () => { const ua = navigator.userAgent; return /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iPhone / iPad' : /Windows/i.test(ua) ? 'Windows' : /Mac/i.test(ua) ? 'Mac' : /Linux/i.test(ua) ? 'Linux' : 'Browser'; };

export async function enablePush() {
  if (!supported()) throw new Error('This browser cannot receive push notifications (on iPhone: add Halcyon to the home screen first)');
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked for Halcyon in this browser');
  const r = reg || (await registerWorker());
  const { publicKey } = await api.get('/api/push/key');
  const sub = (await r.pushManager.getSubscription()) || (await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(publicKey) }));
  await api.post('/api/push/subscribe', { subscription: sub.toJSON(), device: deviceName() });
  return true;
}

export async function disablePush() {
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
