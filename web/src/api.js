// REST client, NDJSON streaming for AI responses, and the real-time event socket.
const base = (window.HALCYON_SERVER || '').replace(/\/$/, '');

// The active space (e.g. "Work") travels with every request; the server scopes lists, search and the assistant by it.
let activeSpace = '';
export const setApiSpace = (s) => { activeSpace = s || ''; };
// The device's time zone travels too: the server reads times in mail ("tomorrow at 8") in the user's zone.
const deviceTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } })();
const spaceHeader = () => ({ ...(activeSpace ? { 'x-halcyon-space': encodeURIComponent(activeSpace) } : {}), ...(deviceTz ? { 'x-halcyon-tz': encodeURIComponent(deviceTz) } : {}) });

export class ApiError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

async function request(method, url, body) {
  const r = await fetch(base + url, {
    method, credentials: 'include', cache: 'no-store',
    headers: { ...spaceHeader(), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await r.json() : await r.text();
  if (!r.ok) {
    if (r.status === 401 && !url.startsWith('/api/auth')) window.dispatchEvent(new Event('halcyon:unauthorized'));
    throw new ApiError(data?.error || r.statusText, r.status, data?.code);
  }
  // Mail changed from here: counts in the sidebar refresh even when the event socket is not connected (e.g. behind a proxy).
  if (method !== 'GET' && /^\/api\/(messages|folders|send|outbox|drafts|ai\/approvals)/.test(url)) window.dispatchEvent(new CustomEvent('halcyon:mutated', { detail: { url } }));
  return data;
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, b = {}) => request('POST', u, b),
  patch: (u, b = {}) => request('PATCH', u, b),
  put: (u, b = {}) => request('PUT', u, b),
  del: (u) => request('DELETE', u),
  url: (u) => base + u,
};

/** Streams an NDJSON AI endpoint. onToken receives text deltas; resolves with the final result. */
export async function stream(url, body, { onToken, onStatus, signal } = {}) {
  const r = await fetch(base + url, { method: 'POST', credentials: 'include', headers: { ...spaceHeader(), 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).error; } catch { /* ignore */ }
    throw new ApiError(msg, r.status);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.t) onToken?.(m.t);
      if (m.s) onStatus?.(m.s);
      if (m.error) throw new ApiError(m.error, 500, m.code);
      if (m.done) return m.result;
    }
  }
  throw new ApiError('Stream ended unexpectedly', 500);
}

// ---- real-time events
const listeners = new Set();
let ws, retry = 1000, closedByUser = false;

export function connectEvents() {
  closedByUser = false;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const target = base ? base.replace(/^http/, 'ws') : `${proto}://${location.host}`;
  ws = new WebSocket(`${target}/api/ws`);
  ws.onmessage = (e) => { const msg = JSON.parse(e.data); listeners.forEach((fn) => fn(msg)); };
  ws.onopen = () => { retry = 1000; listeners.forEach((fn) => fn({ type: 'connected' })); };
  ws.onclose = () => {
    listeners.forEach((fn) => fn({ type: 'disconnected' }));
    if (!closedByUser) setTimeout(connectEvents, retry = Math.min(retry * 2, 30000));
  };
}
export function disconnectEvents() { closedByUser = true; ws?.close(); }
export function onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }
