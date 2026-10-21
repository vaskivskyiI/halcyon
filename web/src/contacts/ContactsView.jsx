import { useEffect, useState, useRef, Fragment } from 'react';
import { Search, Plus, Star, Mail, Phone, Building2, Trash2, Upload, Download, ArrowLeft, Pencil, X, Merge, MapPin, Cake, Globe, Calendar } from 'lucide-react';
import { api, onEvent } from '../api.js';
import { Avatar, Modal, Spinner } from '../components/common.jsx';
import { toast, toastError, navigate, fmtListDate } from '../util.js';
import { openComposer } from '../mail/Composer.jsx';
import PersonProfile from '../components/PersonProfile.jsx';

export default function ContactsView({ route }) {
  const selId = route[1] ? Number(route[1]) : null;
  const [list, setList] = useState([]);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('saved');
  const [group, setGroup] = useState('');
  const [groups, setGroups] = useState([]);
  const [editing, setEditing] = useState(null);
  const [checked, setChecked] = useState(new Set());
  const fileRef = useRef();
  const load = () => {
    const p = new URLSearchParams({ q, filter: filter === 'all' ? '' : filter });
    if (group) p.set('group', group);
    api.get(`/api/contacts?${p}`).then(setList).catch(toastError);
    api.get('/api/contacts/groups').then(setGroups).catch(() => {});
  };
  useEffect(() => { const t = setTimeout(load, 150); return () => clearTimeout(t); }, [q, filter, group]);
  useEffect(() => onEvent((e) => e.type === 'contacts:changed' && load()), [q, filter, group]);

  const importFile = async (f) => {
    try { const r = await api.post('/api/contacts/import', { vcf: await f.text() }); toast(`Imported: ${r.created} new, ${r.updated} updated`); load(); } catch (e) { toastError(e); }
  };

  return (
    <div className={`pane ${selId ? 'has-detail' : ''}`}>
      <div className="pane-list">
        <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, borderBottom: '1px solid var(--border)' }}>
          <div className="row"><h3 style={{ margin: 0 }} className="grow">Contacts</h3>
            <button className="icon-btn" title="Import vCard / CSV" onClick={() => fileRef.current.click()}><Upload size={16} /></button>
            <button className="icon-btn" title="Export vCard" onClick={() => window.open(api.url('/api/contacts/export.vcf'))}><Download size={16} /></button>
            <button className="btn primary sm" onClick={() => setEditing({ emails: [{ type: 'work', value: '' }], phones: [], addresses: [], groups: [] })}><Plus size={14} /> New</button>
            <input ref={fileRef} type="file" accept=".vcf,.csv,text/vcard,text/csv" hidden onChange={(e) => { if (e.target.files[0]) importFile(e.target.files[0]); e.target.value = ''; }} />
          </div>
          <div className="search"><Search size={15} /><input className="input" placeholder="Search contacts" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <div className="row">
            <select className="input" value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="saved">My contacts</option><option value="favorites">Favorites</option><option value="collected">Auto-collected</option><option value="all">All</option>
            </select>
            <select className="input" value={group} onChange={(e) => setGroup(e.target.value)}><option value="">All groups</option>{groups.map((g) => <option key={g.name} value={g.name}>{g.name} ({g.count})</option>)}</select>
          </div>
          {checked.size > 1 && <div className="row"><span className="small grow">{checked.size} selected</span>
            <button className="btn sm" onClick={async () => { const r = await api.post('/api/contacts/merge', { ids: [...checked] }).catch(toastError); if (r) { setChecked(new Set()); navigate(`#/contacts/${r.id}`); load(); } }}><Merge size={13} /> Merge</button>
            <button className="btn sm" onClick={() => openComposer({ to: list.filter((c) => checked.has(c.id) && c.emails[0]).map((c) => ({ name: c.displayName, address: c.emails[0].value })) })}><Mail size={13} /> Email</button>
          </div>}
        </div>
        <div className="list">
          {list.map((c) => (
            <div key={c.id} className={`list-row ${selId === c.id ? 'selected' : ''}`} onClick={() => navigate(`#/contacts/${c.id}`)}>
              <input type="checkbox" checked={checked.has(c.id)} onClick={(e) => e.stopPropagation()} onChange={() => setChecked((s) => { const n = new Set(s); n.has(c.id) ? n.delete(c.id) : n.add(c.id); return n; })} />
              <Avatar name={c.displayName} email={c.emails[0]?.value} photo={c.photo} size="sm" />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="truncate" style={{ fontWeight: 500 }}>{c.displayName}{c.favorite && <Star size={12} fill="#f59e0b" color="#f59e0b" style={{ marginLeft: 4 }} />}</div>
                <div className="small faint truncate">{c.emails[0]?.value || c.phones[0]?.value || c.org}</div>
              </div>
            </div>
          ))}
          {!list.length && <div className="empty">{filter === 'collected' ? 'People you email are collected here automatically.' : 'No contacts yet.'}</div>}
        </div>
      </div>
      <div className="pane-detail">{selId ? <ContactDetail id={selId} onEdit={setEditing} onChanged={load} /> : <div className="empty">Select a contact</div>}</div>
      {editing && <ContactEditor contact={editing} groups={groups.map((g) => g.name)} onClose={() => setEditing(null)} onSaved={(c) => { setEditing(null); load(); navigate(`#/contacts/${c.id}`); }} />}
    </div>
  );
}

