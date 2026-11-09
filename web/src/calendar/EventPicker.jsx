import { useEffect, useState } from 'react';
import { CalendarDays, Search, Mail, X, CheckSquare, Plus } from 'lucide-react';
import { api } from '../api.js';
import { toast, toastError, navigate } from '../util.js';
import { Modal, Spinner } from '../components/common.jsx';

const when = (e) => new Date(e.start).toLocaleString([], e.allDay ? { weekday: 'short', day: 'numeric', month: 'short' } : { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const words = (s) => String(s || '').toLowerCase().replace(/^(re|fw|fwd|aw|odg|sv):\s*/gi, '').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3);

/**
 * "Add to event": an email that came later, or a task made for it, is added to an event already in the calendar.
 * Events around now are listed, those with the same people or words in the title first; or searched for.
 * what: { kind: 'mail' | 'task', id, subject?, people?: [addresses] }.
 */
export function EventPicker({ what, onClose, onDone, onPick, title, footer }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const raw = q.trim() ? await api.get(`/api/events/search?q=${encodeURIComponent(q.trim())}`)
          : await api.get(`/api/events?from=${Date.now() - 14 * 864e5}&to=${Date.now() + 60 * 864e5}`);
        // One row per event (a repeating one at its next occurrence).
        const seen = new Map();
        for (const e of raw) {
          const key = e.seriesId || e.id;
          const cur = seen.get(key);
          if (!cur || (cur.start < Date.now() && e.start > cur.start)) seen.set(key, e);
        }
        const people = new Set((what.people || []).map((a) => a.toLowerCase()));
        const topic = new Set(words(what.subject));
        const score = (e) => (e.attendees || []).filter((a) => people.has(String(a.email).toLowerCase())).length * 2
          + words(e.title).filter((w) => topic.has(w)).length + (people.has(String(e.organizer?.email || '').toLowerCase()) ? 2 : 0);
        const near = (e) => Math.abs(e.start - Date.now());
        setList([...seen.values()].map((e) => ({ ...e, score: score(e) })).sort((a, b) => b.score - a.score || (q.trim() ? b.start - a.start : near(a) - near(b))).slice(0, 40));
      } catch (e) { toastError(e); setList([]); }
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q]);
  const pick = async (e) => {
    setBusy(true);
    try {
      if (onPick) await onPick(e);
      else await api.post(`/api/events/${e.seriesId || e.id}/links`, { kind: what.kind, id: what.id });
      toast(`Added to “${e.title || 'the event'}”`, { action: { label: 'Open', onClick: () => navigate(`#/calendar/event/${e.seriesId || e.id}/${e.start}`) } });
      onDone?.(e);
      onClose();
    } catch (err) { toastError(err); setBusy(false); }
  };
  return (
    <Modal title={title || (what.kind === 'task' ? 'Add the task to an event' : 'Add the email to an event')} onClose={onClose} footer={footer}>
      <div className="row"><Search size={15} className="faint" /><input className="input grow" autoFocus placeholder="Search events" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="event-pick">
        {list === null ? <div className="small faint"><Spinner size={13} /> Loading…</div>
          : !list.length ? <div className="small faint">{q ? 'No event found.' : 'No events in the coming weeks — search for one.'}</div>
          : list.map((e) => (
            <button key={e.instanceId || e.id} className="event-pick-row" disabled={busy} onClick={() => pick(e)}>
              <CalendarDays size={14} style={{ color: e.color || 'var(--accent)', flex: 'none' }} />
              <span className="grow truncate"><b>{e.title || '(no title)'}</b>{e.location ? <span className="faint"> · {e.location}</span> : null}</span>
              {e.score > 0 && !q && <span className="chip">likely</span>}
              <span className="small faint" style={{ flex: 'none' }}>{when(e)}</span>
            </button>))}
      </div>
    </Modal>
  );
}

/** In the event editor: the emails and tasks added to the event; a new task for it is added here too. */
export function EventLinks({ eventId, onOpen }) {
  const [links, setLinks] = useState(null);
  const [title, setTitle] = useState('');
  const load = () => api.get(`/api/events/${eventId}/links`).then(setLinks).catch(() => setLinks(null));
  useEffect(() => { load(); }, [eventId]);
  if (!links) return null;
  const unlink = async (kind, id) => { try { setLinks(await api.del(`/api/events/${eventId}/links/${kind}/${id}`)); } catch (e) { toastError(e); } };
  const addTask = async () => {
    if (!title.trim()) return;
    try {
      const t = await api.post('/api/tasks', { title: title.trim() });
      setLinks(await api.post(`/api/events/${eventId}/links`, { kind: 'task', id: t.id }));
      setTitle('');
    } catch (e) { toastError(e); }
  };
  const toggle = async (t) => { try { await api.patch(`/api/tasks/${t.id}`, { done: !t.done }); load(); } catch (e) { toastError(e); } };
  const go = (hash) => { onOpen?.(); navigate(hash); };
  return (
    <div className="event-links">
      {links.mail.map((m) => (
        <div key={`m${m.id}`} className="related-item">
          <Mail size={14} /><a href={`#/mail/unified/${m.id}`} className="grow truncate" onClick={(e) => { e.preventDefault(); go(`#/mail/unified/${m.id}`); }}>
            <b>{m.subject || '(no subject)'}</b> <span className="faint">· {m.from.name || m.from.address} · {new Date(m.date).toLocaleDateString([], { day: 'numeric', month: 'short' })}</span></a>
          <button className="icon-btn" title="Remove from the event (the email stays)" onClick={() => unlink('mail', m.id)}><X size={14} /></button>
        </div>))}
      {links.tasks.map((t) => (
        <div key={`t${t.id}`} className="related-item">
          <input type="checkbox" checked={t.done} onChange={() => toggle(t)} title={t.done ? 'Mark as not done' : 'Mark as done'} />
          <a href={`#/tasks/${t.id}`} className="grow truncate" style={{ textDecoration: t.done ? 'line-through' : undefined }} onClick={(e) => { e.preventDefault(); go(`#/tasks/${t.id}`); }}>{t.title}</a>
          <button className="icon-btn" title="Remove from the event (the task stays)" onClick={() => unlink('task', t.id)}><X size={14} /></button>
        </div>))}
      <div className="row"><CheckSquare size={16} className="faint" />
        <input className="input grow" placeholder="Add a task for this event" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTask(); } }} />
        {title.trim() && <button className="btn sm" onClick={addTask}><Plus size={13} /> Add</button>}
      </div>
    </div>
  );
}
