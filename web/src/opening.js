// An attachment opens once per click: a double click, or clicking again while it is still being fetched (nothing
// seemed to happen — the desktop apps open it only once downloaded), does not open more copies. A note says it is
// on its way.
import { toast } from './util.js';

const HOLD = 6000;
const recent = new Map(); // url → when it was last opened

const ATTACHMENT = /\/api\/(messages\/\d+\/attachments\/|uploads\/)/;

/** true when this URL may be opened now (and a note is shown), false when it was opened a moment ago. */
export function claimOpen(url, name) {
  const t = Date.now();
  if (t - (recent.get(url) || 0) < HOLD) return false;
  recent.set(url, t);
  for (const [k, at] of recent) if (t - at > HOLD) recent.delete(k);
  toast(`Opening ${name || 'the attachment'}…`, { duration: 3000 });
  return true;
}

/** window.open for a file of the server, once. */
export function openFile(url, name) { if (claimOpen(url, name)) window.open(url, '_blank'); }

/** Links to attachments anywhere in the app (reader, chips, composer) go through claimOpen; a button inside such a
 *  link (Download) handles its own click. */
export function installOpenGuard() {
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href]');
    if (!a || !ATTACHMENT.test(a.getAttribute('href') || '')) return;
    const own = e.target.closest('.icon-btn, button');
    if (own && a.contains(own)) return;
    if (!claimOpen(a.href, a.dataset.name)) { e.preventDefault(); e.stopPropagation(); }
  }, true);
}
