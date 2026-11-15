// Notifications of the desktop app, as rich as the lightweight Windows app's (windows/Halcyon/Toasts.cs): on Windows a
// toast with an icon per kind (mail, important mail, calendar, task, other) and buttons (Mark read, Snooze, Done …,
// server notify-actions.js). A toast click or button starts the app through its own protocol (halcyon-desktop:…),
// which the running app receives as a second instance (main.js) — so it also works from the notification centre after
// the toast was gone. On macOS the buttons are the notification's actions; on Linux a click opens the place.
const { Notification, app } = require('electron');
const path = require('node:path');

const PROTOCOL = 'halcyon-desktop';
const shown = new Map(); // tag → Notification (kept, or a click on it is lost when it is collected)

const iconDir = () => (app.isPackaged ? path.join(process.resourcesPath, 'toast') : path.join(__dirname, 'build', 'toast'));
const kindOf = (tag, important) => (important ? 'important' : tag.startsWith('mail') ? 'mail' : tag.startsWith('rem-e') ? 'calendar' : tag.startsWith('rem-t') ? 'task' : 'other');
const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const q = (o) => new URLSearchParams(o).toString();

/** What a toast button does: a page to open (Join → the meeting), a place in the app (Reply), or an action the page
 *  asks the server to do (Mark read …). */
function buttonUrl(a, m) {
  if (/^https:\/\//i.test(a.url || '')) return a.url;
  if (String(a.url || '').startsWith('#/')) return `${PROTOCOL}:open?${q({ route: a.url })}`;
  return `${PROTOCOL}:action?${q({ ref: m.ref, action: a.id, tag: m.tag, as: m.as || '' })}`;
}

/** m: { id, title, body, tag, silent, route, ref, actions, as, important } from the page (web util.js notifyDesktop). */
function show(m, { onClick, onAction }) {
  if (!Notification.isSupported()) return;
  const tag = String(m.tag || `n${m.id}`).slice(0, 64);
  const actions = (m.ref && Array.isArray(m.actions) ? m.actions : []).filter((a) => a?.title && a?.id).slice(0, 5);
  const icon = path.join(iconDir(), `${kindOf(tag, m.important)}.png`);
  shown.get(tag)?.close();
  let n;
  if (process.platform === 'win32') {
    const launch = `${PROTOCOL}:open?${q({ id: m.id, route: m.route || '', as: m.as || '' })}`;
    const toastXml = `<toast launch="${esc(launch)}" activationType="protocol"><visual><binding template="ToastGeneric">`
      + `<text hint-maxLines="2">${esc(m.title || 'Halcyon')}</text>${m.body ? `<text>${esc(m.body)}</text>` : ''}`
      + `<image placement="appLogoOverride" src="${esc(`file:///${icon.replace(/\\/g, '/')}`)}"/></binding></visual>`
      + (actions.length ? `<actions>${actions.map((a) => `<action content="${esc(a.title)}" arguments="${esc(buttonUrl(a, m))}" activationType="protocol"/>`).join('')}</actions>` : '')
      + (m.silent ? '<audio silent="true"/>' : '') + '</toast>';
    n = new Notification({ toastXml });
  } else {
    n = new Notification({ title: m.title || 'Halcyon', body: m.body || '', silent: !!m.silent, icon,
      actions: process.platform === 'darwin' ? actions.map((a) => ({ type: 'button', text: a.title })) : [] });
    n.on('click', () => onClick({ id: m.id, route: m.route, as: m.as }));
    n.on('action', (e, i) => {
      const a = actions[i];
      if (!a) return;
      const url = buttonUrl(a, m);
      if (url.startsWith(`${PROTOCOL}:action?`)) onAction({ ref: m.ref, action: a.id, tag, as: m.as || '' });
      else handleUrl(url, { onClick, onAction });
    });
  }
  n.on('close', () => { if (shown.get(tag) === n) shown.delete(tag); });
  shown.set(tag, n);
  n.show();
}

function close(tag) {
  const n = shown.get(String(tag || '').slice(0, 64));
  if (n) { shown.delete(String(tag).slice(0, 64)); n.close(); }
}

/** A halcyon-desktop: address (from a toast) → what to do; false when it is not one. */
function handleUrl(url, { onClick, onAction, openExternal }) {
  if (/^https:\/\//i.test(url)) { openExternal?.(url); return true; }
  if (!String(url).startsWith(`${PROTOCOL}:`)) return false;
  let u;
  try { u = new URL(url); } catch { return true; }
  const p = Object.fromEntries(u.searchParams);
  if (u.pathname === 'action') { onAction({ ref: p.ref || '', action: p.action || '', tag: p.tag || '', as: p.as || '' }); close(p.tag); } else onClick({ id: Number(p.id) || 0, route: p.route || '', as: p.as || '' });
  return true;
}

module.exports = { PROTOCOL, show, close, handleUrl };
