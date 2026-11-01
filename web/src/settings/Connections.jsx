import { useEffect, useState } from 'react';
import { Plus, RefreshCw, Trash2, Pencil, Calendar as CalendarIcon, Users, ListTodo, Lock, AlertTriangle } from 'lucide-react';
import { api, onEvent } from '../api.js';
import { store } from '../store.js';
import { loadAccounts } from '../data.js';
import { Modal, Spinner } from '../components/common.jsx';
import { davFound } from '../components/Problems.jsx';
import { toast, toastError, fmtListDate } from '../util.js';
import { oauthSignIn, CertField, tlsBody } from './Accounts.jsx';

// Calendar & contacts connections: CalDAV / CardDAV servers (or Google), separate from mail accounts, and read-only
// CalDAV servers. What each brought in is listed under it in Settings → Calendars & tasks.
const host = (u) => { try { return new URL(u).host; } catch { return ''; } };
const davResult = (r) => { if (r?.dav?.error) toastError(new Error(r.dav.error)); else if (r?.dav?.pending) toast('Still syncing in the background…'); else if (r?.dav) toast(davFound(r.dav)); };

export default function Connections({ counts = {} }) {
  const accounts = store.use((s) => s.accounts).filter((a) => a.connection);
  const oauth = store.use((s) => s.oauth);
  const [sources, setSources] = useState([]);
  const [status, setStatus] = useState({});
  const [editing, setEditing] = useState(null); // {} new, or a connection
  const [busy, setBusy] = useState(null);
  const loadSources = () => api.get('/api/calendar-sources').then(setSources).catch(() => {});
  const loadStatus = () => api.get('/api/accounts/status').then((l) => setStatus(Object.fromEntries(l.map((x) => [x.id, x.dav])))).catch(() => {});
  useEffect(() => { loadSources(); loadStatus(); return onEvent((e) => { if (e.type === 'calendar:changed') loadSources(); if (['calendar:changed', 'contacts:changed', 'dav:error'].includes(e.type)) loadStatus(); }); }, []);

  const syncNow = async (a) => {
    setBusy(a.id);
    try { const r = await api.post(`/api/accounts/${a.id}/sync?dav=1`); if (r.dav?.error) throw new Error(r.dav.error); toast(davFound(r.dav)); } catch (e) { toastError(e); }
    setBusy(null); loadStatus();
  };
  const remove = async (a) => {
    if (!confirm(`Remove the connection “${a.label}”?\n\nIts calendars, task lists and address books are removed from Halcyon; nothing is deleted on the server — you can add it again later.`)) return;
    try { await api.del(`/api/accounts/${a.id}`); toast('Removed'); loadAccounts(); } catch (e) { toastError(e); }
  };
  const refreshSource = async (s) => { setBusy(`s${s.id}`); try { await api.post(`/api/calendar-sources/${s.id}/refresh`); toast('Refreshed'); } catch (e) { toastError(e); } setBusy(null); loadSources(); };
  const removeSource = async (s) => {
    if (!confirm(`Remove the read-only server “${s.name}”? Its calendars are removed from Halcyon; nothing on that server is touched.`)) return;
    try { await api.del(`/api/calendar-sources/${s.id}`); loadSources(); } catch (e) { toastError(e); }
  };
  const what = (a) => [
    a.services.calendar && <span key="c" className="chip"><CalendarIcon size={11} /> {counts[a.id]?.calendars ?? 0} calendars · <ListTodo size={11} /> {counts[a.id]?.taskLists ?? 0} task lists</span>,
    a.services.contacts && <span key="b" className="chip"><Users size={11} /> {counts[a.id]?.books ?? 0} address books</span>,
  ];

  return (<>
    <div className="row"><h3 className="grow" style={{ margin: 0 }}>Connections</h3>
      {oauth?.google && <button className="btn sm" onClick={() => oauthSignIn('google', { services: ['calendar', 'contacts'] }, () => toast('Google calendars and contacts connected'))}>Google</button>}
      <button className="btn sm primary" onClick={() => setEditing({})}><Plus size={13} /> Add connection</button></div>
    <div className="small muted">Where calendars, task lists and contacts come from: a CalDAV / CardDAV server (Nextcloud, iCloud, Fastmail, Baikal, Radicale, …) or Google — separate from mail accounts.</div>
    {accounts.map((a) => {
      const st = status[a.id];
      return (
        <div key={a.id} className="card item-card">
          <span className="status-dot" style={{ background: st?.error ? 'var(--danger)' : st?.at ? 'var(--success)' : 'var(--warning)' }} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600 }} className="truncate">{a.label}</div>
            <div className="small muted truncate">{[...new Set([host(a.caldavUrl), host(a.carddavUrl)].filter(Boolean))].join(', ')} · {a.authType === 'oauth-google' ? 'Google sign-in' : a.davUser || a.email}{a.space ? ` · space ${a.space}` : ''}{st?.at ? ` · ${st.error ? 'last tried' : 'synced'} ${fmtListDate(st.at)}` : ''}</div>
            <div className="service-row">{what(a)}</div>
            {st?.error && <div className="small error-text"><AlertTriangle size={12} /> {st.error}</div>}
          </div>
          <button className="icon-btn" title="Sync now" disabled={busy === a.id} onClick={() => syncNow(a)}>{busy === a.id ? <Spinner size={14} /> : <RefreshCw size={16} />}</button>
          {a.authType !== 'oauth-google' && <button className="icon-btn" title="Edit" onClick={() => setEditing(a)}><Pencil size={16} /></button>}
          <button className="icon-btn" title="Remove the connection (everything stays on the server)" onClick={() => remove(a)}><Trash2 size={16} /></button>
        </div>);
    })}
    {sources.map((s) => (
      <div key={`s${s.id}`} className="card item-card">
        <span className="status-dot" style={{ background: s.error ? 'var(--danger)' : 'var(--success)' }} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600 }} className="truncate">{s.name} <span className="chip"><Lock size={10} /> read-only</span></div>
          <div className="small muted truncate">{host(s.url)}{s.username ? ` · ${s.username}` : ''}{s.lastSyncAt ? ` · refreshed ${fmtListDate(s.lastSyncAt)}` : ''}</div>
          {s.error && <div className="small error-text"><AlertTriangle size={12} /> {s.error}</div>}
        </div>
        <button className="icon-btn" title="Refresh now" disabled={busy === `s${s.id}`} onClick={() => refreshSource(s)}>{busy === `s${s.id}` ? <Spinner size={14} /> : <RefreshCw size={16} />}</button>
        <button className="icon-btn" title="Remove (nothing on that server is touched)" onClick={() => removeSource(s)}><Trash2 size={16} /></button>
      </div>))}
    {!accounts.length && !sources.length && <div className="card empty">No connections yet: calendars, task lists and address books are kept in Halcyon only.</div>}
    {editing && <ConnectionEditor conn={editing.id ? editing : null} onClose={() => setEditing(null)} onDone={() => { setEditing(null); loadAccounts(); loadSources(); loadStatus(); }} />}
  </>);
}

