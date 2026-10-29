// Contacts → Tidy up: suggestions to merge duplicates and to save people the user writes with, each accepted or
// rejected with one click (server: contacts/review.js). Nothing changes before the user accepts.
import { useEffect, useState } from 'react';
import { Merge, UserPlus, Check, X, RefreshCw, Sparkles } from 'lucide-react';
import { api } from '../api.js';
import { Modal, Spinner } from '../components/common.jsx';
import { toast, toastError } from '../util.js';

export function useSuggestionCount() {
  const [n, setN] = useState(0);
  const load = () => api.get('/api/contacts/suggestions').then((r) => setN(r.length)).catch(() => {});
  useEffect(() => { load(); }, []);
  return [n, load];
}

export default function ReviewContacts({ onClose, onChanged }) {
  const [items, setItems] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [keep, setKeep] = useState({});
  const scan = async () => {
    setScanning(true);
    try { setItems(await api.post('/api/contacts/suggestions/scan')); } catch (e) { toastError(e); } finally { setScanning(false); }
  };
  useEffect(() => { api.get('/api/contacts/suggestions').then((r) => { setItems(r); if (!r.length) scan(); }).catch(toastError); }, []);
  const decide = async (s, accept) => {
    try {
      await api.post(`/api/contacts/suggestions/${s.id}`, { accept, keepId: keep[s.id] });
      setItems((cur) => cur.filter((x) => x.id !== s.id));
      onChanged?.();
    } catch (e) { toastError(e); }
  };
  const acceptAll = async (kind) => {
    const list = items.filter((s) => s.kind === kind);
    for (const s of list) await api.post(`/api/contacts/suggestions/${s.id}`, { accept: true }).catch(() => {});
    toast(`${list.length} done`);
    setItems((cur) => cur.filter((x) => x.kind !== kind));
    onChanged?.();
  };
  const merges = (items || []).filter((s) => s.kind === 'merge'), adds = (items || []).filter((s) => s.kind === 'add');
  return (
    <Modal title="Tidy up contacts" onClose={onClose} wide footer={<>
      <button className="btn ghost" disabled={scanning} onClick={scan}>{scanning ? <Spinner size={14} /> : <RefreshCw size={14} />} Look again</button>
      <button className="btn" onClick={onClose}>Done</button></>}>
      <p className="small muted" style={{ marginTop: 0 }}><Sparkles size={12} /> Duplicates to merge and people you write with to save. Nothing changes until you accept; rejected suggestions are not shown again.</p>
      {!items ? <Spinner /> : !items.length ? <div className="empty" style={{ padding: 20 }}>{scanning ? 'Looking…' : 'Nothing to tidy up.'}</div> : <>
        {merges.length > 0 && <div className="row" style={{ marginTop: 6 }}><h3 className="grow" style={{ margin: 0, fontSize: 14 }}><Merge size={14} /> Duplicates ({merges.length})</h3>
          {merges.length > 1 && <button className="link-btn small" onClick={() => acceptAll('merge')}>Merge all</button>}</div>}
        {merges.map((s) => (
          <div key={s.id} className="review-item">
            <div className="grow" style={{ minWidth: 0 }}>
              {s.contacts.map((c) => (
                <label key={c.id} className="row small" style={{ gap: 6 }} title="Keep this one (the others are merged into it)">
                  <input type="radio" name={`keep${s.id}`} checked={(keep[s.id] ?? s.keepId) === c.id} onChange={() => setKeep((k) => ({ ...k, [s.id]: c.id }))} />
                  <b className="truncate">{c.displayName || c.emails[0]?.value}</b>
                  <span className="faint truncate">{c.emails.map((e) => e.value).join(', ')}{c.org ? ` · ${c.org}` : ''}{c.autoCollected ? ' · collected' : ''}</span>
                </label>))}
              <div className="small muted">{s.reason}</div>
            </div>
            <button className="btn sm primary" onClick={() => decide(s, true)}><Check size={13} /> Merge</button>
            <button className="icon-btn" title="Not the same — don't suggest again" onClick={() => decide(s, false)}><X size={15} /></button>
          </div>))}
        {adds.length > 0 && <div className="row" style={{ marginTop: 14 }}><h3 className="grow" style={{ margin: 0, fontSize: 14 }}><UserPlus size={14} /> Save as contacts ({adds.length})</h3>
          {adds.length > 1 && <button className="link-btn small" onClick={() => acceptAll('add')}>Save all</button>}</div>}
        {adds.map((s) => (
          <div key={s.id} className="review-item">
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="truncate"><b>{s.name}</b> <span className="faint small">{s.email}{s.org ? ` · ${s.org}` : ''}</span></div>
              <div className="small muted">{s.reason}</div>
            </div>
            <button className="btn sm primary" onClick={() => decide(s, true)}><Check size={13} /> Save</button>
            <button className="icon-btn" title="Don't suggest again" onClick={() => decide(s, false)}><X size={15} /></button>
          </div>))}
      </>}
    </Modal>
  );
}
