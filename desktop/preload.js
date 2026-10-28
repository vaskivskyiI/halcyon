// Minimal, safe bridge exposed to the web app (contextIsolation on, sandboxed).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('halcyonDesktop', {
  isDesktop: true,
  platform: process.platform,
  setBadge: (count, dataUrl) => ipcRenderer.send('badge', { count, dataUrl }),
  saveConnection: (mode, serverUrl, offline) => ipcRenderer.invoke('connect:save', { mode, serverUrl, offline }),
  info: () => ipcRenderer.invoke('app:info'),
  // A notification was clicked: bring the window back (also from the tray).
  show: () => ipcRenderer.send('show'),
  // Attachments dragged into Explorer: fetched while the mouse is down, then dragged as a file.
  prepareDrag: (url, name) => ipcRenderer.send('drag:prepare', { url, name }),
  dragFile: (url, name) => ipcRenderer.send('drag:start', { url, name }),
  // A file on this PC (to import into an archive, read where it is by the local server).
  pickFile: (opts) => ipcRenderer.invoke('pick:file', opts),
});
