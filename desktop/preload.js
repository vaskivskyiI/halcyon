// Minimal, safe bridge exposed to the web app (contextIsolation on, sandboxed).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('halcyonDesktop', {
  isDesktop: true,
  platform: process.platform,
  setBadge: (count, dataUrl) => ipcRenderer.send('badge', { count, dataUrl }),
  saveConnection: (mode, serverUrl) => ipcRenderer.invoke('connect:save', { mode, serverUrl }),
  info: () => ipcRenderer.invoke('app:info'),
  // A notification was clicked: bring the window back (also from the tray).
  show: () => ipcRenderer.send('show'),
});
