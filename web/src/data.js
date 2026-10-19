// Shared data loaders kept in the global store.
import { api } from './api.js';
import { store } from './store.js';

export async function loadMe() {
  const me = await api.get('/api/me');
  store.set({ user: me.user, settings: me.settings, oauth: me.oauth, singleUser: me.singleUser });
  applyTheme(me.settings);
  return me;
}
export async function loadFolders() { store.set({ folders: await api.get('/api/folders') }); }
export async function loadAccounts() { store.set({ accounts: await api.get('/api/accounts'), accountsLoaded: true }); }
export async function loadLabels() { store.set({ labels: await api.get('/api/labels') }); }
export async function loadProviders() { store.set({ aiProviders: await api.get('/api/ai/providers') }); }

export async function saveSettings(patch) {
  const settings = await api.patch('/api/settings', patch);
  store.set({ settings });
  applyTheme(settings);
  return settings;
}

export function applyTheme(settings) {
  const t = settings?.ui?.theme || 'system';
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.density = settings?.ui?.density || 'comfortable';
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme(store.get().settings));
