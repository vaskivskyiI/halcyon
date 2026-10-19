import { useEffect, useState } from 'react';
import { Plus, Trash2, Mail, Calendar, Flag } from 'lucide-react';
import { api, onEvent } from '../api.js';
import { toastError, navigate, toLocalInput } from '../util.js';

export default function TasksView() {
  const [tasks, setTasks] = useState([]);
  const [showDone, setShowDone] = useState(false);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [edit, setEdit] = useState(null);
  const load = () => api.get(`/api/tasks${showDone ? '?done=1' : ''}`).then(setTasks).catch(toastError);
  useEffect(() => { load(); }, [showDone]);
  useEffect(() => onEvent((e) => e.type === 'tasks:changed' && load()), [showDone]);
  const add = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    await api.post('/api/tasks', { title, due: due ? new Date(due).getTime() : null }).catch(toastError);
    setTitle(''); setDue(''); load();
  };
  const patch = async (t, p) => { setTasks((cur) => cur.map((x) => (x.id === t.id ? { ...x, ...p } : x))); await api.patch(`/api/tasks/${t.id}`, p).catch(toastError); };
  const now = Date.now();
  const groups = [
    ['Overdue', tasks.filter((t) => !t.done && t.due && t.due < now)],
    ['Today', tasks.filter((t) => !t.done && t.due && t.due >= now && new Date(t.due).toDateString() === new Date().toDateString())],
    ['Upcoming', tasks.filter((t) => !t.done && t.due && t.due >= now && new Date(t.due).toDateString() !== new Date().toDateString())],
    ['No date', tasks.filter((t) => !t.done && !t.due)],
    ['Completed', tasks.filter((t) => t.done)],
  ];
  return (
    <div className="pane" style={{ flexDirection: 'column' }}>
      <div style={{ maxWidth: 820, width: '100%', margin: '0 auto', padding: '20px 16px', overflow: 'auto' }}>
        <div className="row"><h2 style={{ margin: 0 }} className="grow">Tasks</h2><label className="row small"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show all completed</label></div>
        <form className="row" onSubmit={add} style={{ margin: '16px 0' }}>
          <input className="input grow" placeholder="Add a task…" value={title} onChange={(e) => setTitle(e.target.value)} />
          <input className="input" style={{ width: 210 }} type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} title="Due" />
          <button className="btn primary"><Plus size={15} /> Add</button>
        </form>
        {groups.map(([label, list]) => list.length > 0 && (
          <div key={label} style={{ marginBottom: 18 }}>
            <div className="small" style={{ fontWeight: 700, color: label === 'Overdue' ? 'var(--danger)' : 'var(--text-2)', marginBottom: 4 }}>{label} · {list.length}</div>
            <div className="card">
              {list.map((t) => (
                <div key={t.id} className={`task-row ${t.done ? 'done' : ''}`}>
                  <input type="checkbox" checked={t.done} onChange={(e) => patch(t, { done: e.target.checked })} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    {edit === t.id ? <input className="input" autoFocus defaultValue={t.title} onBlur={(e) => { patch(t, { title: e.target.value }); setEdit(null); }} onKeyDown={(e) => e.key === 'Enter' && e.target.blur()} />
                      : <div className="t" onDoubleClick={() => setEdit(t.id)}>{t.title}</div>}
                    <div className="row small faint" style={{ gap: 10 }}>
                      {t.due && <span style={{ color: !t.done && t.due < now ? 'var(--danger)' : undefined }}><Calendar size={11} /> {new Date(t.due).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>}
                      {t.sourceMessageId && <a href="#" onClick={(e) => { e.preventDefault(); navigate(`#/mail/unified/${t.sourceMessageId}`); }}><Mail size={11} /> from email</a>}
                    </div>
                  </div>
                  <input type="datetime-local" className="input" style={{ width: 200 }} value={t.due ? toLocalInput(t.due) : ''} onChange={(e) => patch(t, { due: e.target.value ? new Date(e.target.value).getTime() : null })} />
                  <button className="icon-btn" title="Important" onClick={() => patch(t, { priority: t.priority ? 0 : 1 })}><Flag size={15} fill={t.priority ? 'var(--danger)' : 'none'} color={t.priority ? 'var(--danger)' : 'currentColor'} /></button>
                  <button className="icon-btn" title="Delete" onClick={async () => { await api.del(`/api/tasks/${t.id}`); load(); }}><Trash2 size={15} /></button>
                </div>
              ))}
            </div>
          </div>
        ))}
        {!tasks.length && <div className="empty">No tasks. AI-detected action items from emails can be added here with one click.</div>}
      </div>
    </div>
  );
}
