import { Agent, fetch as undiciFetch } from 'undici';
import { get, run, now } from './db/index.js';
import { encrypt, decrypt } from './util/crypto.js';
import { tlsOf } from './mail/connection.js';

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
  const r = get("SELECT base_url, token_enc, tls_ca, tls_insecure, updated_at FROM integrations WHERE user_id = ? AND kind = 'inkwell'", userId);
  return r?.base_url ? { url: r.base_url, token: r.token_enc ? decrypt(r.token_enc) : null, tls_ca: r.tls_ca, tls_insecure: r.tls_insecure, updatedAt: r.updated_at } : null;
}

/** What the API shows: never the token itself. */
export function inkwellPublic(userId) {
  const c = inkwellConfig(userId);
  return { url: c?.url || '', hasToken: !!c?.token, configured: !!(c?.url && c?.token), tls: { ca: c?.tls_ca || '', insecure: !!c?.tls_insecure } };
}

/** Saves the address and (when given) a new token; an empty address disconnects. */
export function saveInkwell(userId, { url, token, clearToken, tls } = {}) {
  if (!String(url || '').trim()) { run("DELETE FROM integrations WHERE user_id = ? AND kind = 'inkwell'", userId); return inkwellPublic(userId); }
  const base = cleanBase(url);
  const t = String(token || '').trim();
  if (t && !/^ink_[\w-]+$/.test(t)) throw new Error('An Inkwell token starts with ink_ (Inkwell → Settings → Apps & tokens)');
  const old = get("SELECT token_enc, tls_ca, tls_insecure FROM integrations WHERE user_id = ? AND kind = 'inkwell'", userId);
  const ca = tls?.ca === undefined ? old?.tls_ca ?? null : String(tls.ca).trim() || null;
  if (ca && !/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(ca)) throw new Error('Paste the certificate authority as PEM (-----BEGIN CERTIFICATE----- …)');
  const insecure = tls?.insecure === undefined ? old?.tls_insecure ?? 0 : tls.insecure ? 1 : 0;
  run("INSERT OR REPLACE INTO integrations (user_id, kind, base_url, token_enc, tls_ca, tls_insecure, updated_at) VALUES (?, 'inkwell', ?, ?, ?, ?, ?)",
    userId, base, t ? encrypt(t) : clearToken ? null : old?.token_enc ?? null, ca, insecure, now());
  agents.clear();
  return inkwellPublic(userId);
}

// Inkwell with its own certificate settings is asked through an agent that uses them.
const agents = new Map();
function inkFetch(c) {
  const t = tlsOf(c);
  if (t.rejectUnauthorized && !t.ca) return fetch;
  const key = `${t.rejectUnauthorized}|${c.tls_ca || ''}`;
  if (!agents.has(key)) agents.set(key, new Agent({ connect: t }));
  const dispatcher = agents.get(key);
  return (url, init = {}) => undiciFetch(url, { ...init, dispatcher });
}
const CERT = /self.signed|unable to verify|unable to get local issuer|certificate|CERT_|leaf signature/i;
/** Why Inkwell could not be asked, in words the user can act on. */
export function inkwellError(e) {
  if (e.name === 'TimeoutError') return 'Inkwell did not answer';
  const m = `${e.cause?.code || ''} ${e.cause?.message || ''} ${e.message}`;
  if (CERT.test(m)) return `Inkwell's certificate is not trusted (${(e.cause?.code || e.cause?.message || e.message).trim()}) — add its certificate authority below, or choose not to check it`;
  return e.cause?.code ? `Cannot reach Inkwell: ${e.cause.code}` : e.message;
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
  const r = await inkFetch(c)(`${c.url}/api/links/lookup?kind=${kind}&ref=${ids.join(',')}`, {
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
