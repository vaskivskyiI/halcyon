// Printing mail: a hidden frame in this page, not a new window (the Windows and desktop apps send new windows to the
// browser, and pop-up blockers stop them).
import { api } from '../api.js';
import { addrFull, fmtFull, escapeHtml, toastError } from '../util.js';

const STYLE = `body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:13px;line-height:1.45;color:#000;margin:0;padding:0 4px}
  h2{font-size:17px;margin:0 0 10px} .conv+.conv{break-before:page} .msg+.msg{border-top:1px solid #bbb;margin-top:18px;padding-top:12px}
  .h{color:#444;font-size:12px;margin-bottom:10px} img{max-width:100%;height:auto} img[data-remote-src]{display:none} table{max-width:100%}
  pre{white-space:pre-wrap;font-family:inherit} blockquote{margin:0 0 0 6px;padding-left:10px;border-left:2px solid #bbb;color:#444}
  .att{color:#444;font-size:12px;margin-top:8px}`;

const one = (m) => `<div class="msg"><div class="h"><b>${escapeHtml(addrFull(m.from))}</b><br>To: ${escapeHtml((m.to || []).map(addrFull).join(', '))}${m.cc?.length ? `<br>Cc: ${escapeHtml(m.cc.map(addrFull).join(', '))}` : ''}<br>${fmtFull(m.date)}</div>
  ${m.html || `<pre>${escapeHtml(m.text || '')}</pre>`}${(m.attachments || []).filter((a) => !a.inline).length ? `<div class="att">Attachments: ${escapeHtml(m.attachments.filter((a) => !a.inline).map((a) => a.filename).join(', '))}</div>` : ''}</div>`;

/** Prints conversations: each a list of full messages (with bodies), each conversation on its own page. */
export function printConversations(convs) {
  convs = convs.filter((c) => c.length);
  if (!convs.length) return;
  const f = document.createElement('iframe');
  f.setAttribute('aria-hidden', 'true');
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(f);
  const d = f.contentDocument;
  d.open();
  d.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(convs[0][0].subject || 'Mail')}</title><style>${STYLE}</style></head><body>${
    convs.map((c) => `<div class="conv"><h2>${escapeHtml(c[0].subject || '(no subject)')}</h2>${c.map(one).join('')}</div>`).join('')}</body></html>`);
  d.close();
  const w = f.contentWindow;
  w.addEventListener('afterprint', () => setTimeout(() => f.remove(), 100));
  setTimeout(() => f.isConnected && f.remove(), 10 * 60e3);
  // Images first (those that load), then the print dialog.
  const go = () => { w.focus(); w.print(); };
  if (d.readyState === 'complete') setTimeout(go, 250); else w.addEventListener('load', () => setTimeout(go, 100));
}

/** Prints messages of the list: in conversation view each one's whole conversation (copies merged as shown). */
export async function printMail(items, threaded) {
  try {
    const seen = new Set();
    const convs = await Promise.all(items.filter((m) => {
      const k = threaded && m.threadId ? `t${m.threadId}` : `m${m.id}`;
      return !seen.has(k) && seen.add(k);
    }).map(async (m) => (threaded && m.threadId
      ? (await api.get(`/api/threads/${encodeURIComponent(m.threadId)}`)).messages.filter((x) => !x.isDraft || x.id === m.id)
      : [await api.get(`/api/messages/${m.id}`)])));
    printConversations(convs);
  } catch (e) { toastError(e); }
}
