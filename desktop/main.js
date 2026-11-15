// Halcyon desktop shell. Runs the Halcyon server locally (single-user, loopback only, secret token)
// or connects to a remote Halcyon server (keeping a copy on this PC for offline reading, offline.js). Provides tray,
// native notifications, unread badge, mailto: handling, start-at-login, downloads and dragging attachments out.
const { app, BrowserWindow, Tray, Menu, shell, ipcMain, nativeImage, session, dialog } = require('electron');
const { fork, execFile } = require('node:child_process');
const { setupOffline } = require('./offline.js');
const notify = require('./notify.js');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const APP_ID = 'com.halcyon.mail';
const fetching = new Map(); // attachment URL → when its download was asked for
const openAfter = new Set(); // previews (?inline=1): downloaded to a temporary folder and opened in their app
const configPath = () => path.join(app.getPath('userData'), 'config.json');
const defaults = { mode: 'local', serverUrl: '', closeToTray: true, bounds: null, offline: true, offlineMB: 2048 };
const loadConfig = () => { try { return { ...defaults, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) }; } catch { return { ...defaults }; } };
const saveConfig = (c) => { fs.mkdirSync(path.dirname(configPath()), { recursive: true }); fs.writeFileSync(configPath(), JSON.stringify(c, null, 2)); };

let config, win, tray, serverProc, baseUrl, offline, quitting = false, pendingMailto = null;
const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
const iconPath = path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.setAppUserModelId(APP_ID); // required for Windows toast notifications
// mailto: links, and the app's own protocol: a toast click or button starts it (notify.js).
for (const scheme of ['mailto', notify.PROTOCOL]) {
  if (process.defaultApp) app.setAsDefaultProtocolClient(scheme, process.execPath, [path.resolve(process.argv[1])]);
  else app.setAsDefaultProtocolClient(scheme);
}

// Foundry Local (on-device models on the NPU of Copilot+ PCs) listens on a dynamic port; ask its CLI.
function foundryUrl() {
  if (process.platform !== 'win32') return Promise.resolve('');
  return new Promise((resolve) => execFile('foundry', ['service', 'status'], { timeout: 4000, windowsHide: true }, (err, out) => {
    resolve((!err && String(out).match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+/)?.[0]) || '');
  }));
}

// Server mode: fail fast with a useful message instead of a blank window.
async function checkServer(url) {
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    throw new Error(`Cannot reach the Halcyon server at ${url} (${e.cause?.code || e.message}). Check the network/VPN, or switch to "This PC" mode.`);
  }
}

function startLocalServer(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const token = crypto.randomBytes(24).toString('base64url');
    const serverEntry = app.isPackaged ? path.join(resources, 'server', 'src', 'index.js') : path.join(resources, 'server', 'src', 'index.js');
    const webDir = app.isPackaged ? path.join(resources, 'web') : path.join(resources, 'web', 'dist');
    serverProc = fork(serverEntry, [], {
      execPath: process.execPath,
      env: {
        ...process.env, ELECTRON_RUN_AS_NODE: '1', HALCYON_START: '1', HALCYON_SINGLE_USER: '1', HALCYON_DESKTOP_TOKEN: token,
        ...extraEnv, HALCYON_HOST: '127.0.0.1', HALCYON_PORT: '0', HALCYON_DATA_DIR: path.join(app.getPath('userData'), 'data'), HALCYON_WEB_DIR: webDir,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const logFile = fs.createWriteStream(path.join(app.getPath('userData'), 'server.log'), { flags: 'a' });
    serverProc.stdout.pipe(logFile); serverProc.stderr.pipe(logFile);
    const timer = setTimeout(() => reject(new Error('Local server did not start in time')), 60e3);
    serverProc.on('message', (m) => { if (m?.type === 'ready') { clearTimeout(timer); resolve({ url: `http://127.0.0.1:${m.port}`, token }); } });
    serverProc.on('exit', (code) => { if (!quitting) { clearTimeout(timer); reject(new Error(`Local server exited (code ${code}). See server.log in ${app.getPath('userData')}`)); } });
  });
}

function createWindow() {
  const b = config.bounds || { width: 1400, height: 900 };
  win = new BrowserWindow({
    ...b, minWidth: 380, minHeight: 500, show: false, title: 'Halcyon', icon: iconPath, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, spellcheck: true },
  });
  win.once('ready-to-show', () => win.show());
  const saveBounds = () => { if (!win.isMinimized() && !win.isMaximized()) { config.bounds = win.getBounds(); saveConfig(config); } };
  win.on('resized', saveBounds); win.on('moved', saveBounds);
  win.on('close', (e) => { if (!quitting && config.closeToTray && tray) { e.preventDefault(); win.hide(); } });
  win.on('page-title-updated', (e, title) => { e.preventDefault(); win.setTitle(title); tray?.setToolTip(title); });

  // External links open in the default browser; same-origin links (attachments) download.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (baseUrl && url.startsWith(baseUrl)) {
      if (/\/api\/oauth\//.test(url)) return { action: 'allow' }; // OAuth popup must keep its opener
      // Once per file while it downloads: a double click does not save two copies. A preview opens in the default app
      // for its type (as in the Windows app); the Download button asks where to save.
      const file = url.replace('inline=1', 'inline=0');
      if (Date.now() - (fetching.get(file) || 0) < 120e3) return { action: 'deny' };
      fetching.set(file, Date.now());
      if (url.includes('inline=1')) openAfter.add(file);
      win.webContents.downloadURL(file);
      return { action: 'deny' };
    }
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(baseUrl)) { e.preventDefault(); shell.openExternal(url); } });
  return win;
}

