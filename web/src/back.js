// "Back" after following a link inside the app — a suggested email, a topic, a tag, a related message, a task's
// email: where it came from is remembered so Back returns there. Browsing the list (clicks, j/k) is not recorded,
// so Back does not walk through every message looked at.
import { createElement } from 'react';
import { ArrowLeft } from 'lucide-react';
import { store } from './store.js';
import { navigate } from './util.js';

export function pushBack(hash = location.hash) {
  if (!hash) return;
  const s = (store.get().backStack || []).filter((h) => h !== hash);
  store.set({ backStack: [...s.slice(-19), hash] });
}

/** Navigation that counts as following a link (Back returns to where it started). */
export function jump(hash) { if (hash !== location.hash) { pushBack(); navigate(hash); } }

export function goBack() {
  const s = [...(store.get().backStack || [])];
  const h = s.pop();
  store.set({ backStack: s });
  if (h) navigate(h);
}

document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href^="#/"]');
  if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
  if (a.getAttribute('href') !== location.hash) pushBack();
}, true);

/** The Back button (only when there is somewhere to go back to). */
export function BackButton({ className = 'btn ghost', compact = false }) {
  const stack = store.use((s) => s.backStack) || [];
  if (!stack.length) return null;
  return createElement('button', { className, title: 'Back to where you were (Alt+←)', onClick: goBack }, createElement(ArrowLeft, { size: 16 }), compact ? null : ' Back');
}

window.addEventListener('keydown', (e) => {
  if (e.altKey && e.key === 'ArrowLeft' && (store.get().backStack || []).length) { e.preventDefault(); goBack(); }
});
