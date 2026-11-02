// The sync button: starts a sync, and shows what is running — mail per account, AI work, archive jobs.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { RefreshCw, Mail, Sparkles, Archive, X } from 'lucide-react';
import { api, onEvent } from '../api.js';
import { store } from '../store.js';
import { Spinner } from './common.jsx';
import { useDismiss } from '../dismiss.js';

const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`; };
const secs = (ms) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

function Row({ icon: Icon, busy, title, note }) {
  return <div className="activity-row">{busy ? <Spinner size={14} /> : <Icon size={14} />}<span className="grow"><span className="truncate">{title}</span>{note && <span className="small faint truncate">{note}</span>}</span></div>;
}

export function Activity({ syncing, onSync }) {
  const connected = store.use((s) => s.connected);
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const btn = useRef(), panel = useRef();
  useDismiss([btn, panel], () => setOpen(false), open, { ignore: '.menu, .modal-back, .toasts' });
  useEffect(() => {
    let timer = null, live = true;
    const load = () => api.get('/api/activity').then((d) => { if (live) setData(d); }).catch(() => {});
    if (open) { load(); timer = setInterval(load, 1500); }
    // Closed: asked only now and then, for the dot on the button.
    else { load(); timer = setInterval(load, 20e3); }
    const off = onEvent((e) => { if (e.type === 'sync:state') load(); });
    return () => { live = false; clearInterval(timer); off(); };
  }, [open]);
  const running = (data?.mail || []).filter((a) => a.doing || a.state === 'syncing');
  const busy = syncing || running.length > 0 || (data?.ai.running.length || 0) + (data?.archives.length || 0) > 0;
  const queued = (data?.ai.queued || []).reduce((n, q) => n + q.n, 0);
  return <>
    <button ref={btn} title={connected ? 'Sync and activity' : 'Live updates are not connected (refreshing every 30 s). If this persists, the reverse proxy probably does not pass WebSockets for /api/ws.'} aria-label="Sync and activity" onClick={() => setOpen(!open)} className={connected ? '' : 'offline'}>
      {syncing ? <Spinner size={18} /> : <RefreshCw size={19} />}{!connected && <span className="offline-dot" />}{!connected ? null : busy && !syncing && <span className="activity-dot" />}</button>
    {open && createPortal(<div ref={panel} className="activity-panel" role="dialog" aria-label="Activity">
      <div className="activity-head"><b className="grow">Activity</b><button className="btn sm primary" disabled={syncing} onClick={onSync}>{syncing ? <Spinner size={13} /> : <RefreshCw size={13} />} Sync now</button>
        <button className="icon-btn" aria-label="Close" onClick={() => setOpen(false)}><X size={15} /></button></div>
      {!data ? <div className="empty"><Spinner size={18} /></div> : <>
        <h4>Mail</h4>
        {data.mail.map((a) => <Row key={a.id} icon={Mail} busy={!!a.doing} title={a.email} note={a.doing
          ? `${a.doing.phase}${a.doing.folder ? ` · ${a.doing.folder}` : ''}${a.doing.total ? ` · ${a.doing.done} of ${a.doing.total}` : ''}`
          : a.error ? a.error : !a.connected ? 'Connecting…' : a.lastFullAt ? `Up to date · last check ${ago(a.lastFullAt)} ago, ${secs(a.lastFullMs)}${a.lastFolders != null ? `, ${a.lastFolders} folder${a.lastFolders === 1 ? '' : 's'} changed` : ''}` : 'Up to date'} />)}
        {!data.mail.length && <div className="small faint">No mail accounts.</div>}
        <h4>AI</h4>
        {data.ai.running.map((j, i) => <Row key={i} icon={Sparkles} busy title={j.label} note={[j.subject, `${ago(j.since)}`].filter(Boolean).join(' · ')} />)}
        {data.ai.queued.map((q) => <Row key={q.type} icon={Sparkles} title={`${q.n} waiting: ${q.label.toLowerCase()}`} />)}
        {data.ai.waiting > 0 && <Row icon={Sparkles} title={`${data.ai.waiting} waiting for an AI provider`} />}
        {!data.ai.running.length && !queued && !data.ai.waiting && <div className="small faint">Nothing running.</div>}
        {data.archives.length > 0 && <h4>Archives</h4>}
        {data.archives.map((j, i) => <Row key={i} icon={Archive} busy={j.status === 'running'} title={`${{ import: 'Import', move: 'Moving mail', merge: 'Merging' }[j.type] || j.type} · ${j.name}`} note={[j.file, j.total ? `${j.done} of ${j.total}` : j.done ? `${j.done} done` : ''].filter(Boolean).join(' · ')} />)}
      </>}
    </div>, document.body)}
  </>;
}