/**
 * A connection: its calendars (CalDAV address), contacts (CardDAV address) or both, with one login and certificate.
 * Read-only: calendars that are only shown, never changed (a read-only CalDAV server).
 */
function ConnectionEditor({ conn, onClose, onDone }) {
  const [f, setF] = useState({ name: conn?.label || '', caldavUrl: conn?.caldavUrl || '', carddavUrl: conn?.carddavUrl || '', davUser: conn?.davUser || '', davPassword: '', tls: conn?.tls || null, readonly: false });
  const [busy, setBusy] = useState(false);
  const url = (u) => /^https?:\/\//.test(u.trim());
  const ok = (f.caldavUrl.trim() || f.carddavUrl.trim()) && (!f.caldavUrl.trim() || url(f.caldavUrl)) && (!f.carddavUrl.trim() || url(f.carddavUrl)) && (conn || f.davUser.trim() || f.readonly);
  const save = async () => {
    setBusy(true);
    try {
      if (f.readonly && !conn) {
        await api.post('/api/calendar-sources', { url: f.caldavUrl.trim(), username: f.davUser.trim() || undefined, password: f.davPassword || undefined, name: f.name.trim() || undefined });
        toast('Calendars added (read-only)');
        return onDone();
      }
      const body = { name: f.name.trim() || undefined, davUser: f.davUser.trim() || undefined, davPassword: f.davPassword || undefined, tls: tlsBody(f.tls) };
      if (!conn) {
        const services = [...(f.caldavUrl.trim() ? ['calendar'] : []), ...(f.carddavUrl.trim() ? ['contacts'] : [])];
        const r = await api.post('/api/accounts', { ...body, services, caldavUrl: f.caldavUrl.trim() || undefined, carddavUrl: f.carddavUrl.trim() || undefined, email: f.name.trim() || undefined });
        davResult(r);
        if (r?.dav?.error) { setBusy(false); return; }
        return onDone();
      }
      // A service left empty is removed (what Halcyon keeps of it; nothing on the server).
      for (const [k, key] of [['calendar', 'caldavUrl'], ['contacts', 'carddavUrl']]) {
        if (conn.services[k] && !f[key].trim()) {
          if (!confirm(`Remove the ${k === 'calendar' ? 'calendars and task lists' : 'address books'} of “${conn.label}” from Halcyon? Nothing is deleted on the server.`)) { setBusy(false); return; }
          await api.del(`/api/accounts/${conn.id}/services/${k}`);
        }
      }
      if (!f.caldavUrl.trim() && !f.carddavUrl.trim()) return onDone();
      const r = await api.patch(`/api/accounts/${conn.id}`, { ...body, caldavUrl: f.caldavUrl.trim() || undefined, carddavUrl: f.carddavUrl.trim() || undefined });
      davResult(r);
      onDone();
    } catch (e) { toastError(e); setBusy(false); }
  };
  return (
    <Modal title={conn ? `Connection — ${conn.label}` : 'Add a calendar & contacts connection'} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !ok} onClick={save}>{busy && <Spinner size={14} />} {conn ? 'Save' : 'Add'}</button></>}>
      <div className="form-grid">
        <label className="field full">Name <span className="faint">— optional, e.g. “Home server” (default: the server)</span><input className="input" autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="field full">Calendars and tasks (CalDAV address)<input className="input" placeholder="https://cloud.example.com/remote.php/dav" value={f.caldavUrl} onChange={(e) => setF({ ...f, caldavUrl: e.target.value })} /></label>
        {!f.readonly && <label className="field full">Contacts (CardDAV address)<input className="input" placeholder="https://cloud.example.com/remote.php/dav" value={f.carddavUrl} onChange={(e) => setF({ ...f, carddavUrl: e.target.value })} /></label>}
        <label className="field">Username<input className="input" value={f.davUser} onChange={(e) => setF({ ...f, davUser: e.target.value })} autoComplete="username" /></label>
        <label className="field">Password{conn && <span className="faint"> (empty: keep)</span>}<input className="input" type="password" value={f.davPassword} onChange={(e) => setF({ ...f, davPassword: e.target.value })} autoComplete="new-password" /></label>
        {!f.readonly && <CertField value={f.tls} onChange={(tls) => setF({ ...f, tls })} />}
        {!conn && <label className="row small field full"><input type="checkbox" checked={f.readonly} onChange={(e) => setF({ ...f, readonly: e.target.checked, carddavUrl: '' })} /> Read-only: only show these calendars, never change them</label>}
      </div>
      <div className="small faint">Nextcloud: https://your-cloud/remote.php/dav · Baikal: https://your-server/dav.php · iCloud: https://caldav.icloud.com (contacts: https://contacts.icloud.com) with an app-specific password · Fastmail: https://caldav.fastmail.com (contacts: https://carddav.fastmail.com). Halcyon looks for the calendars, task lists and address books there and says what it found.</div>
    </Modal>
  );
}
