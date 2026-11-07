// Injected by the Windows app (MainForm.Bridge) into the server's pages before they run. Gives the web app the same
// window.halcyonDesktop the Electron preload does (desktop/preload.js) and shows its notifications as Windows toasts.
(() => {
  const ORIGIN = __ORIGIN__;
  const wv = window.chrome && window.chrome.webview;
  if (!wv || window.top !== window || location.origin !== ORIGIN) return;
  const post = (m) => wv.postMessage(m);
  let rid = 0;
  const replies = {};
  const ask = (type) => new Promise((ok) => { const id = ++rid; replies[id] = ok; post({ type, rid: id }); });

  // The app shows notifications itself while it runs (also hidden in the tray). WebView2 has no Web Push, so the web
  // app is told push is unsupported here and notifies through new Notification() (util.js notifyDesktop).
  try { delete window.PushManager; } catch {}

  const page = Math.random().toString(36).slice(2, 10); // a click on an older page's toast only moves to its place
  let seq = 0;
  const shown = new Map();
  const fire = (n, type) => {
    const ev = new Event(type, { cancelable: true });
    try { if (typeof n['on' + type] === 'function') n['on' + type].call(n, ev); } catch (e) { console.error(e); }
    n.dispatchEvent(ev);
  };
  class HalcyonNotification extends EventTarget {
    static get permission() { return 'granted'; }
    static requestPermission(cb) { try { if (cb) cb('granted'); } catch {} return Promise.resolve('granted'); }
    static get maxActions() { return 0; }
    constructor(title, o = {}) {
      super();
      Object.assign(this, { title: String(title ?? ''), body: String(o.body ?? ''), tag: String(o.tag ?? ''), icon: o.icon || '', silent: !!o.silent, data: o.data ?? null,
        onclick: null, onshow: null, onclose: null, onerror: null });
      this._id = ++seq;
      // Same tag: the toast is replaced (the older object is no longer clickable, as in browsers).
      if (this.tag) for (const [k, n] of shown) if (n.tag === this.tag) shown.delete(k);
      shown.set(this._id, this);
      const d = this.data || {};
      post({ type: 'notify', page, id: this._id, title: this.title, body: this.body, tag: this.tag, silent: this.silent, route: typeof d.url === 'string' ? d.url : '',
        ref: typeof d.ref === 'string' ? d.ref : '', actions: Array.isArray(d.actions) ? d.actions : [], as: d.as == null ? '' : String(d.as), important: !!d.important });
      setTimeout(() => fire(this, 'show'));
    }
    close() {
      if (!shown.delete(this._id)) return;
      post({ type: 'close', page, id: this._id, tag: this.tag });
      fire(this, 'close');
    }
  }
  Object.defineProperty(window, 'Notification', { value: HalcyonNotification, writable: true, configurable: true });

  wv.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.type === 'reply') { const r = replies[m.rid]; delete replies[m.rid]; if (r) r(m.value); }
    if (m.type === 'notification-click') {
      const n = m.page === page && shown.get(m.id);
      if (n) { shown.delete(n._id); fire(n, 'click'); } // its onclick knows the place and the shared space (App.jsx)
      else if (typeof m.route === 'string' && m.route.startsWith('#/')) location.hash = m.route;
    }
    // A toast's button (MainForm.Arrive): the web app asks the server to do it (App.jsx).
    if (m.type === 'notification-action') window.dispatchEvent(new CustomEvent('halcyon:notification-action', { detail: { ref: m.ref, action: m.action, tag: m.tag, as: m.as } }));
  });

  window.halcyonDesktop = Object.freeze({
    isDesktop: true,
    platform: 'win32',
    shell: 'windows', // this app, not Electron: no local server, no offline copy
    version: __VERSION__,
    setBadge: (count, dataUrl) => post({ type: 'badge', count: Number(count) || 0, dataUrl: typeof dataUrl === 'string' ? dataUrl : '' }),
    show: () => post({ type: 'show' }),
    info: () => ask('info'),
    // connect.html's call in Electron; here the native server window opens.
    saveConnection: () => post({ type: 'changeServer' }),
    changeServer: () => post({ type: 'changeServer' }),
    // Not in the Electron preload: removes a toast by its tag (Notification.close() does the same for its own).
    closeNotification: (tag) => post({ type: 'close', tag: String(tag || '') }),
  });
})();