function connectWindow(error) {
  const w = new BrowserWindow({ width: 540, height: 560, resizable: false, title: 'Halcyon — Connection', icon: iconPath, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true } });
  w.loadFile(path.join(__dirname, 'connect.html'), { query: { mode: config.mode, url: config.serverUrl, offline: config.offline ? '1' : '0', error: error || '' } });
  return w;
}

function buildTray() {
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }));
  const menu = () => Menu.buildFromTemplate([
    { label: 'Open Halcyon', click: () => { win?.show(); win?.focus(); } },
    { label: 'New message', click: () => openRoute('#/compose') },
    { label: 'Calendar', click: () => openRoute('#/calendar') },
    { type: 'separator' },
    { label: 'Start at login', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked, args: ['--hidden'] }) },
    { label: 'Keep running in tray when closed', type: 'checkbox', checked: config.closeToTray, click: (i) => { config.closeToTray = i.checked; saveConfig(config); } },
    { label: 'Connection…', click: () => connectWindow() },
    { label: 'Open data folder', click: () => shell.openPath(app.getPath('userData')) },
    offline && { label: 'Clear the offline copy on this PC', click: () => { offline.clear(); dialog.showMessageBox({ message: 'The offline copy was removed. It fills again as you use Halcyon.' }); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ].filter(Boolean));
  tray.setContextMenu(menu());
  tray.setToolTip('Halcyon');
  tray.on('click', () => { if (win?.isVisible()) win.focus(); else win?.show(); });
}

function appMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [
      { label: 'New message', accelerator: 'CmdOrCtrl+N', click: () => openRoute('#/compose') },
      { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => openRoute('#/settings') },
      { label: 'Connection…', click: () => connectWindow() },
      { type: 'separator' }, { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit(); } },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { label: 'Mail', accelerator: 'CmdOrCtrl+1', click: () => openRoute('#/mail') },
      { label: 'Calendar', accelerator: 'CmdOrCtrl+2', click: () => openRoute('#/calendar') },
      { label: 'Contacts', accelerator: 'CmdOrCtrl+3', click: () => openRoute('#/contacts') },
      { label: 'Tasks', accelerator: 'CmdOrCtrl+4', click: () => openRoute('#/tasks') },
      { label: 'Assistant', accelerator: 'CmdOrCtrl+5', click: () => openRoute('#/assistant') },
      { type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' },
    ] },
    { role: 'windowMenu' },
    { label: 'Help', submenu: [{ label: 'Open logs folder', click: () => shell.openPath(app.getPath('userData')) }] },
  ]));
}

function openRoute(hash) {
  if (!win) return;
  win.show(); win.focus();
  win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => {});
}

function handleMailto(url) {
  if (!url?.startsWith('mailto:')) return;
  if (win && baseUrl) openRoute(`#/compose?url=${encodeURIComponent(url)}`);
  else pendingMailto = url;
}

