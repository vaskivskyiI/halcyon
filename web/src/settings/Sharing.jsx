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
  // Own accounts, calendars and address books; those synced through an account are offered together with it.
  const loadMine = () => !acting && Promise.all([api.get('/api/accounts'), api.get('/api/calendars?allSpaces=1'), api.get('/api/address-books')])
    .then(([accounts, calendars, books]) => setMine({ accounts, calendars: calendars.map((c) => ({ ...c, accountId: c.accountId ?? c.account_id ?? null })), books })).catch(() => {});
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
              {/* The space's own empty calendar / contacts (made with it) are not something that was shared. */}
              {[...s.accounts.map((a) => ['account', a.email, { accountId: a.id }]),
                ...s.calendars.filter((c) => !c.accountId && (c.items || c.source !== 'local')).map((c) => ['calendar', c.name, { calendarId: c.id }]),
                ...s.addressBooks.filter((b) => !b.accountId && (b.items || b.source !== 'local')).map((b) => ['contacts', b.name, { addressBookId: b.id }])].map(([kind, label, body]) => (
                <div key={`${kind}${label}`} className="row" style={{ gap: 6 }}>
                  <span className="grow">{label} <span className="faint">· {kind}</span></span>
                  {owner && <button className="btn sm ghost" title="Back into your own mail" onClick={() => back(body, label)}><Undo2 size={13} /> Move to my mail</button>}
                </div>
              ))}
              {!s.accounts.length && !s.calendars.some((c) => c.items) && !s.addressBooks.some((b) => b.items) && <div className="faint">Nothing shared yet.</div>}
              <div className="faint">{s.tasks} open task{s.tasks === 1 ? '' : 's'} · tasks made from the shared mail are shared · the space has its own calendar and contacts for what is added inside it</div>
            </div>
            <AddToSpace space={s} mine={mine} onDone={refresh} />
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

/** Choose what to share — a mail account, a calendar, contacts, each optional — then share it in one step. */
function AddToSpace({ space, mine, onDone }) {
  const [accountId, setAccountId] = useState('');
  const [withCal, setWithCal] = useState(false);
  const [withBook, setWithBook] = useState(false);
  const [calendarId, setCalendarId] = useState('');
  const [bookId, setBookId] = useState('');
  const [busy, setBusy] = useState(false);
  const acc = mine.accounts.find((a) => a.id === Number(accountId));
  const accCals = acc ? mine.calendars.filter((c) => c.accountId === acc.id) : [];
  const accBooks = acc ? mine.books.filter((b) => b.accountId === acc.id) : [];
  const cal = mine.calendars.find((c) => c.id === Number(calendarId));
  const book = mine.books.find((b) => b.id === Number(bookId));
  const what = [acc && `the mail account ${acc.email}${withCal && accCals.length ? ' with its synced calendar' : ''}${withBook && accBooks.length ? ' with its synced contacts' : ''}`, cal && `the calendar “${cal.name}”`, book && `the contacts “${book.name}”`].filter(Boolean);
  const share = async () => {
    const kept = [acc && accCals.length && !withCal && 'its synced calendar', acc && accBooks.length && !withBook && 'its synced contacts'].filter(Boolean);
    if (!confirm(`Share in “${space.name}”: ${what.join(', ')}?\n\nEveryone in the space will see it there (and it leaves your own mail). The AI analysis made so far is kept.${kept.length ? `\n\nNot shared: ${kept.join(' and ')} — they stay yours as a copy but are no longer synced (their sync uses the account's login).` : ''}`)) return;
    setBusy(true);
    try {
      if (acc) await api.post(`/api/shared/${space.id}/move-in`, { accountId: acc.id, withCalendars: withCal, withContacts: withBook });
      if (cal) await api.post(`/api/shared/${space.id}/move-in`, { calendarId: cal.id });
      if (book) await api.post(`/api/shared/${space.id}/move-in`, { addressBookId: book.id });
      toast(`Shared in “${space.name}”`);
      setAccountId(''); setCalendarId(''); setBookId(''); setWithCal(false); setWithBook(false);
      onDone();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <div className="small" style={{ display: 'grid', gap: 6 }}>
      <b>Add from my mail</b>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <select className="input" style={{ width: 'auto', height: 30 }} value={accountId} onChange={(e) => { setAccountId(e.target.value); setWithCal(false); setWithBook(false); }}>
          <option value="">Mail account: none</option>{mine.accounts.map((a) => <option key={a.id} value={a.id}>{a.email}</option>)}</select>
        <select className="input" style={{ width: 'auto', height: 30 }} value={calendarId} onChange={(e) => setCalendarId(e.target.value)}>
          <option value="">Calendar: none</option>{mine.calendars.filter((c) => !c.accountId && !c.readonly).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <select className="input" style={{ width: 'auto', height: 30 }} value={bookId} onChange={(e) => setBookId(e.target.value)}>
          <option value="">Contacts: none</option>{mine.books.filter((b) => !b.accountId && !b.readonly).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
      </div>
      {acc && (accCals.length > 0 || accBooks.length > 0) && <div style={{ display: 'grid', gap: 2 }}>
        {accCals.length > 0 && <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={withCal} onChange={(e) => setWithCal(e.target.checked)} /> Also share the calendar synced from this account ({accCals.map((c) => c.name).join(', ')})</label>}
        {accBooks.length > 0 && <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={withBook} onChange={(e) => setWithBook(e.target.checked)} /> Also share the contacts synced from this account ({accBooks.map((b) => b.name).join(', ')})</label>}
        <span className="faint">Unchecked: they stay yours as a copy, no longer synced.</span>
      </div>}
      {acc && <span className="faint">The account takes along its folders, AI analysis, rules, drafts and the tasks made from its mail.</span>}
      <div><button className="btn sm primary" disabled={!what.length || busy} onClick={share}>Share selected…</button></div>
    </div>
  );
}
