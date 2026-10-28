import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, RefreshCw, Send, FileText, X, CloudUpload, Settings, Trash2, EyeOff } from 'lucide-react';
import { api, onEvent } from '../api.js';
import { store } from '../store.js';
import { toast, toastError, navigate } from '../util.js';
import { Spinner } from './common.jsx';

// Mail server / sending problems, never silent: a red indicator in the rail with a panel that offers what can be done
// (retry, save for later as a draft, reconnect). New problems also show a toast once.
const ACTIONS = {
  reauth: {
    label: 'Sign in again', icon: RefreshCw,
    run: (p) => { window.open(api.url(`/api/oauth/${p.provider}/start?accountId=${p.accountId}`), 'oauth', 'width=520,height=680'); },
  },
  reconnect: { label: 'Reconnect', icon: RefreshCw, run: (p) => api.post(`/api/accounts/${p.accountId}/sync`).then(() => 'Reconnecting…') },
  test: { label: 'Check settings', icon: Settings, run: () => { navigate('#/settings/accounts'); store.set({ problemsOpen: false }); } },
  'retry-op': { label: 'Retry', icon: RefreshCw, run: (p) => api.post(`/api/accounts/${p.accountId}/ops/${p.opId}/retry`).then(() => 'Retrying…') },
  'dismiss-op': {
    label: 'Dismiss', icon: Trash2,
    run: (p) => confirm('Forget this change? It will not be applied on the server. Nothing is deleted.') && api.del(`/api/accounts/${p.accountId}/ops/${p.opId}`),
  },
  'retry-send': { label: 'Send again', icon: Send, run: (p) => api.post(`/api/outbox/${p.outboxId}/retry`).then(() => 'Sending…') },
  'to-draft': { label: 'Save as draft', icon: FileText, run: (p) => api.post(`/api/outbox/${p.outboxId}/to-draft`).then(() => 'Saved in Outbox & drafts — nothing was sent') },
  'refresh-calendar': { label: 'Try again', icon: RefreshCw, run: (p) => api.post(`/api/calendars/${p.calendarId}/refresh`).then(() => 'Calendar refreshed') },
  'refresh-source': { label: 'Try again', icon: RefreshCw, run: (p) => api.post(`/api/calendar-sources/${p.sourceId}/refresh`).then(() => 'Calendars refreshed') },
  'retry-dav': {
    label: 'Try again', icon: RefreshCw,
    run: (p) => api.post(`/api/accounts/${p.accountId}/sync?dav=1`).then((r) => { if (r.dav?.error) throw new Error(r.dav.error); return davFound(r.dav); }),
  },
  'save-unsaved': { label: 'Save on server', icon: CloudUpload, run: () => api.post('/api/messages/save-to-server', { all: true }).then((r) => `Saving ${r.queued} message${r.queued === 1 ? '' : 's'} on the server…`) },
};

/** "2 calendars and 1 address book synced". */
export const davFound = (d) => [d?.calendars != null && `${d.calendars} calendar${d.calendars === 1 ? '' : 's'}`, d?.books != null && `${d.books} address book${d.books === 1 ? '' : 's'}`].filter(Boolean).join(' and ') + ' synced';

