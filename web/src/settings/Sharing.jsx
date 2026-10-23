import { useEffect, useState } from 'react';
import { Plus, Trash2, LogIn, Undo2, UserPlus } from 'lucide-react';
import { api } from '../api.js';
import { store } from '../store.js';
import { loadShared, enterShared, loadAccounts } from '../data.js';
import { toast, toastError } from '../util.js';

/**
 * Shared spaces: a business mailbox with a calendar, contacts and tasks, used by several people with their own logins.
 * It is synced and analysed once; nobody sees anything of the others' own mail.
 */
export default function Sharing() {
  const shared = store.use((s) => s.shared) || [];
  const acting = store.use((s) => s.acting);
  const [mine, setMine] = useState({ accounts: [], calendars: [], books: [] });
  const [name, setName] = useState('');
  const loadMine = () => !acting && Promise.all([api.get('/api/accounts'), api.get('/api/calendars?allSpaces=1'), api.get('/api/address-books')])
    .then(([accounts, calendars, books]) => setMine({ accounts, calendars: calendars.filter((c) => !(c.accountId ?? c.account_id) && !c.readonly), books: books.filter((b) => !b.accountId && !b.readonly) })).catch(() => {});
  useEffect(() => { loadShared(); loadMine(); }, []);
  const refresh = () => { loadShared(); loadMine(); loadAccounts().catch(() => {}); };
  const call = async (fn, done) => { try { await fn(); if (done) toast(done); refresh(); } catch (e) { toastError(e); } };

  if (acting) {
    return (
      <div className="settings-section">
        <h2>Sharing</h2>
        <div className="notice">You are working in the shared space “{acting.name}”. Members, and what is in the space, are managed from your own mail.</div>
        <div><button className="btn" onClick={() => enterShared(null)}><LogIn size={15} /> Back to my mail</button></div>
      </div>
    );
  }
  return (
    <div className="settings-section">
      <h2>Sharing</h2>
      <div className="muted">Share a mail account — e.g. your business address — with someone who has their own login on this server, together with a calendar, contacts and the tasks from that mail. It is synced and analysed by the AI once, for both of you; the AI there learns only from what is shared. Your other accounts, mail, calendars, contacts and assistant chats stay yours alone.</div>

      {shared.map((s) => {
        const owner = s.role === 'owner';
        const add = (body, what) => { if (confirm(`Move ${what} into “${s.name}”? Everyone in the space will see it (and only there). The AI analysis made so far is kept.`)) call(() => api.post(`/api/shared/${s.id}/move-in`, body), `${what} is now shared`); };
        const back = (body, what) => { if (confirm(`Move ${what} out of “${s.name}” into your own mail? The other members will no longer see it.`)) call(() => api.post(`/api/shared/${s.id}/move-out`, body), `${what} moved to your mail`); };
        return (
          <div key={s.id} className="card" style={{ padding: 14, display: 'grid', gap: 10 }}>
            <div className="row">
              <b className="grow">{s.name}</b>
              <button className="btn sm primary" onClick={() => enterShared(s.id)}><LogIn size={14} /> Open</button>
              {owner && <button className="icon-btn" title="Delete the shared space (only when empty)" onClick={() => confirm(`Delete “${s.name}”?`) && call(() => api.del(`/api/shared/${s.id}`), 'Deleted')}><Trash2 size={15} /></button>}
            </div>
            <div className="small">
              <b>Members</b>
              {s.members.map((m) => (
                <div key={m.id} className="row" style={{ gap: 6 }}>
                  <span className="grow">{m.name} <span className="faint">{m.email}{m.role === 'owner' ? ' · owner' : ''}{m.you ? ' · you' : ''}</span></span>
                  {(owner && !m.you) && <button className="btn sm ghost" onClick={() => confirm(`Remove ${m.name} from “${s.name}”?`) && call(() => api.del(`/api/shared/${s.id}/members/${m.id}`), 'Removed')}>Remove</button>}
                  {m.you && !owner && <button className="btn sm ghost" onClick={() => confirm(`Leave “${s.name}”?`) && call(() => api.del(`/api/shared/${s.id}/members/${m.id}`), 'You left the space')}>Leave</button>}
                </div>
              ))}
              {owner && <AddMember onAdd={(email) => call(() => api.post(`/api/shared/${s.id}/members`, { email }), `${email} can now open “${s.name}”`)} />}
            </div>
            <div className="small">
              <b>Shared here</b>
              {[...s.accounts.map((a) => ['account', a.email, { accountId: a.id }]),
                ...s.calendars.filter((c) => !c.accountId).map((c) => ['calendar', c.name, { calendarId: c.id }]),
                ...s.addressBooks.filter((b) => !b.accountId).map((b) => ['contacts', b.name, { addressBookId: b.id }])].map(([kind, label, body]) => (
                <div key={`${kind}${label}`} className="row" style={{ gap: 6 }}>
                  <span className="grow">{label} <span className="faint">· {kind}</span></span>
                  {owner && <button className="btn sm ghost" title="Back into your own mail" onClick={() => back(body, label)}><Undo2 size={13} /> Move to my mail</button>}
                </div>
              ))}
              <div className="faint">{s.tasks} open task{s.tasks === 1 ? '' : 's'} · tasks made from the shared mail are shared</div>
            </div>
            <div className="row small" style={{ flexWrap: 'wrap', gap: 8 }}>
              <b>Add from my mail:</b>
              <select className="input" style={{ width: 'auto', height: 30 }} value="" onChange={(e) => { const a = mine.accounts.find((x) => x.id === Number(e.target.value)); if (a) add({ accountId: a.id }, a.email); }}>
                <option value="">Mail account…</option>{mine.accounts.map((a) => <option key={a.id} value={a.id}>{a.email}</option>)}</select>
              <select className="input" style={{ width: 'auto', height: 30 }} value="" onChange={(e) => { const c = mine.calendars.find((x) => x.id === Number(e.target.value)); if (c) add({ calendarId: c.id }, `the calendar “${c.name}”`); }}>
                <option value="">Calendar…</option>{mine.calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
              <select className="input" style={{ width: 'auto', height: 30 }} value="" onChange={(e) => { const b = mine.books.find((x) => x.id === Number(e.target.value)); if (b) add({ addressBookId: b.id }, `the contacts “${b.name}”`); }}>
                <option value="">Contacts…</option>{mine.books.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
            </div>
            <div className="faint small">A mail account moves with its calendars and contacts synced from it, its rules, drafts and the tasks made from its mail.</div>
          </div>
        );
      })}

      <div className="row">
        <input className="input" style={{ maxWidth: 280 }} placeholder="New shared space, e.g. “Studio”" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn" disabled={!name.trim()} onClick={() => call(async () => { await api.post('/api/shared', { name }); setName(''); }, 'Shared space created')}><Plus size={15} /> Create</button>
      </div>
    </div>
  );
}

function AddMember({ onAdd }) {
  const [email, setEmail] = useState('');
  return (
    <div className="row" style={{ marginTop: 6 }}>
      <input className="input" style={{ maxWidth: 260, height: 30 }} type="email" placeholder="Their Halcyon login email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <button className="btn sm" disabled={!email.includes('@')} onClick={() => { onAdd(email.trim()); setEmail(''); }}><UserPlus size={14} /> Add member</button>
    </div>
  );
}
