import { useEffect, useState } from 'react';
import { Plus, Trash2, Mail, Calendar, Flag, MoreHorizontal, Pencil, CalendarX, CalendarClock, ChevronDown, ChevronRight, Share2 } from 'lucide-react';
import { api, onEvent } from '../api.js';
import { toast, toastError, navigate } from '../util.js';
import { Modal, useMenu } from '../components/common.jsx';
import { store } from '../store.js';
import { dueOptions, fmtDue, DueField } from './TaskDialog.jsx';

export default function TasksView() {
  const [tasks, setTasks] = useState([]);
  const [showDone, setShowDone] = useState(false);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [showNotes, setShowNotes] = useState(false);
  const [due, setDue] = useState(null);
  const [editing, setEditing] = useState(null);
  const [open, setOpen] = useState(() => new Set());
  const [openMenu, menuNode] = useMenu();
  const load = () => api.get(`/api/tasks${showDone ? '?done=1' : ''}`).then(setTasks).catch(toastError);
  useEffect(() => { load(); }, [showDone]);
  useEffect(() => onEvent((e) => e.type === 'tasks:changed' && load()), [showDone]);
  // Plain language: "Send the report to Ana tomorrow at 10" — the due date is taken from the text (rules, else AI).
  const [preview, setPreview] = useState(null);
  useEffect(() => {
    if (!title.trim() || due) { setPreview(null); return undefined; }
    const t = setTimeout(() => api.post('/api/tasks/parse', { text: title }).then(setPreview).catch(() => setPreview(null)), 300);
    return () => clearTimeout(t);
  }, [title, due]);
  const add = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      const t = await api.post('/api/tasks', due ? { title, notes, due } : { text: title, notes });
      toast(t.due ? `Added “${t.title}” — due ${fmtDue(t.due)}` : `Added “${t.title}”`);
      setTitle(''); setNotes(''); setShowNotes(false); setDue(null); setPreview(null); load();
    } catch (err) { toastError(err); }
  };
  const patch = async (t, p) => { setTasks((cur) => cur.map((x) => (x.id === t.id ? { ...x, ...p } : x))); await api.patch(`/api/tasks/${t.id}`, p).catch(toastError); };
  const remove = async (t) => { if (!confirm(`Delete task “${t.title}”?`)) return; await api.del(`/api/tasks/${t.id}`).catch(toastError); load(); };
  const toggleOpen = (id) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const taskMenu = (e, t) => openMenu(e, [
    { section: 'Due' },
    ...dueOptions().map(([label, at]) => ({ label, icon: CalendarClock, hint: new Date(at).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }), onClick: () => patch(t, { due: at }) })),
    t.due && { label: 'Postpone by a day', icon: CalendarClock, onClick: () => patch(t, { due: Math.max(t.due, Date.now()) + 864e5 }) },
    { label: 'Pick date and time…', icon: Calendar, onClick: () => setEditing(t) },
    t.due && { label: 'Remove due date', icon: CalendarX, onClick: () => patch(t, { due: null }) },
    'sep',
    { label: 'Edit…', icon: Pencil, onClick: () => setEditing(t) },
    { label: t.priority ? 'Not important' : 'Mark important', icon: Flag, onClick: () => patch(t, { priority: t.priority ? 0 : 1 }) },
    t.sourceMessageId && { label: 'Open the email', icon: Mail, onClick: () => navigate(`#/mail/unified/${t.sourceMessageId}`) },
    // From one's own tasks into a shared space (only from one's own mail; it then disappears from here).
    ...(!store.get().acting ? (store.get().shared || []).map((s) => ({ label: `Share in “${s.name}”`, icon: Share2, onClick: async () => {
      if (!confirm(`Move “${t.title}” into the shared space “${s.name}”? Its members will see it there.`)) return;
      try { await api.post(`/api/shared/${s.id}/move-in`, { taskIds: [t.id] }); toast(`Moved to “${s.name}”`); load(); } catch (err) { toastError(err); }
    } })) : []),
    'sep',
    { label: 'Delete', icon: Trash2, danger: true, onClick: () => remove(t) },
  ]);

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
        <form className="card task-add" onSubmit={add}>
          <div className="row">
            <input className="input grow" placeholder="Add a task… e.g. “Send the report to Ana tomorrow at 10” or “pokliči banko v petek”" value={title} onChange={(e) => setTitle(e.target.value)} />
            <button className="btn primary"><Plus size={15} /> Add</button>
          </div>
          {preview?.due && !due && <div className="small" style={{ color: 'var(--accent)' }}><Calendar size={11} /> “{preview.title}” · due {fmtDue(preview.due)}</div>}
          {title.trim() && <>
            {showNotes ? <textarea className="input" rows={3} placeholder="Details (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
              : <button type="button" className="link-btn small" style={{ justifySelf: 'start' }} onClick={() => setShowNotes(true)}>+ Add details</button>}
            <DueField value={due} onChange={setDue} />
          </>}
        </form>
        {groups.map(([label, list]) => list.length > 0 && (
          <div key={label} style={{ marginBottom: 18 }}>
            <div className="small" style={{ fontWeight: 700, color: label === 'Overdue' ? 'var(--danger)' : 'var(--text-2)', marginBottom: 4 }}>{label} · {list.length}</div>
            <div className="card">
              {list.map((t) => (
                <div key={t.id} className={`task-row ${t.done ? 'done' : ''}`} onContextMenu={(e) => taskMenu(e, t)}>
                  <input type="checkbox" checked={t.done} onChange={(e) => patch(t, { done: e.target.checked })} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="t" onDoubleClick={() => setEditing(t)}>
                      {t.notes && <button className="icon-btn inline" title={open.has(t.id) ? 'Hide details' : 'Show details'} onClick={() => toggleOpen(t.id)}>{open.has(t.id) ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>}
                      {t.priority ? <Flag size={12} className="imp-flag" /> : null}{t.title}
                    </div>
                    {t.notes && (open.has(t.id) ? <div className="task-notes">{t.notes}</div> : <div className="small faint truncate" onClick={() => toggleOpen(t.id)} style={{ cursor: 'pointer' }}>{t.notes.split('\n').filter(Boolean).slice(-1)[0]}</div>)}
                    <div className="row small faint" style={{ gap: 10 }}>
                      {t.due && <span className="clickable" style={{ color: !t.done && t.due < now ? 'var(--danger)' : undefined }} title="Change due date" onClick={(e) => taskMenu(e, t)}><Calendar size={11} /> {fmtDue(t.due)}</span>}
                      {t.sourceMessageId && <a href="#" onClick={(e) => { e.preventDefault(); navigate(`#/mail/unified/${t.sourceMessageId}`); }}><Mail size={11} /> from email</a>}
                    </div>
                  </div>
                  {!t.due && !t.done && <button className="btn ghost sm" title="Set a due date" onClick={(e) => taskMenu(e, t)}><Calendar size={13} /> Due</button>}
                  <button className="icon-btn" title="More" onClick={(e) => taskMenu(e, t)}><MoreHorizontal size={16} /></button>
                </div>
              ))}
            </div>
          </div>
        ))}
        {!tasks.length && <div className="empty">No tasks. AI-detected action items from emails can be added here with one click.</div>}
      </div>
      {menuNode}
      {editing && <TaskEditor task={editing} onClose={() => setEditing(null)} onSave={async (p) => { await patch(editing, p); setEditing(null); }} />}
    </div>
  );
}

function TaskEditor({ task, onClose, onSave }) {
  const [f, setF] = useState({ title: task.title, notes: task.notes || '', due: task.due, priority: task.priority });
  return (
    <Modal title="Edit task" onClose={onClose} footer={<>
      <button className="btn ghost" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={!f.title.trim()} onClick={() => onSave(f)}>Save</button>
    </>}>
      <div style={{ display: 'grid', gap: 10 }}>
        <label className="field">Task<input className="input" autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
        <label className="field">Details<textarea className="input" rows={6} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
        <div className="field">Due<DueField value={f.due} onChange={(due) => setF({ ...f, due })} /></div>
        <label className="row small"><input type="checkbox" checked={!!f.priority} onChange={(e) => setF({ ...f, priority: e.target.checked ? 1 : 0 })} /> Important</label>
      </div>
    </Modal>
  );
}
