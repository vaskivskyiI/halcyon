// Halcyon service worker: shows push notifications (also when the app is closed) and opens the right place when one
// is tapped. It caches nothing — the app always loads fresh from the server.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

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
