import { store } from './store.js';

export function toast(message, opts = {}) {
  const id = Math.random().toString(36).slice(2);
  store.set((s) => ({ toasts: [...s.toasts, { id, message, ...opts }] }));
  if (!opts.sticky) setTimeout(() => dismissToast(id), opts.duration || (opts.action ? 8000 : 4000));
  return id;
}
export const dismissToast = (id) => store.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
export const toastError = (e) => toast(e?.message || String(e), { kind: 'error' });

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function fmtListDate(ms) {
  const d = new Date(ms), now = new Date();
  if (sameDay(d, now)) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (sameDay(d, y)) return 'Yesterday';
  if (now - d < 6 * 864e5) return d.toLocaleDateString([], { weekday: 'short' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  return d.toLocaleDateString();
}
export const fmtFull = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

export function initials(name = '') {
  const p = name.replace(/[<>"@].*$/, '').trim().split(/\s+/).filter(Boolean);
  return ((p[0]?.[0] || '?') + (p[1]?.[0] || '')).toUpperCase();
}
export function colorFor(s = '') {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 48%)`;
}

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const textToHtml = (t) => String(t || '').split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
export const htmlToText = (h) => { const d = document.createElement('div'); d.innerHTML = h; return d.innerText; };

export const addrLabel = (a) => (a?.name ? a.name : a?.address || '');
export const addrFull = (a) => (a?.name ? `${a.name} <${a.address}>` : a?.address || '');

export function navigate(hash) { if (location.hash !== hash) location.hash = hash; }

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
export function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
export function startOfWeek(d, weekStart = 1) { const x = startOfDay(d); const diff = (x.getDay() - weekStart + 7) % 7; return addDays(x, -diff); }
export const toLocalInput = (ms) => { const d = new Date(ms); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
export const toDateInput = (ms) => toLocalInput(ms).slice(0, 10);

export function notifyDesktop(title, body, onClick, { silent = false, tag } = {}) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const n = new Notification(title, { body, icon: './icon-192.png', silent, tag });
  n.onclick = () => { window.focus(); onClick?.(); n.close(); };
}

export const CATEGORY_COLORS = {
  personal: '#ec4899', work: '#2563eb', finance: '#16a34a', shopping: '#f59e0b', travel: '#06b6d4', newsletter: '#8b5cf6', promotion: '#a855f7',
  social: '#0ea5e9', notification: '#64748b', security: '#dc2626', calendar: '#14b8a6', support: '#f97316', other: '#6b7280',
};
