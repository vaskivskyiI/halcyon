import { useEffect, useState } from 'react';
import { Layers, Pencil, Trash2, Star, Mail, Calendar as CalendarIcon, Users } from 'lucide-react';
import { api } from '../api.js';
import { store } from '../store.js';
import { loadSpaces, loadAccounts, loadFolders, saveSettings, setSpace } from '../data.js';
import { toast, toastError } from '../util.js';

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

const SERVICE_ICONS = [['mail', Mail, 'mail'], ['calendar', CalendarIcon, 'calendar'], ['contacts', Users, 'contacts']];

export default function Spaces() {
  const [data, setData] = useState(null);
  const settings = store.use((s) => s.settings);
  const load = () => api.get('/api/spaces').then(setData).catch(toastError);
  useEffect(() => { load(); }, []);
  const refresh = async () => { await load(); loadSpaces(); loadAccounts(); loadFolders(); };
  const assign = async (type, id, space) => {
    try { await api.patch('/api/spaces/assign', { type, id, space }); await refresh(); } catch (e) { toastError(e); }
  };
  const renameSpace = async (from) => {
    const to = prompt(`New name for the space “${from}” (an existing name merges the two):`, from);
    if (!to?.trim() || to.trim() === from) return;
    try { await api.post('/api/spaces/rename', { from, to: to.trim() }); if (store.get().space === from) setSpace(to.trim()); await refresh(); toast(`Renamed to “${to.trim()}”`); } catch (e) { toastError(e); }
  };
  const removeSpace = async (from) => {
    if (!confirm(`Remove the space “${from}”?\n\nIts accounts, calendars and address books stay — they become shared (visible in every space). Nothing is deleted.`)) return;
    try { await api.post('/api/spaces/rename', { from, to: '' }); if (store.get().space === from) setSpace(''); await refresh(); toast(`Space “${from}” removed`); } catch (e) { toastError(e); }
  };
  const rename = async (kind, item) => {
    const n = prompt('Name', item.name);
    if (!n?.trim() || n.trim() === item.name) return;
    try { await api.patch(kind === 'calendar' ? `/api/calendars/${item.id}` : `/api/address-books/${item.id}`, { name: n.trim() }); await load(); } catch (e) { toastError(e); }
  };
  const makeDefault = async (kind, item) => {
    try { await api.patch(kind === 'calendar' ? `/api/calendars/${item.id}` : `/api/address-books/${item.id}`, { isDefault: true }); await load(); } catch (e) { toastError(e); }
  };
  const setDefault = (space, key, value) => saveSettings({ defaults: { [space]: { [key]: value ? Number(value) : null } } });

  if (!data) return null;
  const spaces = [...new Set(['Work', 'Private', ...data.spaces])];
  const acct = (id) => data.accounts.find((a) => a.id === id);
  const mailAccounts = data.accounts.filter((a) => a.mail && a.kind !== 'archive');
  const cals = data.calendars.filter((c) => !c.readonly), books = data.addressBooks.filter((b) => !b.readonly);
  const inSpace = (s, list) => (s ? list.filter((x) => x.space === s || x.space === '') : list);
  const defaults = settings.defaults || {};

  const Defaults = ({ space }) => {
    const d = defaults[space] || {};
    const pick = (key, list, label, describe) => (
      <label className="field">{label}
        <select className="input" value={d[key] || ''} onChange={(e) => setDefault(space, key, e.target.value)}>
          <option value="">{space ? 'Automatic (one of this space)' : 'Automatic'}</option>
          {inSpace(space, list).map((x) => <option key={x.id} value={x.id}>{describe(x)}</option>)}
        </select></label>);
    return (
      <div className="form-grid" style={{ marginTop: 6 }}>
        {pick('accountId', mailAccounts, 'New mail from', (a) => a.email)}
        {pick('calendarId', cals, 'New events in', (c) => `${c.name} — ${c.origin}`)}
        {pick('bookId', books, 'New contacts in', (b) => `${b.name} — ${b.origin}`)}
      </div>);
  };

  return (
    <div className="settings-section">
      <div><h2>Spaces</h2>
        <div className="muted">Keep parts of your life apart — for example a <b>Work</b> and a <b>Private</b> space. Each account, calendar and address book
          belongs to one space or is shared. Pick the space with the <Layers size={13} style={{ verticalAlign: -2 }} /> button in the left bar: mail, search, calendar,
          contacts, the daily brief and the AI assistant then only use that space's data. “All spaces” shows everything.</div></div>

      <h3>Your spaces</h3>
      {data.spaces.map((s) => {
        const c = data.counts?.[s] || {};
        return (
          <div key={s} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div className="row" style={{ gap: 8 }}>
              <Layers size={15} /><b className="grow">{s}</b>
              <span className="small faint">{c.accounts || 0} account{c.accounts === 1 ? '' : 's'} · {c.calendars || 0} calendar{c.calendars === 1 ? '' : 's'} · {c.books || 0} address book{c.books === 1 ? '' : 's'}</span>
              <button className="icon-btn" title="Rename (or merge into another space)" onClick={() => renameSpace(s)}><Pencil size={15} /></button>
              <button className="icon-btn" title="Remove the space — what is in it becomes shared" onClick={() => removeSpace(s)}><Trash2 size={15} /></button>
            </div>
            <Defaults space={s} />
          </div>);
      })}
      {!data.spaces.length && <div className="card empty">No spaces yet — choose one for an account, calendar or address book below.</div>}
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <b className="small">All spaces (and shared)</b>
        <Defaults space="" />
      </div>

      <h3>Accounts</h3>
      {data.accounts.map((a) => (
        <div key={a.id} className="card item-card">
          <span style={{ width: 10, height: 10, borderRadius: 5, background: a.color, flex: 'none' }} />
          <div className="grow truncate">{a.kind === 'archive' ? a.name : a.email}
            <span className="small faint"> · {a.kind === 'archive' ? 'archive' : SERVICE_ICONS.filter(([k]) => a[k]).map(([, , l]) => l).join(', ')}</span></div>
          <SpacePicker value={a.space} spaces={spaces} onChange={(s) => assign('account', a.id, s ?? '')} />
        </div>
      ))}
      {!data.accounts.length && <div className="card empty">No accounts yet.</div>}

      <h3>Calendars</h3>
      {data.calendars.map((c) => (
        <div key={c.id} className="card item-card">
          <span style={{ width: 10, height: 10, borderRadius: 5, background: c.color, flex: 'none' }} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="truncate">{c.name}{!!c.isDefault && <span className="chip" style={{ marginLeft: 6 }}>default</span>}</div>
            <div className="small faint truncate">{c.origin}</div></div>
          <button className="icon-btn" title="Rename" onClick={() => rename('calendar', c)}><Pencil size={14} /></button>
          {!c.readonly && !c.isDefault && <button className="icon-btn" title="Make the default calendar" onClick={() => makeDefault('calendar', c)}><Star size={14} /></button>}
          <SpacePicker value={c.ownSpace} spaces={spaces} inheritLabel={c.accountId ? `Same as account (${acct(c.accountId)?.space || 'shared'})` : null} onChange={(s) => assign('calendar', c.id, s)} />
        </div>
      ))}

      <h3>Address books</h3>
      {data.addressBooks.map((b) => (
        <div key={b.id} className="card item-card">
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="truncate">{b.name}{!!b.isDefault && <span className="chip" style={{ marginLeft: 6 }}>default</span>}</div>
            <div className="small faint truncate">{b.origin}</div></div>
          <button className="icon-btn" title="Rename" onClick={() => rename('addressBook', b)}><Pencil size={14} /></button>
          {!b.readonly && !b.isDefault && <button className="icon-btn" title="Make the default address book" onClick={() => makeDefault('addressBook', b)}><Star size={14} /></button>}
          <SpacePicker value={b.ownSpace} spaces={spaces} inheritLabel={b.accountId ? `Same as account (${acct(b.accountId)?.space || 'shared'})` : null} onChange={(s) => assign('addressBook', b.id, s)} />
        </div>
      ))}
      <div className="small faint">People you write to from an account in a space are collected into an address book of that space. Tasks are not split by space; tasks created from an email follow that email's space in the assistant and brief.</div>
    </div>
  );
}
