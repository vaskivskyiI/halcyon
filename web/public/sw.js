// Halcyon service worker: push notifications (also when the app is closed), and a copy of the app and of what it
// showed, so it opens at once — also without a connection (the Android app after a while, a tab that slept):
// - the app's files come from the copy (hashed files never change; the page itself is checked first),
// - data is asked from the server first; with no network, or no answer within a few seconds, the last copy is
//   shown at once (marked, so the app says it is offline) and the fresh answer, when it comes, is stored and the
//   app is told to refresh,
// - changes always need the server. Signing out removes the copy.
const DATA = 'halcyon-data-v1', APP = 'halcyon-app-v1';
// Never kept: the live socket, sign-in (the sign-in state is: the app starts with it), push, AI answers and streams,
// imports, diagnostics.
const SKIP = /^\/api\/(ws|auth\/(?!status)|oauth|mcp|push\/|diagnostics|archives\/(\d+\/import|uploads)|ai\/(chat|assist|draft|reply|translate|rewrite|compose|brief\/regenerate|suggest)|events\/\d+\/prep)/;
const WAIT = 4000;
const MAX_ENTRY = 10e6;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('halcyon-') && ![DATA, APP].includes(k)) await caches.delete(k);
  await self.clients.claim();
})()));

const offline = (what) => new Response(JSON.stringify({ error: what === 'change'
  ? 'You are offline — this change needs the connection to your Halcyon server. Try again when you are online.'
  : 'Offline — not available on this device yet.', offline: true }), { status: 503, headers: { 'content-type': 'application/json', 'x-halcyon-offline': '1' } });

// Data depends on whose mail (x-halcyon-as) and which space (x-halcyon-space) is asked for: part of the key.
function keyOf(req, url) {
  const k = new URL(url);
  k.searchParams.set('__as', req.headers.get('x-halcyon-as') || '');
  k.searchParams.set('__sp', req.headers.get('x-halcyon-space') || '');
  return k.href;
}

let puts = 0;
async function store(cache, key, res) {
  const type = res.headers.get('content-type') || '';
  if (res.status !== 200 || /ndjson|event-stream/.test(type) || res.headers.get('x-halcyon-offline') || Number(res.headers.get('content-length') || 0) > MAX_ENTRY) return;
  const body = await res.clone().blob();
  if (body.size > MAX_ENTRY) return;
  const headers = new Headers(res.headers);
  headers.set('x-halcyon-cached-at', String(Date.now()));
  await cache.put(key, new Response(body, { status: 200, headers }));
  // Oldest entries go when the copy grows large (keys come back oldest first).
  if (++puts % 100 === 0) { const keys = await cache.keys(); if (keys.length > 5000) for (const k of keys.slice(0, keys.length - 4000)) await cache.delete(k); }
}

async function fromCopy(cache, key) {
  const hit = await cache.match(key);
  if (!hit) return null;
  const headers = new Headers(hit.headers);
  headers.set('x-halcyon-offline', '1');
  return new Response(await hit.blob(), { status: hit.status, headers });
}

async function tell(type) {
  for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type });
}

/** Server first; no network or no answer in WAIT ms → the copy now, the fresh answer stored (and announced) later. */
async function networkFirst(e, req, key, cacheName, fallback) {
  const cache = await caches.open(cacheName);
  const net = fetch(req).then(async (res) => { await store(cache, key, res); return res; });
  const timer = new Promise((r) => setTimeout(() => r('wait'), navigator.onLine === false ? 0 : WAIT));
  let first;
  try { first = await Promise.race([net, timer]); } catch {
    return (await fromCopy(cache, key)) || fallback();
  }
  if (first !== 'wait') {
    // A server restarting (or its proxy without it) answers 502-504: the copy serves meanwhile.
    if (first.status >= 502 && first.status <= 504) return (await fromCopy(cache, key)) || first;
    return first;
  }
  const copy = await fromCopy(cache, key);
  if (!copy) return net.catch(() => fallback());
  e.waitUntil(net.then(() => tell('halcyon:fresh')).catch(() => {}));
  return copy;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const api = url.pathname.startsWith('/api/') || url.pathname.includes('/api/');
  if (req.method !== 'GET') {
    if (!api || SKIP.test(url.pathname.replace(/^.*?(\/api\/)/, '$1')) && !/\/auth\/logout$/.test(url.pathname)) return;
    e.respondWith(fetch(req).then(async (res) => {
      if (/\/api\/auth\/logout$/.test(url.pathname) && res.ok) await caches.delete(DATA); // signing out leaves nothing here
      return res;
    }, () => offline('change')));
    return;
  }
  if (api) {
    const path = url.pathname.replace(/^.*?(\/api\/)/, '$1');
    if (SKIP.test(path) || /[?&](wait|refresh)=1/.test(url.search) || /attachments\/\d+/.test(path) && url.searchParams.get('inline') !== '1') return;
    e.respondWith(networkFirst(e, req, keyOf(req, url), DATA, () => offline('read')));
    return;
  }
  // The app: its page checked first (new versions arrive), its hashed files from the copy.
  if (req.mode === 'navigate') {
    const key = new URL('./', self.registration.scope).href;
    e.respondWith(networkFirst(e, req, key, APP, () => new Response('<!doctype html><meta charset="utf-8"><title>Halcyon</title><p style="font-family:system-ui;padding:40px">Halcyon is offline and has not been opened on this device before.</p>', { status: 503, headers: { 'content-type': 'text/html' } })));
    return;
  }
  e.respondWith(caches.open(APP).then(async (cache) => {
    const hit = /\/assets\//.test(url.pathname) && await cache.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    } catch { return (await cache.match(req)) || Response.error(); }
  }));
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Halcyon', body: e.data?.text() || '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Halcyon', {
    body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag, silent: !!d.silent,
    icon: './icon-192.png', badge: './badge-96.png', data: { url: d.url || '#/mail/unified', as: d.as || null },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const { url, as } = e.notification.data || {};
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => w.url.startsWith(self.registration.scope)) || wins[0];
    if (win) {
      win.postMessage({ type: 'halcyon:open', url, as });
      return win.focus();
    }
    return self.clients.openWindow(new URL(`./${url && url.startsWith('#') ? url : ''}`, self.registration.scope).href);
  })());
});
