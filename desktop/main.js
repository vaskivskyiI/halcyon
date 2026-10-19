// Halcyon desktop shell. Runs the Halcyon server locally (single-user, loopback only, secret token)
// or connects to a remote Halcyon server. Provides tray, native notifications, unread badge,
// mailto: handling, start-at-login and downloads.
const { app, BrowserWindow, Tray, Menu, shell, ipcMain, nativeImage, session, dialog } = require('electron');
const { fork } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const APP_ID = 'com.halcyon.mail';
const configPath = () => path.join(app.getPath('userData'), 'config.json');
const defaults = { mode: 'local', serverUrl: '', closeToTray: true, bounds: null };
const loadConfig = () => { try { return { ...defaults, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) }; } catch { return { ...defaults }; } };
const saveConfig = (c) => { fs.mkdirSync(path.dirname(configPath()), { recursive: true }); fs.writeFileSync(configPath(), JSON.stringify(c, null, 2)); };

let config, win, tray, serverProc, baseUrl, quitting = false, pendingMailto = null;
const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
const iconPath = path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.setAppUserModelId(APP_ID); // required for Windows toast notifications
if (process.defaultApp) app.setAsDefaultProtocolClient('mailto', process.execPath, [path.resolve(process.argv[1])]);
else app.setAsDefaultProtocolClient('mailto');

function startLocalServer() {
  return new Promise((resolve, reject) => {
    const token = crypto.randomBytes(24).toString('base64url');
    const serverEntry = app.isPackaged ? path.join(resources, 'server', 'src', 'index.js') : path.join(resources, 'server', 'src', 'index.js');
    const webDir = app.isPackaged ? path.join(resources, 'web') : path.join(resources, 'web', 'dist');
    serverProc = fork(serverEntry, [], {
      execPath: process.execPath,
      env: {
        ...process.env, ELECTRON_RUN_AS_NODE: '1', HALCYON_START: '1', HALCYON_SINGLE_USER: '1', HALCYON_DESKTOP_TOKEN: token,
        HALCYON_HOST: '127.0.0.1', HALCYON_PORT: '0', HALCYON_DATA_DIR: path.join(app.getPath('userData'), 'data'), HALCYON_WEB_DIR: webDir,
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
      win.webContents.downloadURL(url.replace('inline=1', 'inline=0'));
      return { action: 'deny' };
    }
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(baseUrl)) { e.preventDefault(); shell.openExternal(url); } });
  return win;
}

function connectWindow(error) {
  const w = new BrowserWindow({ width: 520, height: 470, resizable: false, title: 'Halcyon — Connection', icon: iconPath, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true } });
  w.loadFile(path.join(__dirname, 'connect.html'), { query: { mode: config.mode, url: config.serverUrl, error: error || '' } });
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
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]);
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
ipcMain.handle('connect:save', async (e, { mode, serverUrl }) => {
  config.mode = mode; config.serverUrl = String(serverUrl || '').replace(/\/$/, '');
  saveConfig(config);
  app.relaunch(); quitting = true; app.exit(0);
});
ipcMain.handle('app:info', () => ({ version: app.getVersion(), mode: config.mode, serverUrl: config.serverUrl }));

app.on('second-instance', (e, argv) => {
  const mailto = argv.find((a) => a.startsWith('mailto:'));
  if (mailto) handleMailto(mailto);
  if (win) { win.show(); win.focus(); }
});
app.on('open-url', (e, url) => { e.preventDefault(); handleMailto(url); });

app.whenReady().then(async () => {
  config = loadConfig();
  pendingMailto = process.argv.find((a) => a.startsWith('mailto:')) || null;
  appMenu();
  try {
    if (config.mode === 'remote') {
      if (!config.serverUrl) throw new Error('No server URL configured');
      baseUrl = config.serverUrl;
    } else {
      const { url, token } = await startLocalServer();
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
  // Desktop session downloads: ask where to save.
  session.defaultSession.on('will-download', (e, item) => item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), item.getFilename()) }));
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin' && (quitting || !tray)) app.quit(); });
app.on('before-quit', () => { quitting = true; serverProc?.kill(); });
process.on('uncaughtException', (e) => dialog.showErrorBox('Halcyon error', e.stack || String(e)));