export default function Problems() {
  const [problems, setProblems] = useState([]);
  const [hidden, setHidden] = useState(0);
  const [busy, setBusy] = useState(null);
  const open = store.use((s) => s.problemsOpen);
  const known = useRef(null);
  const timer = useRef();

  const load = () => api.get('/api/status/problems').then((r) => {
    setProblems(r.problems);
    setHidden(r.hidden || 0);
    // Nothing (left) to show: the panel goes away by itself — no "all is well" message to close.
    if (!r.problems.length) store.set({ problemsOpen: false });
    // Announce problems that appeared while the app is open (not the ones already there when it loaded).
    if (known.current) {
      for (const p of r.problems) {
        if (p.level === 'error' && !known.current.has(p.key)) toast(p.title, { kind: 'error', duration: 12000, action: { label: 'Show', onClick: () => store.set({ problemsOpen: true }) } });
      }
    }
    known.current = new Set(r.problems.map((p) => p.key));
  }).catch(() => {});
  // At most one check every 5 seconds, however many events arrive (a sync sends many).
  const last = useRef(0);
  const soon = (ms = 800) => { if (timer.current) return; timer.current = setTimeout(() => { timer.current = null; last.current = Date.now(); load(); }, Math.max(ms, last.current + 5000 - Date.now())); };

  useEffect(() => {
    load();
    const t = setInterval(load, 30e3);
    const off = onEvent((e) => {
      if (['outbox:changed', 'mail:sent', 'mail:changed'].includes(e.type) || (e.type === 'sync:state' && ['idle', 'error'].includes(e.payload?.state))) soon(1500);
      // Sending failed: show what can be done right away.
      if (e.type === 'mail:sendError') { clearTimeout(timer.current); timer.current = null; load(); store.set({ problemsOpen: true }); }
    });
    const mutated = () => soon(2500);
    window.addEventListener('halcyon:mutated', mutated);
    return () => { clearInterval(t); off(); window.removeEventListener('halcyon:mutated', mutated); };
  }, []);

  const act = async (p, name) => {
    setBusy(`${p.key}:${name}`);
    try { const msg = await ACTIONS[name].run(p); if (typeof msg === 'string') toast(msg); } catch (e) { toastError(e); } finally { setBusy(null); soon(1500); }
  };

  // Put problems aside (all, or one): hidden until they change or come back; nothing is retried, dropped or deleted.
  const dismiss = (keys) => api.post('/api/status/problems/dismiss', keys ? { keys } : {}).then(load).catch(toastError);
  const restore = () => api.post('/api/status/problems/dismiss', { restore: true }).then(load).catch(toastError);

  const errors = problems.filter((p) => p.level === 'error').length;
  if (!problems.length) return null;
  return <>
    {problems.length > 0 && (
      <button className={`problems-btn ${errors ? 'error' : 'warn'}`} title={`${problems.length} problem${problems.length > 1 ? 's' : ''} with mail servers or sending`} aria-label="Problems" onClick={() => store.set({ problemsOpen: !open })}>
        <AlertTriangle size={19} /><span className="badge">{problems.length}</span>
      </button>
    )}
    {open && (
      <div className="problems-panel" role="dialog" aria-label="Problems">
        <div className="row"><b className="grow">Mail servers and sending</b>
          {problems.length > 1 && <button className="btn sm" title="Hide all these problems until they change or happen again — nothing is retried or deleted" onClick={() => dismiss()}><EyeOff size={13} /> Dismiss all</button>}
          <button className="icon-btn" onClick={() => store.set({ problemsOpen: false })} aria-label="Close"><X size={16} /></button></div>
        {problems.map((p) => (
          <div key={p.key} className={`problem ${p.level}`}>
            <div className="row" style={{ alignItems: 'flex-start' }}><div className="t grow">{p.title}</div>
              <button className="icon-btn" title="Dismiss — hide until it changes or happens again" aria-label="Dismiss" onClick={() => dismiss([p.key])}><X size={13} /></button></div>
            {p.text && <div className="small muted">{p.text}</div>}
            {p.actions?.length > 0 && <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
              {p.actions.map((a) => { const A = ACTIONS[a]; return A && (
                <button key={a} className="btn sm" disabled={!!busy} onClick={() => act(p, a)}>{busy === `${p.key}:${a}` ? <Spinner size={12} /> : <A.icon size={13} />} {A.label}</button>
              ); })}
            </div>}
          </div>
        ))}
        {hidden > 0 && <button className="btn ghost sm" onClick={restore}>Show {hidden} dismissed</button>}
      </div>
    )}
  </>;
}
