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

// ---- shared mail shown with one's own (setting "Show shared mail in My mail")
// Lists then contain mail of shared spaces, marked with `owner`. Whatever is done with such a message, its
// conversation, its account, folder, draft or outbox entry is sent "as" that space (x-halcyon-as; the server checks
// membership every time). Owners are learned from the responses.
const owners = { msg: new Map(), thread: new Map(), account: new Map(), folder: new Map(), draft: new Map(), outbox: new Map(), event: new Map(), task: new Map(), contact: new Map(), calendar: new Map(), list: new Map(), book: new Map() };
const noteMsg = (m, owner) => { if (!m || m.id == null) return; owners.msg.set(m.id, owner); if (m.threadId) owners.thread.set(m.threadId, owner); };
function learn(method, url, data, sent) {
  if (!data || typeof data !== 'object') return;
  const own = (x) => x?.owner ?? sent ?? null;
  if (Array.isArray(data.items)) data.items.forEach((m) => noteMsg(m, own(m)));
  if (Array.isArray(data.messages)) data.messages.forEach((m) => noteMsg(m, own(m)));
  if (/^\/api\/messages\/\d+(\?|$)/.test(url)) noteMsg(data, sent);
  if (Array.isArray(data.accounts)) data.accounts.forEach((a) => { owners.account.set(a.accountId, own(a)); (Array.isArray(a.folders) ? a.folders : []).forEach((f) => owners.folder.set(f.id, own(a))); });
  if (url.startsWith('/api/accounts') && Array.isArray(data)) data.forEach((a) => owners.account.set(a.id, own(a)));
  if (url.startsWith('/api/drafts') && method === 'POST' && data.id) owners.draft.set(data.id, sent);
  if (url === '/api/send' && data.id) owners.outbox.set(data.id, sent);
  // Calendars, tasks and contacts of a shared space shown with one's own: changes to them go to that space.
  const kind = [[/^\/api\/events(\/\d+)?(\?|\/search|$)/, 'event'], [/^\/api\/tasks(\/\d+|\/from-message\/\d+)?(\?|$)/, 'task'], [/^\/api\/contacts(\/\d+|\/autocomplete)?(\?|$)/, 'contact'],
    [/^\/api\/calendars(\?|$)/, 'calendar'], [/^\/api\/task-lists(\?|$)/, 'list'], [/^\/api\/address-books(\?|$)/, 'book']].find(([re]) => re.test(url))?.[1];
  if (kind) for (const x of Array.isArray(data) ? data : [data]) {
    if (x?.id != null) owners[kind].set(x.id, own(x));
    if (x?.seriesId != null) owners[kind].set(x.seriesId, own(x));
  }
  if (data.related) { (data.related.tasks || []).forEach((t) => owners.task.set(t.id, sent ?? null)); (data.related.events || []).forEach((e) => owners.event.set(e.id, sent ?? null)); }
}
const idOf = (re, url) => { const m = url.match(re); return m ? m[1] : null; };
/** The shared space a request is about (null: one's own mail). */
function ownerFor(url, body) {
  let id;
  if ((id = idOf(/^\/api\/messages\/(\d+)/, url)) || (id = idOf(/^\/api\/tasks\/from-message\/(\d+)/, url)) || (id = idOf(/[?&]inReplyTo=(\d+)/, url))) return owners.msg.get(Number(id)) ?? null;
  if ((id = idOf(/^\/api\/threads\/([^/?]+)/, url))) return owners.thread.get(decodeURIComponent(id)) ?? null;
  if ((id = idOf(/[?&]folderId=(\d+)/, url))) return owners.folder.get(Number(id)) ?? null;
  if ((id = idOf(/^\/api\/drafts\/(\d+)/, url))) return owners.draft.get(Number(id)) ?? null;
  if ((id = idOf(/^\/api\/outbox\/(\d+)/, url))) return owners.outbox.get(Number(id)) ?? null;
  if ((id = idOf(/^\/api\/accounts\/(\d+)/, url))) return owners.account.get(Number(id)) ?? null;
  if ((id = idOf(/^\/api\/events\/(\d+)/, url))) return owners.event.get(Number(id)) ?? null;
  if ((id = idOf(/^\/api\/tasks\/(\d+)/, url))) return owners.task.get(Number(id)) ?? null;
  if ((id = idOf(/^\/api\/contacts\/(\d+)/, url))) return owners.contact.get(Number(id)) ?? null;
  if ((id = idOf(/^\/api\/calendars\/(\d+)/, url))) return owners.calendar.get(Number(id)) ?? null;
  if ((id = idOf(/^\/api\/task-lists\/(\d+)/, url))) return owners.list.get(Number(id)) ?? null;
  if ((id = idOf(/^\/api\/address-books\/(\d+)/, url))) return owners.book.get(Number(id)) ?? null;
  if ((id = idOf(/^\/api\/tasks\?(?:.*&)?listId=(\d+)/, url))) return owners.list.get(Number(id)) ?? null;
  if (body && typeof body === 'object') {
    const first = (Array.isArray(body.ids) ? body.ids[0] : null) ?? (Array.isArray(body.items) ? body.items[0]?.id : null) ?? body.messageId ?? body.inReplyToId;
    if (first != null && owners.msg.has(Number(first))) return owners.msg.get(Number(first));
    if (body.threadId && owners.thread.has(body.threadId)) return owners.thread.get(body.threadId);
    if (body.accountId != null && owners.account.has(Number(body.accountId))) return owners.account.get(Number(body.accountId));
    if (body.id != null && /^\/api\/drafts/.test(url)) return owners.draft.get(Number(body.id)) ?? null;
    if (body.calendarId != null && url.startsWith('/api/events')) return owners.calendar.get(Number(body.calendarId)) ?? null;
    if (body.listId != null && url.startsWith('/api/tasks')) return owners.list.get(Number(body.listId)) ?? null;
    if (body.addressBookId != null && url.startsWith('/api/contacts')) return owners.book.get(Number(body.addressBookId)) ?? null;
  }
  return null;
}
/** Requests about messages of several owners (a selection across spaces) are sent once per owner. */
function splitByOwner(body) {
  if (!body || !Array.isArray(body.ids) || body.ids.length < 2) return null;
  const groups = new Map();
  for (const id of body.ids) { const o = owners.msg.get(Number(id)) ?? null; if (!groups.has(o)) groups.set(o, []); groups.get(o).push(id); }
  return groups.size > 1 ? [...groups].map(([o, ids]) => [o, { ...body, ids }]) : null;
}
const merge = (a, b) => {
  if (!a || typeof a !== 'object') return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = Array.isArray(v) && Array.isArray(a[k]) ? [...a[k], ...v] : typeof v === 'number' && typeof a[k] === 'number' ? a[k] + v : v;
  return out;
};

