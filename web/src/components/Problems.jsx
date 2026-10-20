import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, RefreshCw, Send, FileText, X, CloudUpload, Settings, Trash2 } from 'lucide-react';
import { api, onEvent } from '../api.js';
import { store } from '../store.js';
import { toast, toastError, navigate } from '../util.js';
import { Spinner } from './common.jsx';

// Mail server / sending problems, never silent: a red indicator in the rail with a panel that offers what can be done
// (retry, save for later as a draft, reconnect). New problems also show a toast once.
const ACTIONS = {
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
  'save-unsaved': { label: 'Save on server', icon: CloudUpload, run: () => api.post('/api/messages/save-to-server', { all: true }).then((r) => `Saving ${r.queued} message${r.queued === 1 ? '' : 's'} on the server…`) },
};

export default function Problems() {
  const [problems, setProblems] = useState([]);
  const [busy, setBusy] = useState(null);
  const open = store.use((s) => s.problemsOpen);
  const known = useRef(null);
  const timer = useRef();

  const load = () => api.get('/api/status/problems').then((r) => {
    setProblems(r.problems);
    // Announce problems that appeared while the app is open (not the ones already there when it loaded).
    if (known.current) {
      for (const p of r.problems) {
        if (p.level === 'error' && !known.current.has(p.key)) toast(p.title, { kind: 'error', duration: 12000, action: { label: 'Show', onClick: () => store.set({ problemsOpen: true }) } });
      }
    }
    known.current = new Set(r.problems.map((p) => p.key));
  }).catch(() => {});
  const soon = (ms = 800) => { clearTimeout(timer.current); timer.current = setTimeout(load, ms); };

  useEffect(() => {
    load();
    const t = setInterval(load, 30e3);
    const off = onEvent((e) => {
      if (['sync:state', 'outbox:changed', 'mail:sent', 'folder:synced', 'mail:changed'].includes(e.type)) soon(1500);
      // Sending failed: show what can be done right away.
      if (e.type === 'mail:sendError') { soon(300); store.set({ problemsOpen: true }); }
    });
    const mutated = () => soon(2500);
    window.addEventListener('halcyon:mutated', mutated);
    return () => { clearInterval(t); off(); window.removeEventListener('halcyon:mutated', mutated); };
  }, []);

  const act = async (p, name) => {
    setBusy(`${p.key}:${name}`);
    try { const msg = await ACTIONS[name].run(p); if (typeof msg === 'string') toast(msg); } catch (e) { toastError(e); } finally { setBusy(null); soon(1500); }
  };

  const errors = problems.filter((p) => p.level === 'error').length;
  if (!problems.length && !open) return null;
  return <>
    {problems.length > 0 && (
      <button className={`problems-btn ${errors ? 'error' : 'warn'}`} title={`${problems.length} problem${problems.length > 1 ? 's' : ''} with mail servers or sending`} aria-label="Problems" onClick={() => store.set({ problemsOpen: !open })}>
        <AlertTriangle size={19} /><span className="badge">{problems.length}</span>
      </button>
    )}
    {open && (
      <div className="problems-panel" role="dialog" aria-label="Problems">
        <div className="row"><b className="grow">Mail servers and sending</b><button className="icon-btn" onClick={() => store.set({ problemsOpen: false })} aria-label="Close"><X size={16} /></button></div>
        {!problems.length && <div className="small muted">Everything works — no problems right now.</div>}
        {problems.map((p) => (
          <div key={p.key} className={`problem ${p.level}`}>
            <div className="t">{p.title}</div>
            {p.text && <div className="small muted">{p.text}</div>}
            {p.actions?.length > 0 && <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
              {p.actions.map((a) => { const A = ACTIONS[a]; return A && (
                <button key={a} className="btn sm" disabled={!!busy} onClick={() => act(p, a)}>{busy === `${p.key}:${a}` ? <Spinner size={12} /> : <A.icon size={13} />} {A.label}</button>
              ); })}
            </div>}
          </div>
        ))}
      </div>
    )}
  </>;
}