function ContactDetail({ id, onEdit, onChanged }) {
  const [c, setC] = useState(null);
  const load = () => api.get(`/api/contacts/${id}`).then(setC).catch(toastError);
  useEffect(() => { setC(null); load(); }, [id]);
  if (!c) return <div className="empty"><Spinner /></div>;
  const toggleFav = async () => { await api.patch(`/api/contacts/${id}`, { favorite: !c.favorite }); load(); onChanged(); };
  return (
    <div style={{ maxWidth: 720 }}>
      <button className="btn ghost mobile-only" onClick={() => navigate('#/contacts')}><ArrowLeft size={16} /> Back</button>
      <div className="row" style={{ gap: 16, marginBottom: 20 }}>
        <Avatar name={c.displayName} email={c.emails[0]?.value} photo={c.photo} size="lg" />
        <div className="grow"><h2 style={{ margin: 0 }}>{c.displayName}</h2><div className="muted">{[c.title, c.org].filter(Boolean).join(' · ')}</div>
          {c.groups.length > 0 && <div className="row" style={{ marginTop: 6 }}>{c.groups.map((g) => <span key={g} className="chip">{g}</span>)}</div>}</div>
        <button className="icon-btn" title="Favorite" onClick={toggleFav}><Star size={18} fill={c.favorite ? '#f59e0b' : 'none'} color={c.favorite ? '#f59e0b' : 'currentColor'} /></button>
        <button className="btn" onClick={() => onEdit(c)}><Pencil size={15} /> Edit</button>
        <button className="icon-btn" title="Delete" onClick={async () => { if (confirm(`Delete ${c.displayName}?`)) { await api.del(`/api/contacts/${id}`); onChanged(); navigate('#/contacts'); } }}><Trash2 size={17} /></button>
      </div>
      <div className="row" style={{ marginBottom: 20 }}>
        {c.emails[0] && <button className="btn primary" onClick={() => openComposer({ to: [{ name: c.displayName, address: c.emails[0].value }] })}><Mail size={15} /> Email</button>}
        {c.phones[0] && <a className="btn" href={`tel:${c.phones[0].value}`}><Phone size={15} /> Call</a>}
      </div>
      {c.emails[0] && <><h3 style={{ margin: '14px 0 0', fontSize: 14 }}>What the AI knows</h3><PersonProfile email={c.emails[0].value} name={c.displayName} /></>}
      <dl className="kv">
        {c.emails.map((e, i) => <Fragment key={`e${i}`}><dt><Mail size={13} /> {e.type}</dt><dd><a href="#" onClick={(x) => { x.preventDefault(); openComposer({ to: [{ name: c.displayName, address: e.value }] }); }}>{e.value}</a></dd></Fragment>)}
        {c.phones.map((p, i) => <Fragment key={`p${i}`}><dt><Phone size={13} /> {p.type}</dt><dd><a href={`tel:${p.value}`}>{p.value}</a></dd></Fragment>)}
        {c.addresses.map((a, i) => <Fragment key={`a${i}`}><dt><MapPin size={13} /> {a.type}</dt><dd>{[a.street, [a.postal, a.city].filter(Boolean).join(' '), a.region, a.country].filter(Boolean).join(', ')}</dd></Fragment>)}
        {c.org && <><dt><Building2 size={13} /> Company</dt><dd>{c.org}</dd></>}
        {c.birthday && <><dt><Cake size={13} /> Birthday</dt><dd>{c.birthday}</dd></>}
        {c.website && <><dt><Globe size={13} /> Website</dt><dd><a href={c.website} target="_blank" rel="noreferrer">{c.website}</a></dd></>}
        {c.notes && <><dt>Notes</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{c.notes}</dd></>}
      </dl>
      {c.recentMessages?.length > 0 && <><h3 style={{ marginTop: 28 }}>Recent emails</h3>
        {c.recentMessages.map((m) => <div key={m.id} className="list-row" style={{ borderRadius: 8 }} onClick={() => navigate(`#/mail/unified/${m.id}`)}><Mail size={14} className="faint" /><span className="grow truncate">{m.subject || '(no subject)'}</span><span className="small faint">{fmtListDate(m.date)}</span></div>)}</>}
      {c.events?.length > 0 && <><h3 style={{ marginTop: 20 }}>Meetings</h3>
        {c.events.map((e) => <div key={e.id} className="list-row" style={{ borderRadius: 8 }} onClick={() => navigate('#/calendar')}><Calendar size={14} className="faint" /><span className="grow truncate">{e.title}</span><span className="small faint">{new Date(e.start).toLocaleDateString()}</span></div>)}</>}
    </div>
  );
}