// Desktop app in server mode, server unreachable: answers come from the copy on this PC (desktop/offline.js), marked
// so; the app says it is offline until a live answer comes again.
let offlineSince = null;
/** Since when what is shown is a saved copy (null: live) — for views that start after it was noticed. */
export const offlineState = () => offlineSince;
function noteOffline(r) {
  const off = r.headers.get('x-halcyon-offline') ? Number(r.headers.get('x-halcyon-cached-at')) || 0 : null;
  if ((off === null) !== (offlineSince === null)) {
    const back = off === null;
    offlineSince = off;
    window.dispatchEvent(new CustomEvent('halcyon:offline', { detail: off }));
    if (back) window.dispatchEvent(new Event('halcyon:refresh')); // connected again: what is shown is refreshed
  }
}

async function request(method, url, body) {
  const parts = method !== 'GET' && splitByOwner(body);
  if (parts) { let out = null; for (const [, b] of parts) out = merge(out, await request(method, url, b)); return out; }
  const as = ownerFor(url, body);
  const r = await fetch(base + url, {
    method, credentials: 'include', cache: 'no-store',
    headers: { ...spaceHeader(), ...(as ? { 'x-halcyon-as': String(as) } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  noteOffline(r);
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await r.json() : await r.text();
  if (!r.ok) {
    if (r.status === 401 && !url.startsWith('/api/auth')) window.dispatchEvent(new Event('halcyon:unauthorized'));
    // A shared space's message opened by link before any list showed it: ask again as that space.
    const id = r.status === 404 && !as && data?.owner && idOf(/^\/api\/messages\/(\d+)$/, url.split('?')[0]);
    if (id) { owners.msg.set(Number(id), data.owner); return request(method, url, body); }
    const contact = r.status === 404 && !as && data?.owner && idOf(/^\/api\/contacts\/(\d+)$/, url);
    if (contact) { owners.contact.set(Number(contact), data.owner); return request(method, url, body); }
    throw new ApiError(data?.error || r.statusText, r.status, data?.code);
  }
  learn(method, url, data, as);
  // Mail changed from here: counts in the sidebar refresh even when the event socket is not connected (e.g. behind a proxy).
  if (method !== 'GET' && /^\/api\/(messages|folders|send|outbox|drafts|ai\/approvals|tasks|events)/.test(url)) window.dispatchEvent(new CustomEvent('halcyon:mutated', { detail: { url } }));
  return data;
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, b = {}) => request('POST', u, b),
  patch: (u, b = {}) => request('PATCH', u, b),
  put: (u, b = {}) => request('PUT', u, b),
  del: (u) => request('DELETE', u),
  // Links the browser loads itself (attachments, downloads): a shared space's message carries it as ?as=.
  url: (u) => { const as = ownerFor(u); return base + u + (as ? `${u.includes('?') ? '&' : '?'}as=${as}` : ''); },
};

/** Streams an NDJSON AI endpoint. onToken receives text deltas; resolves with the final result. */
export async function stream(url, body, { onToken, onStatus, signal } = {}) {
  const as = ownerFor(url, body);
  const r = await fetch(base + url, { method: 'POST', credentials: 'include', headers: { ...spaceHeader(), ...(as ? { 'x-halcyon-as': String(as) } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
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
const otherListeners = new Set();
let ws, retry = 1000, closedByUser = false;
// Events of the mail being worked in (own, or the shared space entered) go to onEvent; events of the other one (a
// shared space, or the own mail while in a shared space) go to onOtherEvent — e.g. to notify about new mail there.
let activeAs = null;
/** Whose a message is: a shared space's id, or null for the person's own. */
export const ownerOf = (msgId) => owners.msg.get(Number(msgId)) ?? null;
export const setApiActing = (id) => { activeAs = id || null; };
let mergedSpaces = new Set();
export const setMergedSpaces = (ids) => { mergedSpaces = new Set(ids || []); };

export function connectEvents() {
  closedByUser = false;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const target = base ? base.replace(/^http/, 'ws') : `${proto}://${location.host}`;
  ws = new WebSocket(`${target}/api/ws`);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if ((msg.as ?? null) === activeAs || (!activeAs && mergedSpaces.has(msg.as)) || ['connected', 'hello', 'shared:changed'].includes(msg.type)) listeners.forEach((fn) => fn(msg));
    else otherListeners.forEach((fn) => fn(msg));
  };
  ws.onopen = () => { retry = 1000; listeners.forEach((fn) => fn({ type: 'connected' })); };
  ws.onclose = () => {
    listeners.forEach((fn) => fn({ type: 'disconnected' }));
    if (!closedByUser) setTimeout(connectEvents, retry = Math.min(retry * 2, 30000));
  };
}
export function disconnectEvents() { closedByUser = true; ws?.close(); }
export function onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function onOtherEvent(fn) { otherListeners.add(fn); return () => otherListeners.delete(fn); }
