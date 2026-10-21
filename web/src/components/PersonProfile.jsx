import { useEffect, useState } from 'react';
import { UserRound, RefreshCw, Pencil, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../api.js';
import { toast, toastError } from '../util.js';

/**
 * What the AI knows about a person (built from the mail exchanged with them): who they are, what you discuss, how you
 * write to them. The user's own notes are kept with it and always take precedence. compact: one line that expands.
 */
export default function PersonProfile({ email, name, compact = false }) {
  const [p, setP] = useState(null);
  const [open, setOpen] = useState(!compact);
  const [editing, setEditing] = useState(false);
  const [notes, setNotes] = useState('');
  const load = () => api.get(`/api/people/${encodeURIComponent(email)}`).then((r) => { setP(r); setNotes(r.notes || ''); }).catch(() => setP(null));
  useEffect(() => { if (email) load(); }, [email]);
  if (!email || !p) return null;
  const pr = p.profile;
  if (compact && !pr?.who && !p.notes) return null;
  const save = async () => {
    try { await api.put(`/api/people/${encodeURIComponent(email)}/notes`, { notes }); setEditing(false); toast('Saved — the AI will use your notes about this person'); load(); } catch (e) { toastError(e); }
  };
  const refresh = async () => { try { await api.post(`/api/people/${encodeURIComponent(email)}/refresh`); toast('Updating what the AI knows about this person…'); setTimeout(load, 15e3); } catch (e) { toastError(e); } };
  const label = name || p.name || email;
  return (
    <div className={`person-profile ${compact ? 'compact' : ''}`}>
      <div className="row small" style={{ gap: 6, cursor: compact ? 'pointer' : 'default' }} onClick={() => compact && setOpen(!open)}>
        {compact && (open ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
        <UserRound size={13} className="faint" />
        <span className="grow" style={{ minWidth: 0 }}>{p.notes && !pr?.who ? p.notes : pr?.who || <span className="faint">The AI does not know much about {label} yet{p.messages ? ` (${p.messages} emails)` : ''}.</span>}</span>
      </div>
      {open && <div className="small" style={{ display: 'grid', gap: 3, marginTop: 4 }}>
        {pr?.topics?.length > 0 && <div><span className="faint">Usually about:</span> {pr.topics.join(', ')}</div>}
        {pr?.userWriting && <div><span className="faint">How you write to {label.split(' ')[0]}:</span> {pr.userWriting}</div>}
        {pr?.language && <div><span className="faint">Language:</span> {pr.language}</div>}
        {pr?.notes?.length > 0 && <div><span className="faint">Worth knowing:</span> {pr.notes.join('; ')}</div>}
        {editing ? <div style={{ display: 'grid', gap: 4 }}>
          <textarea className="input" rows={3} value={notes} autoFocus placeholder={`What the AI should know about ${label} (role, how you know them, how to address them…)`} onChange={(e) => setNotes(e.target.value)} />
          <div className="row"><span className="grow" /><button className="btn sm" onClick={() => { setEditing(false); setNotes(p.notes || ''); }}>Cancel</button><button className="btn sm primary" onClick={save}>Save</button></div>
        </div> : p.notes && <div><span className="faint">Your notes:</span> {p.notes}</div>}
        <div className="row" style={{ gap: 6 }}>
          {!editing && <button className="link-btn" onClick={() => setEditing(true)}><Pencil size={11} /> {p.notes ? 'Edit your notes' : 'Add your notes'}</button>}
          <button className="link-btn" onClick={refresh}><RefreshCw size={11} /> Update from mail</button>
          {p.builtAt && <span className="faint">updated {new Date(p.builtAt).toLocaleDateString()}</span>}
        </div>
      </div>}
    </div>
  );
}
