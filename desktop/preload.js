// Minimal, safe bridge exposed to the web app (contextIsolation on, sandboxed).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('halcyonDesktop', {
  isDesktop: true,
  platform: process.platform,
  setBadge: (count, dataUrl) => ipcRenderer.send('badge', { count, dataUrl }),
  saveConnection: (mode, serverUrl, offline) => ipcRenderer.invoke('connect:save', { mode, serverUrl, offline }),
  // The Connection window's certificate choices (main.js answers only that window).
  trust: { inspect: (url) => ipcRenderer.invoke('trust:inspect', url), pin: (url, fp) => ipcRenderer.invoke('trust:pin', url, fp),
    addCa: () => ipcRenderer.invoke('trust:addCa'), list: () => ipcRenderer.invoke('trust:list'), clear: () => ipcRenderer.invoke('trust:clear') },
  info: () => ipcRenderer.invoke('app:info'),
  // The Connection window (this PC / a server), also from the page's profile menu.
  openConnection: () => ipcRenderer.send('connect:open'),
  // A notification was clicked: bring the window back (also from the tray).
  show: () => ipcRenderer.send('show'),
  // Rich notifications (desktop/notify.js): toasts with an icon per kind and buttons. cb gets { type: 'click', id,
  // route, as } or { type: 'action', ref, action, tag, as }.
  notify: (m) => ipcRenderer.send('notify', m),
  closeNotification: (tag) => ipcRenderer.send('notify:close', String(tag || '')),
  onNotification: (cb) => { ipcRenderer.on('notification', (e, m) => cb(m)); },
  // Attachments dragged into Explorer: fetched while the mouse is down, then dragged as a file.
  prepareDrag: (url, name) => ipcRenderer.send('drag:prepare', { url, name }),
  dragFile: (url, name) => ipcRenderer.send('drag:start', { url, name }),
  // A file on this PC (to import into an archive, read where it is by the local server).
  pickFile: (opts) => ipcRenderer.invoke('pick:file', opts),
});