ipcMain.on('badge', (e, { count, dataUrl }) => {
  if (process.platform === 'win32' && win) win.setOverlayIcon(count ? nativeImage.createFromDataURL(dataUrl) : null, count ? `${count} unread` : '');
  else app.setBadgeCount(count || 0);
});
ipcMain.handle('connect:save', async (e, { mode, serverUrl, offline: keep }) => {
  config.mode = mode; config.serverUrl = String(serverUrl || '').replace(/\/$/, '');
  if (keep !== undefined) config.offline = !!keep;
  saveConfig(config);
  app.relaunch(); quitting = true; app.exit(0);
});
// Attachments dragged out of the window: fetched into a temporary file while the mouse is down, then dragged as a
// real file (Explorer saves a copy where it is dropped). Only files of this Halcyon server.
const dragDir = () => path.join(app.getPath('temp'), 'halcyon-drag');
const prepared = new Map();
function prepareDrag(url, name) {
  if (!baseUrl || !String(url).startsWith(`${baseUrl}/api/messages/`)) return null;
  if (!prepared.has(url)) {
    const dir = path.join(dragDir(), crypto.createHash('sha1').update(url).digest('hex').slice(0, 12));
    const file = path.join(dir, path.basename(String(name || 'attachment')).replace(/[\\/:*?"<>|]+/g, '_') || 'attachment');
    prepared.set(url, session.defaultSession.fetch(url, { credentials: 'include' })
      .then(async (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, Buffer.from(await r.arrayBuffer())); return file; })
      .catch(() => { prepared.delete(url); return null; }));
  }
  return prepared.get(url);
}
ipcMain.on('drag:prepare', (e, { url, name }) => { prepareDrag(url, name); });
ipcMain.on('drag:start', async (e, { url, name }) => {
  const file = await prepareDrag(url, name);
  if (file) e.sender.startDrag({ file, icon: nativeImage.createFromPath(iconPath).resize({ width: 32, height: 32 }) });
});
// A mail file to import into an archive, read where it is by the local server.
ipcMain.handle('pick:file', async (e, { title, filters } = {}) => {
  const r = await dialog.showOpenDialog(win, { title: title || 'Choose a file', properties: ['openFile'], filters });
  return r.canceled ? null : r.filePaths[0];
});
// Notifications (notify.js): a click shows the window and lets the page open the place (it knows the shared space);
// a button is done by the page in the background, the window stays where it is.
const notifyHandlers = {
  onClick: (m) => { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); win.webContents.send('notification', { type: 'click', ...m }); },
  onAction: (m) => win?.webContents.send('notification', { type: 'action', ...m }),
  openExternal: (url) => shell.openExternal(url),
};
ipcMain.on('notify', (e, m) => { if (e.sender === win?.webContents) notify.show(m || {}, notifyHandlers); });
ipcMain.on('notify:close', (e, tag) => notify.close(tag));
ipcMain.on('show', () => { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); });
ipcMain.handle('app:info', () => ({ version: app.getVersion(), mode: config.mode, serverUrl: config.serverUrl }));

app.on('second-instance', (e, argv) => {
  const mailto = argv.find((a) => a.startsWith('mailto:'));
  if (mailto) handleMailto(mailto);
  const toast = argv.find((a) => a.startsWith(`${notify.PROTOCOL}:`));
  if (toast && notify.handleUrl(toast, notifyHandlers)) return;
  if (win) { win.show(); win.focus(); }
});
app.on('open-url', (e, url) => { e.preventDefault(); handleMailto(url); });

app.whenReady().then(async () => {
  config = loadConfig();
  pendingMailto = process.argv.find((a) => a.startsWith('mailto:')) || null;
  appMenu();
  try {
    // Exactly one place does the AI work: in server mode no local server (no sync, no background AI) is started,
    // so mail is never analysed twice for the same account.
    if (config.mode === 'remote') {
      if (!config.serverUrl) throw new Error('No server URL configured');
      if (config.offline) {
        offline = setupOffline({ serverUrl: config.serverUrl, dir: path.join(app.getPath('userData'), 'offline'), maxBytes: (Number(config.offlineMB) || 2048) * 1048576,
          onState: (on) => tray?.setToolTip(on === false ? 'Halcyon — offline (showing the copy on this PC)' : 'Halcyon') });
      }
      // Server not reachable: with a copy on this PC the app opens from it (read-only) instead of stopping.
      await checkServer(config.serverUrl).catch((e) => { if (!offline?.hasApp()) throw e; });
      baseUrl = config.serverUrl;
    } else {
      const foundry = await foundryUrl();
      const { url, token } = await startLocalServer(foundry ? { HALCYON_FOUNDRY_URL: foundry } : {});
      baseUrl = url;
      await session.defaultSession.cookies.set({ url, name: 'halcyon_desktop', value: token, httpOnly: true, sameSite: 'strict' });
    }
  } catch (err) {
    connectWindow(err.message);
    return;
  }
  createWindow();
  buildTray();
  await win.loadURL(baseUrl + (pendingMailto ? `/#/compose?url=${encodeURIComponent(pendingMailto)}` : ''));
  if (process.argv.includes('--hidden')) win.hide();
  // Started by a click on a toast left in the notification centre: open its place.
  const toast = process.argv.find((a) => a.startsWith(`${notify.PROTOCOL}:`));
  if (toast) notify.handleUrl(toast, notifyHandlers);
  // Desktop session downloads: ask where to save.
  session.defaultSession.on('will-download', (e, item) => {
    const url = item.getURL();
    if (openAfter.delete(url)) {
      const dir = path.join(app.getPath('temp'), 'halcyon-open', crypto.randomBytes(4).toString('hex'));
      fs.mkdirSync(dir, { recursive: true });
      item.setSavePath(path.join(dir, item.getFilename()));
      item.once('done', (ev, state) => { fetching.delete(url); if (state === 'completed') shell.openPath(item.getSavePath()); });
      return;
    }
    item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
    item.once('done', () => fetching.delete(url));
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin' && (quitting || !tray)) app.quit(); });
app.on('before-quit', () => { quitting = true; serverProc?.kill(); fs.rm(dragDir(), { recursive: true, force: true }, () => {}); });
process.on('uncaughtException', (e) => dialog.showErrorBox('Halcyon error', e.stack || String(e)));