function ContactEditor({ contact, groups, onClose, onSaved }) {
  const [c, setC] = useState({ ...contact, emails: contact.emails?.length ? contact.emails : [{ type: 'work', value: '' }], phones: contact.phones || [], addresses: contact.addresses || [], groups: contact.groups || [] });
  const set = (k, v) => setC((x) => ({ ...x, [k]: v }));
  const listEdit = (k, i, field, v) => set(k, c[k].map((x, j) => (j === i ? { ...x, [field]: v } : x)));
  const save = async () => {
    const body = { ...c, emails: c.emails.filter((e) => e.value.trim()), phones: c.phones.filter((p) => p.value.trim()), displayName: c.displayName || [c.firstName, c.lastName].filter(Boolean).join(' ') };
    try { const r = c.id ? await api.patch(`/api/contacts/${c.id}`, body) : await api.post('/api/contacts', body); onSaved(r); } catch (e) { toastError(e); }
  };
  const photo = (f) => { const r = new FileReader(); r.onload = () => set('photo', r.result); r.readAsDataURL(f); };
  return (
    <Modal title={c.id ? 'Edit contact' : 'New contact'} onClose={onClose} wide footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save</button></>}>
      <div className="row" style={{ gap: 14 }}>
        <label style={{ cursor: 'pointer' }} title="Change photo"><Avatar name={c.displayName || c.firstName} photo={c.photo} size="lg" /><input type="file" accept="image/*" hidden onChange={(e) => e.target.files[0] && photo(e.target.files[0])} /></label>
        <div className="form-grid grow">
          <label className="field">First name<input className="input" value={c.firstName || ''} onChange={(e) => set('firstName', e.target.value)} autoFocus /></label>
          <label className="field">Last name<input className="input" value={c.lastName || ''} onChange={(e) => set('lastName', e.target.value)} /></label>
          <label className="field full">Display name<input className="input" value={c.displayName || ''} placeholder={[c.firstName, c.lastName].filter(Boolean).join(' ')} onChange={(e) => set('displayName', e.target.value)} /></label>
        </div>
      </div>
      <div className="form-grid">
        <label className="field">Company<input className="input" value={c.org || ''} onChange={(e) => set('org', e.target.value)} /></label>
        <label className="field">Job title<input className="input" value={c.title || ''} onChange={(e) => set('title', e.target.value)} /></label>
      </div>
      {['emails', 'phones'].map((k) => (
        <div key={k} className="field" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="small muted" style={{ fontWeight: 500 }}>{k === 'emails' ? 'Email' : 'Phone'}</span>
          {c[k].map((x, i) => (
            <div key={i} className="row">
              <select className="input" style={{ width: 110 }} value={x.type} onChange={(e) => listEdit(k, i, 'type', e.target.value)}>{(k === 'emails' ? ['work', 'home', 'other'] : ['mobile', 'work', 'home', 'other']).map((t) => <option key={t}>{t}</option>)}</select>
              <input className="input" value={x.value} onChange={(e) => listEdit(k, i, 'value', e.target.value)} />
              <button className="icon-btn" onClick={() => set(k, c[k].filter((_, j) => j !== i))}><X size={15} /></button>
            </div>
          ))}
          <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => set(k, [...c[k], { type: k === 'emails' ? 'work' : 'mobile', value: '' }])}><Plus size={13} /> Add</button>
        </div>
      ))}
      <div className="field" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span className="small muted" style={{ fontWeight: 500 }}>Address</span>
        {c.addresses.map((a, i) => (
          <div key={i} className="form-grid">
            <input className="input full" placeholder="Street" value={a.street || ''} onChange={(e) => listEdit('addresses', i, 'street', e.target.value)} />
            <input className="input" placeholder="Postal code" value={a.postal || ''} onChange={(e) => listEdit('addresses', i, 'postal', e.target.value)} />
            <input className="input" placeholder="City" value={a.city || ''} onChange={(e) => listEdit('addresses', i, 'city', e.target.value)} />
            <input className="input" placeholder="Country" value={a.country || ''} onChange={(e) => listEdit('addresses', i, 'country', e.target.value)} />
            <button className="btn sm ghost" onClick={() => set('addresses', c.addresses.filter((_, j) => j !== i))}><X size={13} /> Remove</button>
          </div>
        ))}
        <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => set('addresses', [...c.addresses, { type: 'work' }])}><Plus size={13} /> Add address</button>
      </div>
      <div className="form-grid">
        <label className="field">Birthday<input className="input" type="date" value={c.birthday || ''} onChange={(e) => set('birthday', e.target.value)} /></label>
        <label className="field">Website<input className="input" value={c.website || ''} onChange={(e) => set('website', e.target.value)} /></label>
        <label className="field full">Groups (comma separated)<input className="input" list="contact-groups" value={c.groups.join(', ')} onChange={(e) => set('groups', e.target.value.split(',').map((x) => x.trim()).filter(Boolean))} /></label>
        <datalist id="contact-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
        <label className="field full">Notes<textarea className="input" value={c.notes || ''} onChange={(e) => set('notes', e.target.value)} /></label>
      </div>
    </Modal>
  );
}
