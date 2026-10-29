import { get, run, now } from './db/index.js';
import { encrypt, decrypt } from './util/crypto.js';

// Inkwell (the user's own notes app) links its pages to Halcyon mail, events and tasks; Halcyon asks it which pages
// link to what is on screen. Personal: a person's own Inkwell, also while working in a shared space (message, event
// and task ids are unique across the whole database, so the space's items are looked up the same way).
export const INKWELL_KINDS = ['email', 'event', 'task'];
const TIMEOUT_MS = 4000;

const cleanBase = (url) => {
  const u = new URL(String(url || '').trim());
  if (!/^https?:$/.test(u.protocol)) throw new Error('Use an http:// or https:// address');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
};

export function inkwellConfig(userId) {
  const r = get("SELECT base_url, token_enc, updated_at FROM integrations WHERE user_id = ? AND kind = 'inkwell'", userId);
  return r?.base_url ? { url: r.base_url, token: r.token_enc ? decrypt(r.token_enc) : null, updatedAt: r.updated_at } : null;
}

/** What the API shows: never the token itself. */
export function inkwellPublic(userId) {
  const c = inkwellConfig(userId);
  return { url: c?.url || '', hasToken: !!c?.token, configured: !!(c?.url && c?.token) };
}

/** Saves the address and (when given) a new token; an empty address disconnects. */
export function saveInkwell(userId, { url, token, clearToken } = {}) {
  if (!String(url || '').trim()) { run("DELETE FROM integrations WHERE user_id = ? AND kind = 'inkwell'", userId); return inkwellPublic(userId); }
  const base = cleanBase(url);
  const t = String(token || '').trim();
  if (t && !/^ink_[\w-]+$/.test(t)) throw new Error('An Inkwell token starts with ink_ (Inkwell → Settings → Apps & tokens)');
  const old = get("SELECT token_enc FROM integrations WHERE user_id = ? AND kind = 'inkwell'", userId);
  run("INSERT OR REPLACE INTO integrations (user_id, kind, base_url, token_enc, updated_at) VALUES (?, 'inkwell', ?, ?, ?)",
    userId, base, t ? encrypt(t) : clearToken ? null : old?.token_enc ?? null, now());
  return inkwellPublic(userId);
}

// Inkwell builds `url` from its INKWELL_PUBLIC_URL; without it the link is relative — made absolute with the address
// saved here. Only http(s) links reach the page.
function noteUrl(base, item) {
  try {
    const u = new URL(item.url || `#/n/${encodeURIComponent(item.id)}`, `${base}/`);
    if (/^https?:$/.test(u.protocol)) return u.href;
  } catch { /* fall through */ }
  return `${base}/#/n/${encodeURIComponent(item.id)}`;
}

/**
 * Pages linked to Halcyon items of one kind (refs: their ids). Throws when Inkwell cannot be asked; the caller
 * decides how quiet to be about it.
 */
export async function inkwellLookup(userId, kind, refs, { signal } = {}) {
  const c = inkwellConfig(userId);
  if (!c?.url || !c.token) return null;
  if (!INKWELL_KINDS.includes(kind)) throw Object.assign(new Error('Unknown kind'), { statusCode: 400 });
  const ids = [...new Set(refs.map((r) => String(r).trim()).filter((r) => /^\d+$/.test(r)))].slice(0, 100);
  if (!ids.length) return [];
  const r = await fetch(`${c.url}/api/links/lookup?kind=${kind}&ref=${ids.join(',')}`, {
    headers: { authorization: `Bearer ${c.token}`, accept: 'application/json' }, signal: signal || AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'Inkwell did not accept the token' : `Inkwell answered ${r.status}`);
  const data = await r.json();
  if (!Array.isArray(data)) throw new Error('Inkwell sent an unexpected answer');
  return data.filter((x) => x && x.id != null && ids.includes(String(x.ref))).map((x) => ({
    ref: String(x.ref), id: String(x.id), title: String(x.title || '').slice(0, 300), icon: x.icon ? String(x.icon).slice(0, 16) : null,
    kind: x.kind ? String(x.kind) : null, updatedAt: Number(x.updatedAt) || null, snippet: x.snippet ? String(x.snippet).slice(0, 200) : '', url: noteUrl(c.url, x),
  }));
}
