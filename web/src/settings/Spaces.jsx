import { useEffect, useState } from 'react';
import { Layers } from 'lucide-react';
import { api } from '../api.js';
import { loadSpaces, loadAccounts, loadFolders } from '../data.js';
import { toastError } from '../util.js';

const INHERIT = '\u0000inherit';
const NEW = '\u0000new';

/** Space picker: shared, an existing space, a new one, or (calendars/address books of an account) inherit. */
function SpacePicker({ value, spaces, inheritLabel, onChange }) {
  const v = value === null ? INHERIT : value;
  const all = [...new Set([...spaces, ...(value ? [value] : [])])].sort();
  return (
    <select className="input" style={{ width: 220 }} value={v} onChange={(e) => {
      if (e.target.value === NEW) { const n = prompt('Name of the new space (e.g. Work, Private, Club)'); if (n?.trim()) onChange(n.trim()); return; }
      onChange(e.target.value === INHERIT ? null : e.target.value);
    }}>
      {inheritLabel && <option value={INHERIT}>{inheritLabel}</option>}
      <option value="">Shared — visible in every space</option>
      {all.map((s) => <option key={s} value={s}>{s}</option>)}
      <option value={NEW}>New space…</option>
    </select>
  );
}

export default function Spaces() {
  const [data, setData] = useState(null);
  const load = () => api.get('/api/spaces').then(setData).catch(toastError);
  useEffect(() => { load(); }, []);
  const assign = async (type, id, space) => {
    try { await api.patch('/api/spaces/assign', { type, id, space }); await load(); loadSpaces(); loadAccounts(); loadFolders(); } catch (e) { toastError(e); }
  };
  if (!data) return null;
  const spaces = [...new Set(['Work', 'Private', ...data.spaces])];
  const acct = (id) => data.accounts.find((a) => a.id === id);
  return (
    <div className="settings-section">
      <div><h2>Spaces</h2>
        <div className="muted">Keep parts of your life apart — for example a <b>Work</b> and a <b>Private</b> space. Each mail account, calendar and address book
          belongs to one space or is shared. Pick the space with the <Layers size={13} style={{ verticalAlign: -2 }} /> button in the left bar: mail, search, calendar,
          contacts, the daily brief and the AI assistant then only use that space's data. “All spaces” shows everything.</div></div>

      <h3>Mail accounts</h3>
      {data.accounts.map((a) => (
        <div key={a.id} className="card item-card">
          <span style={{ width: 10, height: 10, borderRadius: 5, background: a.color, flex: 'none' }} />
          <div className="grow truncate">{a.email}</div>
          <SpacePicker value={a.space} spaces={spaces} onChange={(s) => assign('account', a.id, s ?? '')} />
        </div>
      ))}
      {!data.accounts.length && <div className="card empty">No accounts yet.</div>}

      <h3>Calendars</h3>
      {data.calendars.map((c) => (
        <div key={c.id} className="card item-card">
          <span style={{ width: 10, height: 10, borderRadius: 5, background: c.color, flex: 'none' }} />
          <div className="grow truncate">{c.name}{c.accountId && <span className="small faint"> · {acct(c.accountId)?.email}</span>}</div>
          <SpacePicker value={c.ownSpace} spaces={spaces} inheritLabel={c.accountId ? `Same as account (${acct(c.accountId)?.space || 'shared'})` : null} onChange={(s) => assign('calendar', c.id, s)} />
        </div>
      ))}

      <h3>Address books</h3>
      {data.addressBooks.map((b) => (
        <div key={b.id} className="card item-card">
          <div className="grow truncate">{b.name}{b.accountId && <span className="small faint"> · {acct(b.accountId)?.email}</span>}</div>
          <SpacePicker value={b.ownSpace} spaces={spaces} inheritLabel={b.accountId ? `Same as account (${acct(b.accountId)?.space || 'shared'})` : null} onChange={(s) => assign('addressBook', b.id, s)} />
        </div>
      ))}
      <div className="small faint">People you write to from an account in a space are collected into an address book of that space. Tasks are not split by space; tasks created from an email follow that email's space in the assistant and brief.</div>
    </div>
  );
}
