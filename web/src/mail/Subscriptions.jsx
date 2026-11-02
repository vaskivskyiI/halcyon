// Mail → Subscriptions: every newsletter and mailing list that sends here (mail with a List-Unsubscribe header), one row
// per sender with its latest subjects, and one click to unsubscribe — alone, with its inbox mail archived, or for several
// selected at once. Unsubscribed lists stay listed, so a list that keeps sending shows up.
import { useEffect, useState } from 'react';
import { Menu as MenuIcon, Archive, BellOff, Search, ChevronRight, ChevronDown, MailOpen } from 'lucide-react';
import { api } from '../api.js';
import { Spinner } from '../components/common.jsx';
import { fmtListDate, navigate, toast, toastError } from '../util.js';

const PERIODS = [[30, '30 days'], [90, '3 months'], [365, 'a year']];
const FILTERS = [['active', 'Subscribed'], ['all', 'All'], ['unsubscribed', 'Unsubscribed']];

export default function SubscriptionsList({ onMenu }) {
  const [days, setDays] = useState(90);
  const [filter, setFilter] = useState('active');
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState({});
  const [picked, setPicked] = useState(new Set());
  const [busy, setBusy] = useState({});
  const load = () => api.get(`/api/subscriptions?days=${days}`).then(setRows).catch(toastError);
  useEffect(() => { setRows(null); setPicked(new Set()); load(); }, [days]);
  const mark = (address, key, on) => setBusy((b) => ({ ...b, [address + key]: on }));
  const unsubscribeOne = async (r) => {
    const x = await api.post(`/api/messages/${r.unsubscribeId}/unsubscribe`);
    if (x.method === 'browser') window.open(x.url, '_blank', 'noopener');
    return x;
  };
  const unsubscribe = async (r, archive) => {
    mark(r.address, 'unsub', true);
    try {
      const x = await unsubscribeOne(r);
      let archived = 0;
      if (archive && r.inbox) archived = (await api.post('/api/senders/action', { address: r.address, action: 'archive' })).count;
      toast([x.method === 'browser' ? 'Unsubscribe page opened' : x.method === 'mailto' ? 'Unsubscribe email sent' : 'Unsubscribed',
        archived && `${archived} archived`].filter(Boolean).join(' · '));
      load();
    } catch (e) { toastError(e); } finally { mark(r.address, 'unsub', false); }
  };
  const archive = async (r) => {
    mark(r.address, 'archive', true);
    try { toast(`${(await api.post('/api/senders/action', { address: r.address, action: 'archive' })).count} archived`); load(); } catch (e) { toastError(e); } finally { mark(r.address, 'archive', false); }
  };
  const unsubscribePicked = async () => {
    const list = rows.filter((r) => picked.has(r.address));
    let done = 0, pages = 0;
    for (const r of list) {
      mark(r.address, 'unsub', true);
      try { const x = await unsubscribeOne(r); if (x.method === 'browser') pages++; else done++; } catch (e) { toastError(e); } finally { mark(r.address, 'unsub', false); }
    }
    toast([done && `Unsubscribed from ${done}`, pages && `${pages} unsubscribe page${pages > 1 ? 's' : ''} opened`].filter(Boolean).join(' · ') || 'Nothing done');
    setPicked(new Set());
    load();
  };
  // Their unread mail marked read: one subscription, or several at once (the selected ones, else all shown).
  const markRead = async (list) => {
    list.forEach((r) => mark(r.address, 'read', true));
    try {
      const x = await api.post('/api/senders/action', { addresses: list.map((r) => r.address), action: 'read' });
      toast(x.count ? `${x.count} marked read` : 'Nothing unread');
      load();
    } catch (e) { toastError(e); } finally { list.forEach((r) => mark(r.address, 'read', false)); }
  };
  const toggle = (address) => setPicked((s) => { const n = new Set(s); n.has(address) ? n.delete(address) : n.add(address); return n; });
  const shown = (rows || []).filter((r) => filter === 'all' || (filter === 'unsubscribed' ? r.unsubscribedAt : !r.unsubscribedAt));
  const pickable = shown.filter((r) => !r.unsubscribedAt);
  const allPicked = pickable.length > 0 && pickable.every((r) => picked.has(r.address));
  const unread = (r) => r.total - (r.seen || 0);
  const readTargets = (picked.size ? shown.filter((r) => picked.has(r.address)) : shown).filter((r) => unread(r) > 0);
  return (
    <section className="list-pane senders" style={{ flex: 1, width: 'auto' }}>
      <div className="list-head" style={{ paddingBottom: 10 }}>
        <div className="row"><button className="icon-btn mobile-only" onClick={onMenu}><MenuIcon size={18} /></button><h3 style={{ margin: 0, fontSize: 17 }} className="grow">Subscriptions</h3>
          <select className="input" style={{ width: 'auto', height: 30 }} value={days} onChange={(e) => setDays(Number(e.target.value))}>{PERIODS.map(([d, l]) => <option key={d} value={d}>Last {l}</option>)}</select></div>
        <div className="row small" style={{ marginTop: 8, gap: 8, flexWrap: 'wrap' }}>
          <span className="muted grow">Newsletters and mailing lists that send to you. Unsubscribe in one click; lists that keep sending after you unsubscribed are marked.</span>
          {FILTERS.map(([k, l]) => <button key={k} className={`chip clickable ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{l}{rows ? ` ${(rows || []).filter((r) => k === 'all' || (k === 'unsubscribed' ? r.unsubscribedAt : !r.unsubscribedAt)).length}` : ''}</button>)}
        </div>
        {(pickable.length > 0 || readTargets.length > 0) && <div className="row small" style={{ marginTop: 8, gap: 10 }}>
          {pickable.length > 0 && <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(pickable.map((r) => r.address)))} /> Select all</label>}
          {picked.size > 0 && <button className="btn sm" onClick={unsubscribePicked}><BellOff size={13} /> Unsubscribe from {picked.size}</button>}
          {readTargets.length > 0 && <button className="btn sm ghost" title={picked.size ? 'Mark the selected subscriptions\' mail read' : 'Mark the mail of every subscription shown read'} onClick={() => markRead(readTargets)}>
            <MailOpen size={13} /> {picked.size ? 'Mark selected read' : 'Mark all read'}</button>}
        </div>}
      </div>
      <div className="list-scroll" style={{ overflow: 'auto', flex: 1 }}>
        {!rows ? <div style={{ padding: 20 }}><Spinner /></div> : !shown.length ? <div className="empty" style={{ padding: 20 }}>No subscriptions here.</div> : shown.map((r) => (
          <div key={r.address} className="sender-row subscription-row">
            {!r.unsubscribedAt ? <input type="checkbox" checked={picked.has(r.address)} onChange={() => toggle(r.address)} title="Select" /> : <span style={{ width: 13 }} />}
            <div className="grow" style={{ minWidth: 0 }}>
              <button className="link-btn row truncate" style={{ gap: 4, fontWeight: 600, color: 'inherit', textDecoration: 'none', maxWidth: '100%' }} onClick={() => setOpen((o) => ({ ...o, [r.address]: !o[r.address] }))}>
                {open[r.address] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}{r.name || r.address} {r.name && <span className="faint small" style={{ fontWeight: 400 }}>{r.address}</span>}
              </button>
              <div className="small muted">{r.total} emails · {r.readRate}% read{r.inbox ? ` · ${r.inbox} in the inbox` : ''} · last {fmtListDate(r.last)}
                {r.unsubscribedAt ? <> · <span className="chip">unsubscribed {fmtListDate(r.unsubscribedAt)}</span>{r.since > 0 && <span style={{ color: 'var(--danger)' }}> · {r.since} sent since</span>}</> : null}</div>
              {open[r.address] && <div className="small" style={{ marginTop: 6 }}>{r.recent.map((m) => (
                <div key={m.id} className="row" style={{ gap: 8, padding: '2px 0' }}>
                  <a className="truncate grow" style={{ fontWeight: m.isRead ? 400 : 600 }} href={`#/mail/unified/${m.id}`}>{m.subject || '(no subject)'}</a>
                  <span className="faint">{fmtListDate(m.date)}</span>
                </div>))}</div>}
            </div>
            <div className="row" style={{ gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <button className="icon-btn" title="Show all their mail" onClick={() => { navigate('#/mail/unified'); setTimeout(() => window.dispatchEvent(new CustomEvent('halcyon:search', { detail: { q: `from:${r.address}` } })), 150); }}><Search size={15} /></button>
              {unread(r) > 0 && <button className="icon-btn" disabled={busy[`${r.address}read`]} title={`Mark ${unread(r)} unread read`} onClick={() => markRead([r])}><MailOpen size={15} /></button>}
              {(!r.unsubscribedAt || r.since > 0) && <button className="btn sm" disabled={busy[`${r.address}unsub`]} title="Unsubscribe from this list" onClick={() => unsubscribe(r, false)}><BellOff size={13} /> {r.unsubscribedAt ? 'Again' : 'Unsubscribe'}</button>}
              {!r.unsubscribedAt && r.inbox > 0 && <button className="btn sm ghost" disabled={busy[`${r.address}unsub`]} title={`Unsubscribe and archive the ${r.inbox} in the inbox`} onClick={() => unsubscribe(r, true)}>+ <Archive size={13} /></button>}
              {r.unsubscribedAt && r.inbox > 0 && <button className="btn sm" disabled={busy[`${r.address}archive`]} title="Archive everything from them in the inbox" onClick={() => archive(r)}><Archive size={13} /> Archive {r.inbox}</button>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
