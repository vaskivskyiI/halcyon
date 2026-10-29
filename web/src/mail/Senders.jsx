// Mail → More → Senders: who sends the most, and how much of it is read. Mail never read stands out; one click
// unsubscribes and clears it out of the inbox (archived — nothing is deleted).
import { useEffect, useState } from 'react';
import { Menu as MenuIcon, Archive, MailOpen, BellOff, Search } from 'lucide-react';
import { api } from '../api.js';
import { Spinner } from '../components/common.jsx';
import { fmtListDate, navigate, toast, toastError } from '../util.js';

const PERIODS = [[30, '30 days'], [90, '3 months'], [365, 'a year']];

export default function SendersList({ onMenu }) {
  const [days, setDays] = useState(90);
  const [rows, setRows] = useState(null);
  const [unread, setUnread] = useState(false);
  const [busy, setBusy] = useState({});
  const load = () => api.get(`/api/senders?days=${days}`).then(setRows).catch(toastError);
  useEffect(() => { setRows(null); load(); }, [days]);
  const run = async (r, key, fn) => {
    setBusy((b) => ({ ...b, [r.address + key]: true }));
    try { await fn(); } catch (e) { toastError(e); } finally { setBusy((b) => ({ ...b, [r.address + key]: false })); }
  };
  const act = (r, action) => run(r, action, async () => {
    const x = await api.post('/api/senders/action', { address: r.address, action });
    toast(action === 'archive' ? `${x.count} archived` : `${x.count} marked read`);
    load();
  });
  const unsubscribe = (r) => run(r, 'unsub', async () => {
    const x = await api.post(`/api/messages/${r.unsubscribeId}/unsubscribe`);
    if (x.method === 'browser') window.open(x.url, '_blank', 'noopener');
    else toast(x.method === 'mailto' ? 'Unsubscribe email sent' : 'Unsubscribed');
    setRows((cur) => cur.map((y) => (y.address === r.address ? { ...y, unsubscribed: true } : y)));
  });
  const shown = (rows || []).filter((r) => !unread || r.readRate < 20);
  return (
    <section className="list-pane senders" style={{ flex: 1, width: 'auto' }}>
      <div className="list-head" style={{ paddingBottom: 10 }}>
        <div className="row"><button className="icon-btn mobile-only" onClick={onMenu}><MenuIcon size={18} /></button><h3 style={{ margin: 0, fontSize: 17 }} className="grow">Senders</h3>
          <select className="input" style={{ width: 'auto', height: 30 }} value={days} onChange={(e) => setDays(Number(e.target.value))}>{PERIODS.map(([d, l]) => <option key={d} value={d}>Last {l}</option>)}</select></div>
        <div className="row small" style={{ marginTop: 8, gap: 12, flexWrap: 'wrap' }}>
          <span className="muted grow">Who sends you the most, and how much of it you read. Clear out what you never read: unsubscribe and archive in one go.</span>
          <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={unread} onChange={(e) => setUnread(e.target.checked)} /> Only rarely read</label>
        </div>
      </div>
      <div className="list-scroll" style={{ overflow: 'auto', flex: 1 }}>
        {!rows ? <div style={{ padding: 20 }}><Spinner /></div> : !shown.length ? <div className="empty" style={{ padding: 20 }}>Nobody here.</div> : shown.map((r) => (
          <div key={r.address} className="sender-row">
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="truncate" style={{ fontWeight: 600 }}>{r.name || r.address} {r.name && <span className="faint small" style={{ fontWeight: 400 }}>{r.address}</span>}</div>
              <div className="small muted">{r.total} emails · <span style={{ color: r.readRate < 20 ? 'var(--danger)' : undefined }}>{r.readRate}% read</span>{r.inbox ? ` · ${r.inbox} in the inbox` : ''} · last {fmtListDate(r.last)}{r.category ? ` · ${r.category}` : ''}</div>
              <div className="read-bar"><span style={{ width: `${r.readRate}%` }} /></div>
            </div>
            <div className="row" style={{ gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <button className="icon-btn" title="Show their mail" onClick={() => { navigate('#/mail/unified'); setTimeout(() => window.dispatchEvent(new CustomEvent('halcyon:search', { detail: { q: `from:${r.address}` } })), 150); }}><Search size={15} /></button>
              {r.unsubscribeId && !r.unsubscribed && <button className="btn sm" disabled={busy[`${r.address}unsub`]} title="Unsubscribe from this sender's list" onClick={() => unsubscribe(r)}><BellOff size={13} /> Unsubscribe</button>}
              {r.unsubscribed && <span className="chip">unsubscribed</span>}
              {r.total - Math.round((r.readRate * r.total) / 100) > 0 && <button className="btn sm ghost" disabled={busy[`${r.address}read`]} title="Mark all their mail read" onClick={() => act(r, 'read')}><MailOpen size={13} /></button>}
              {r.inbox > 0 && <button className="btn sm" disabled={busy[`${r.address}archive`]} title="Archive everything from them in the inbox" onClick={() => act(r, 'archive')}><Archive size={13} /> Archive {r.inbox}</button>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
