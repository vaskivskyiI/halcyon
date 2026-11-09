import { useEffect, useState } from 'react';
import { ListChecks, Search, Mail, X, CalendarClock } from 'lucide-react';
import { api } from '../api.js';
import { toast, toastError, navigate } from '../util.js';
import { Modal, Spinner } from '../components/common.jsx';

const words = (s) => String(s || '').toLowerCase().replace(/^(re|fw|fwd|aw|odg|sv):\s*/gi, '').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3);
const due = (t) => (t.due ? new Date(t.due).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) : '');

/** "Add to a task": an email that came later about something to do is added to that task. what: { id, subject }. */
export function TaskPicker({ what, onClose, onDone }) {
  const [q, setQ] = useState('');
  const [tasks, setTasks] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/api/tasks').then((l) => setTasks(l.filter((t) => !t.owner && !t.readonly))).catch((e) => { toastError(e); setTasks([]); }); }, []);
  const topic = new Set(words(what.subject));
  const score = (t) => words(t.title).filter((w) => topic.has(w)).length + words(t.notes).filter((w) => topic.has(w)).length / 2;
  const needle = q.trim().toLowerCase();
  const list = (tasks || []).filter((t) => !needle || `${t.title} ${t.notes || ''}`.toLowerCase().includes(needle))
    .map((t) => ({ ...t, score: score(t) })).sort((a, b) => a.done - b.done || b.score - a.score || (a.due || 9e15) - (b.due || 9e15)).slice(0, 60);
  const pick = async (t) => {
    setBusy(true);
    try {
      await api.post(`/api/tasks/${t.id}/links`, { kind: 'mail', id: what.id });
      toast(`Added to “${t.title}”`, { action: { label: 'Open', onClick: () => navigate(`#/tasks/${t.id}`) } });
      onDone?.(t);
      onClose();
    } catch (err) { toastError(err); setBusy(false); }
  };
  return (
    <Modal title="Add the email to a task" onClose={onClose}>
      <div className="row"><Search size={15} className="faint" /><input className="input grow" autoFocus placeholder="Search tasks" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="event-pick">
        {tasks === null ? <div className="small faint"><Spinner size={13} /> Loading…</div>
          : !list.length ? <div className="small faint">{q ? 'No task found.' : 'No open tasks.'}</div>
          : list.map((t) => (
            <button key={t.id} className="event-pick-row" disabled={busy} onClick={() => pick(t)}>
              <ListChecks size={14} style={{ flex: 'none', color: 'var(--accent)' }} />
              <span className="grow truncate" style={{ textDecoration: t.done ? 'line-through' : undefined }}><b>{t.title}</b>{t.list ? <span className="faint"> · {t.list}</span> : null}</span>
              {t.score >= 1 && !q && <span className="chip">likely</span>}
              <span className="small faint" style={{ flex: 'none' }}>{due(t)}</span>
            </button>))}
      </div>
    </Modal>
  );
}

/** In the task editor: the emails added to the task and the events it was added to. */
export function TaskLinks({ taskId, onOpen }) {
  const [links, setLinks] = useState(null);
  useEffect(() => { api.get(`/api/tasks/${taskId}/links`).then(setLinks).catch(() => setLinks(null)); }, [taskId]);
  if (!links || (!links.mail.length && !links.events.length)) return null;
  const unlink = async (id) => { try { setLinks(await api.del(`/api/tasks/${taskId}/links/mail/${id}`)); } catch (e) { toastError(e); } };
  const go = (hash) => { onOpen?.(); navigate(hash); };
  return (
    <div className="event-links">
      {links.events.map((e) => (
        <div key={`e${e.id}`} className="related-item">
          <CalendarClock size={14} /><a href="#" className="grow truncate" onClick={(x) => { x.preventDefault(); go(`#/calendar/event/${e.id}/${e.start}`); }}>
            <b>{e.title || 'Event'}</b> <span className="faint">· {new Date(e.start).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span></a>
        </div>))}
      {links.mail.map((m) => (
        <div key={`m${m.id}`} className="related-item">
          <Mail size={14} /><a href="#" className="grow truncate" onClick={(x) => { x.preventDefault(); go(`#/mail/unified/${m.id}`); }}>
            <b>{m.subject || '(no subject)'}</b> <span className="faint">· {m.from.name || m.from.address} · {new Date(m.date).toLocaleDateString([], { day: 'numeric', month: 'short' })}</span></a>
          <button className="icon-btn" title="Remove from the task (the email stays)" onClick={() => unlink(m.id)}><X size={14} /></button>
        </div>))}
    </div>
  );
}
