// Server mode with a copy on this PC (like Outlook's offline cache): what the app gets from the Halcyon server — the
// app itself, lists, messages with their AI analysis, conversations, opened attachments — is kept in the user's
// profile, and the emails of lists shown are fetched in the background. When the server cannot be reached (no
// network, VPN down, server restarting) the app shows that copy, read-only: changes need the server.
const { protocol, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Never kept: the live socket, sign-in, push, streams and AI answers, diagnostics.
const SKIP = /^\/api\/(ws|auth\/|oauth|mcp|push\/|diagnostics|ai\/(chat|assist|draft|reply|translate|rewrite|compose|brief\/regenerate|suggest)|events\/\d+\/prep)/;
// Content of one email / conversation does not depend on the space being looked at.
const DETAIL = /^\/api\/(messages\/\d+(\/(recent-with|draft))?|threads\/[^/]+(\/muted)?)$/;
const MAX_ENTRY = 25 << 20;

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

function setupOffline({ serverUrl, dir, maxBytes = 2 * 1024 ** 3, onState = () => {} }) {
  const base = new URL(serverUrl);
  const origin = base.origin;
  const store = path.join(dir, sha1(origin).slice(0, 12));
  fs.mkdirSync(store, { recursive: true });
  const indexFile = path.join(store, 'index.json');
  let index = {};
  try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { /* new */ }
  let total = Object.values(index).reduce((n, e) => n + (e.size || 0), 0);
  let saveTimer = null, online = null;
  const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => fs.writeFile(indexFile, JSON.stringify(index), () => {}), 3000); };
  const setOnline = (v) => { if (v !== online) { online = v; onState(v); } };

  const keyOf = (u, headers) => {
    const as = headers.get('x-halcyon-as') || '';
    return DETAIL.test(u.pathname) ? `${u.pathname}${u.search}|${as}` : `${u.pathname}${u.search}|${as}|${headers.get('x-halcyon-space') || ''}`;
  };
  const put = (key, res, buf) => {
    const file = sha1(key);
    const old = index[key];
    fs.writeFile(path.join(store, file), buf, (err) => {
      if (err) return;
      total += buf.length - (old?.size || 0);
      index[key] = { file, type: res.headers.get('content-type') || '', disp: res.headers.get('content-disposition') || '', status: res.status, at: Date.now(), used: Date.now(), size: buf.length };
      save();
      if (total > maxBytes) prune();
    });
  };
  const prune = () => {
    // Least recently used first, down to 80 % of the limit.
    for (const [k, e] of Object.entries(index).sort((a, b) => a[1].used - b[1].used)) {
      if (total <= maxBytes * 0.8) break;
      fs.rm(path.join(store, e.file), { force: true }, () => {});
      total -= e.size || 0;
      delete index[k];
    }
    save();
  };
  const fromCache = (key) => {
    const e = index[key];
    if (!e) return null;
    try {
      const body = fs.readFileSync(path.join(store, e.file));
      e.used = Date.now(); save();
      return new Response(body, { status: e.status, headers: { 'content-type': e.type, ...(e.disp ? { 'content-disposition': e.disp } : {}), 'x-halcyon-offline': '1', 'x-halcyon-cached-at': String(e.at) } });
    } catch { return null; }
  };
  const clear = () => {
    for (const e of Object.values(index)) fs.rm(path.join(store, e.file), { force: true }, () => {});
    index = {}; total = 0; save();
  };

  // The emails of a list just shown are fetched in the background (two at a time), so they open offline later.
  const queue = [];
  let busy = 0;
  const warm = (paths, as) => {
    for (const p of paths) {
      const key = `${p}|${as || ''}`;
      if (index[key] && Date.now() - index[key].at < 12 * 3600e3) continue;
      if (!queue.some((q) => q.p === p)) queue.push({ p, as });
    }
    pump();
  };
  const pump = () => {
    while (busy < 2 && queue.length && online !== false) {
      const { p, as } = queue.shift();
      busy++;
      net.fetch(origin + p, { headers: as ? { 'x-halcyon-as': String(as) } : {}, credentials: 'include' })
        .then(async (r) => { if (r.ok) put(`${p}|${as || ''}`, r, Buffer.from(await r.arrayBuffer())); })
        .catch(() => {}).finally(() => { busy--; setTimeout(pump, 150); });
    }
  };
  // (Items of a shared space's list carry its id as owner — or, for a list asked for as that space, inherit it.)
  const warmList = (buf, listAs) => {
    try {
      const items = JSON.parse(buf.toString('utf8'))?.items || [];
      for (const m of items.slice(0, 60)) {
        warm([`/api/messages/${m.id}`, m.threadId && `/api/threads/${encodeURIComponent(m.threadId)}`, `/api/messages/${m.id}/recent-with?limit=6`].filter(Boolean), m.owner ?? listAs);
      }
    } catch { /* not a list */ }
  };

  protocol.handle(base.protocol.slice(0, -1), async (req) => {
    const u = new URL(req.url);
    if (u.origin !== origin) return net.fetch(req, { bypassCustomProtocolHandlers: true });
    const cacheable = req.method === 'GET' && !SKIP.test(u.pathname) && !/[?&](wait|refresh)=1/.test(u.search);
    const key = cacheable && keyOf(u, req.headers);
    try {
      const res = await net.fetch(req, { bypassCustomProtocolHandlers: true });
      // A server restarting (or its proxy without it) answers 502-504: the copy serves as if offline.
      if (res.status >= 502 && res.status <= 504 && cacheable && index[key]) throw new Error(`server ${res.status}`);
      setOnline(true);
      if (u.pathname === '/api/auth/logout' && res.ok) clear(); // signing out leaves nothing on this PC
      const type = res.headers.get('content-type') || '';
      if (!cacheable || res.status !== 200 || /ndjson|event-stream/.test(type)) return res;
      const len = Number(res.headers.get('content-length') || 0);
      if (len > MAX_ENTRY) return res;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length <= MAX_ENTRY) {
        put(key, res, buf);
        if (u.pathname === '/api/messages' && !u.searchParams.has('q')) warmList(buf, req.headers.get('x-halcyon-as') || null);
      }
      // (The body is already decoded: no encoding / length headers of the original.)
      const headers = new Headers(res.headers);
      ['content-encoding', 'content-length', 'transfer-encoding'].forEach((h) => headers.delete(h));
      return new Response(buf, { status: res.status, statusText: res.statusText, headers });
    } catch (e) {
      setOnline(false);
      const hit = cacheable && (fromCache(key) || (u.pathname === '/' || !u.pathname.startsWith('/api/') ? fromCache(`/|${req.headers.get('x-halcyon-as') || ''}|`) : null));
      if (hit) return hit;
      return new Response(JSON.stringify({ error: 'Offline — Halcyon cannot reach your server. What you opened before is still readable on this PC; changes need the connection.', offline: true }),
        { status: 503, headers: { 'content-type': 'application/json', 'x-halcyon-offline': '1' } });
    }
  });

  return {
    hasApp: () => !!index['/||'],
    clear,
    size: () => total,
    // Back online: keep filling the copy.
    retry: () => { setOnline(null); pump(); },
  };
}

module.exports = { setupOffline };
