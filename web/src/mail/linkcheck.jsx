// Where a link really goes, shown when the pointer rests on it (in the email's frame too), and the server's verdict
// (mail/links.js: plain rules, then the AI once per email): a suspicious link is marked, and opening it asks first.
import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { api } from '../api.js';
import { store } from '../store.js';

const HAS_LINK = /https?:\/\//i;
const key = (u) => { try { return new URL(u).href; } catch { return u; } };
export const verdictOf = (checks, url) => checks?.get(key(url)) || null;

/** The verdicts on a shown message's links: Map url → { suspicious, reason, flags } (empty until known); null while asked. */
export function useLinkChecks(m, shown) {
  const [checks, setChecks] = useState(new Map());
  const [busy, setBusy] = useState(false);
  const has = shown && !m.partial && HAS_LINK.test(m.html || m.text || '');
  useEffect(() => {
    if (!has) return undefined;
    let live = true;
    setBusy(true);
    api.get(`/api/messages/${m.id}/links`).then((r) => { if (live) setChecks(new Map(r.links.map((l) => [key(l.url), l]))); })
      .catch(() => {}).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [m.id, has]);
  return { checks, busy };
}

/** Pointer on a link: the tip under it. rect: the link's box in this window (frame offset already added). */
export function showTip(url, rect, { checks, busy }) {
  store.set({ linkTip: { url, x: rect.left, y: rect.bottom + 6, top: rect.top, v: checks.get(key(url)) || null, busy } });
}
export const hideTip = () => { if (store.get().linkTip) store.set({ linkTip: null }); };

/** Opening a suspicious link asks first; true when the click was taken over. */
export function guardOpen(e, url, checks) {
  const v = checks.get(key(url));
  if (!v?.suspicious) return false;
  e.preventDefault();
  e.stopPropagation();
  hideTip();
  if (confirm(`This link looks suspicious:\n${v.reason}\n\nIt goes to ${url}\n\nOpen it anyway?`)) window.open(url, '_blank', 'noopener,noreferrer');
  return true;
}

/** Marks the suspicious links in an email's frame. */
export function markLinks(doc, checks) {
  for (const a of doc?.querySelectorAll('a[href]') || []) {
    const v = checks.get(key(a.href));
    a.classList.toggle('hl-suspicious', !!v?.suspicious);
  }
}

/** Hover, click and marks for the links in an email's frame; returns the clean-up. get(): the current checks. */
export function watchFrame(frame, get) {
  const doc = frame?.contentDocument;
  if (!doc) return () => {};
  const link = (e) => e.target?.closest?.('a[href]');
  const over = (e) => {
    const a = link(e);
    if (!a || !/^https?:/i.test(a.href)) return;
    const r = a.getBoundingClientRect(), f = frame.getBoundingClientRect();
    showTip(a.href, { left: f.left + r.left, top: f.top + r.top, bottom: f.top + r.bottom }, get());
  };
  const out = (e) => { if (link(e) && !link({ target: e.relatedTarget })) hideTip(); };
  const click = (e) => { const a = link(e); if (a && /^https?:/i.test(a.href)) guardOpen(e, a.href, get().checks); };
  doc.addEventListener('mouseover', over);
  doc.addEventListener('mouseout', out);
  doc.addEventListener('click', click, true);
  doc.defaultView?.addEventListener('scroll', hideTip);
  return () => { doc.removeEventListener('mouseover', over); doc.removeEventListener('mouseout', out); doc.removeEventListener('click', click, true); };
}

/** The tip itself (one, in the reader). */
export function LinkTip() {
  const t = store.use((s) => s.linkTip);
  useEffect(() => {
    if (!t) return undefined;
    window.addEventListener('scroll', hideTip, true);
    return () => window.removeEventListener('scroll', hideTip, true);
  }, [!!t]);
  if (!t) return null;
  let host = t.url, rest = '';
  try { const u = new URL(t.url); host = u.host; rest = `${u.protocol}//${u.host}`.length < t.url.length ? t.url.slice(`${u.protocol}//${u.host}`.length) : ''; } catch { /* shown as it is */ }
  const left = Math.max(8, Math.min(t.x, window.innerWidth - 440));
  const below = t.y + 90 < window.innerHeight;
  return (
    <div className={`link-tip ${t.v?.suspicious ? 'bad' : ''}`} role="tooltip" style={below ? { left, top: t.y } : { left, bottom: window.innerHeight - t.top + 6 }}>
      <div className="link-tip-url"><b>{host}</b><span className="faint">{rest.length > 160 ? `${rest.slice(0, 160)}…` : rest}</span></div>
      {t.v?.suspicious ? <div className="link-tip-why"><AlertTriangle size={13} /> {t.v.reason}</div>
        : t.v?.flags?.length ? <div className="small faint">{t.v.flags[0]}</div>
        : t.busy ? <div className="small faint">Checking the link…</div> : null}
    </div>
  );
}
