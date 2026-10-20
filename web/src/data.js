// Shared data loaders kept in the global store.
import { api, setApiSpace } from './api.js';
import { store } from './store.js';

// The chosen space is a per-device choice (a work laptop can stay in "Work").
const SPACE_KEY = 'halcyon.space';
const readSpace = () => { try { return localStorage.getItem(SPACE_KEY) || ''; } catch { return ''; } };
setApiSpace(readSpace());
store.set({ space: readSpace() });

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
  if (tz && me.settings?.calendar?.tzAuto !== false && me.settings?.calendar?.timezone !== tz) saveSettings({ calendar: { timezone: tz } }).catch(() => {});
  return me;
}
export async function loadFolders() { store.set({ folders: await api.get('/api/folders') }); }
export async function loadAccounts() { store.set({ accounts: await api.get('/api/accounts'), accountsLoaded: true }); }
export async function loadLabels() { store.set({ labels: await api.get('/api/labels') }); }
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
