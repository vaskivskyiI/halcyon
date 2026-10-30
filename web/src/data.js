// Shared data loaders kept in the global store.
import { api, setApiSpace, setApiActing, setMergedSpaces } from './api.js';
import { store } from './store.js';

// The chosen space is a per-device choice (a work laptop can stay in "Work").
const SPACE_KEY = 'halcyon.space';
const readSpace = () => { try { return localStorage.getItem(SPACE_KEY) || ''; } catch { return ''; } };
setApiSpace(readSpace());
store.set({ space: readSpace() });

/** Shared spaces the user belongs to (with unread counts), for the space switcher and Settings → Sharing. */
export async function loadShared() {
  const shared = await api.get('/api/shared').catch(() => []);
  store.set({ shared });
  return shared;
}

/** Whether this shared space's mail is shown with one's own. */
export const inMyMail = (settings, id) => !!settings?.ui?.showShared && !(settings.ui.hiddenShared || []).includes(Number(id));

/** One shared space shown with one's own mail, or not: saved, then everything is loaded again. */
export async function setSharedShown(id, on) {
  const { settings, shared } = store.get();
  const hidden = settings.ui.showShared ? settings.ui.hiddenShared || [] : shared.map((s) => s.id);
  await saveSettings({ ui: { showShared: true, hiddenShared: on ? hidden.filter((x) => x !== id) : [...new Set([...hidden, id])] } });
  location.reload();
}

/** Which shared spaces' events and mail count as one's own right now. */
export function applyMergedSpaces() {
  const { settings, acting, shared } = store.get();
  setMergedSpaces(acting ? [] : (shared || []).filter((x) => inMyMail(settings, x.id)).map((x) => x.id));
}

/** Work in a shared space (id) or in one's own mail (null). The whole app reloads: every list, cache and setting
 *  belongs to the mail being worked in. */
export async function enterShared(id) {
  await api.post(id ? `/api/shared/${id}/enter` : '/api/shared/leave');
  setApiActing(id);
  location.hash = '#/mail/unified';
  location.reload();
}

export async function loadSpaces() {
  const spaces = (await api.get('/api/spaces')).spaces;
  store.set({ spaces });
  if (store.get().space && !spaces.includes(store.get().space)) setSpace('');
  return spaces;
}
export function setSpace(space) {
  try { if (space) localStorage.setItem(SPACE_KEY, space); else localStorage.removeItem(SPACE_KEY); } catch { /* private mode */ }
  setApiSpace(space);
  store.set({ space });
  loadFolders();
}

export async function loadMe() {
  const me = await api.get('/api/me');
  store.set({ user: me.user, settings: me.settings, oauth: me.oauth, singleUser: me.singleUser, serverTimezone: me.serverTimezone });
  applyTheme(me.settings);
  // Times the AI reads from mail are local times; the server needs this device's zone, not its own (often UTC).
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz && !store.get().readOnly && me.settings?.calendar?.tzAuto !== false && me.settings?.calendar?.timezone !== tz) saveSettings({ calendar: { timezone: tz } }).catch(() => {});
  return me;
}
// Folder counts are asked for by many events (sync, new mail, AI results, own actions): one request at a time, and at
// most one every 2 seconds; calls in between are merged into one that follows.
let foldersBusy = null, foldersAgain = false, foldersLast = 0;
export async function loadFolders() {
  if (foldersBusy) { foldersAgain = true; return foldersBusy; }
  foldersBusy = (async () => {
    const wait = foldersLast + 2000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try { foldersLast = Date.now(); store.set({ folders: await api.get('/api/folders') }); } finally {
      foldersBusy = null;
      if (foldersAgain) { foldersAgain = false; loadFolders().catch(() => {}); }
    }
  })();
  return foldersBusy;
}
export async function loadAccounts() { store.set({ accounts: await api.get('/api/accounts'), accountsLoaded: true }); }
export async function loadLabels() { store.set({ labels: await api.get('/api/labels') }); }
// Inkwell's address when it is connected (Settings → Integrations): the rail's "Notes" opens it.
export async function loadInkwell() { const r = await api.get('/api/integrations/inkwell').catch(() => null); store.set({ inkwell: r?.configured ? r.url : null }); }
export async function loadProviders() { store.set({ aiProviders: await api.get('/api/ai/providers') }); }

// Applied at once (a switch flips immediately), then saved; put back if the server refuses.
const merge = (base, over) => (over && typeof over === 'object' && !Array.isArray(over) && base && typeof base === 'object'
  ? Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(over)])].map((k) => [k, k in over ? merge(base[k], over[k]) : base[k]]))
  : over);
export async function saveSettings(patch) {
  const before = store.get().settings;
  if (before) { store.set({ settings: merge(before, patch) }); applyTheme(store.get().settings); }
  try {
    const settings = await api.patch('/api/settings', patch);
    store.set({ settings });
    applyTheme(settings);
    return settings;
  } catch (e) {
    if (before) { store.set({ settings: before }); applyTheme(before); }
    throw e;
  }
}

export function applyTheme(settings) {
  const t = settings?.ui?.theme || 'system';
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.density = settings?.ui?.density || 'comfortable';
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme(store.get().settings));
