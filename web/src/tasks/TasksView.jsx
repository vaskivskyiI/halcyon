import { useEffect, useState } from 'react';
import { Plus, Trash2, Mail, Calendar, Flag, MoreHorizontal, Pencil, CalendarX, CalendarClock, ChevronDown, ChevronRight, Share2, Repeat, ListTodo, Star, AlertTriangle, Lock, FolderInput } from 'lucide-react';
import { api, onEvent } from '../api.js';
import { toast, toastError, navigate } from '../util.js';
import { Modal, useMenu } from '../components/common.jsx';
import { store } from '../store.js';
import { jump } from '../back.js';
import { dueOptions, fmtDue, DueField, RepeatField, ListField, repeatLabel } from './TaskDialog.jsx';

// The list shown (null = all lists of the active space), remembered on this device.
const savedList = () => { try { return Number(localStorage.getItem('halcyon.taskList')) || null; } catch { return null; } };

export default function TasksView() {
  const [tasks, setTasks] = useState([]);
  const [showDone, setShowDone] = useState(false);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [showNotes, setShowNotes] = useState(false);
  const [due, setDue] = useState(null);
  const [rrule, setRrule] = useState(null);
  const [lists, setLists] = useState([]);
  const [listId, setListIdState] = useState(savedList);
  const [addTo, setAddTo] = useState(null);
  const setListId = (id) => { setListIdState(id); setAddTo(null); try { localStorage.setItem('halcyon.taskList', id || ''); } catch { /* private mode */ } };
  const [editing, setEditing] = useState(null);
  const [open, setOpen] = useState(() => new Set());
  const [openMenu, menuNode] = useMenu();
  // Lists of the active space; a remembered list that is not in it (another space) is left for all lists.
  const shown = lists.some((l) => l.id === listId) ? listId : null;
  const loadLists = () => api.get('/api/task-lists').then(setLists).catch(toastError);
  const load = () => {
    const q = new URLSearchParams({ ...(showDone ? { done: '1' } : {}), ...(shown ? { listId: shown } : {}) });
    return api.get(`/api/tasks?${q}`).then(setTasks).catch(toastError);
  };
  useEffect(() => { loadLists(); }, []);
  useEffect(() => { load(); }, [showDone, shown]);
  useEffect(() => onEvent((e) => { if (e.type === 'tasks:changed') { load(); loadLists(); } }), [showDone, shown]);
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
      const where = { listId: addTo || shown || undefined, rrule: rrule || undefined };
      const t = await api.post('/api/tasks', due ? { title, notes, due, ...where } : { text: title, notes, ...where });
      toast(`Added “${t.title}”${t.due ? ` — due ${fmtDue(t.due)}` : ''}${lists.length > 1 ? ` to ${t.list}` : ''}${t.rrule ? ` · ${repeatLabel(t.rrule).toLowerCase()}` : ''}`);
      setTitle(''); setNotes(''); setShowNotes(false); setDue(null); setRrule(null); setPreview(null); load(); loadLists();
    } catch (err) { toastError(err); }
  };
  const patch = async (t, p) => {
    setTasks((cur) => cur.map((x) => (x.id === t.id ? { ...x, ...p } : x)));
    try {
      const r = await api.patch(`/api/tasks/${t.id}`, p);
      // A repeating task done moves on to its next date (the done occurrence is kept as completed).
      if (r.completedCopy) { toast(`Done — next “${r.title}” ${r.due ? fmtDue(r.due, r.dueAllDay) : ''}`); load(); }
      else if (p.listId) load();
    } catch (e) { toastError(e); load(); }
  };
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
    ...(lists.filter((l) => !l.readonly && l.id !== t.listId).length ? [{ section: 'Move to list' },
      ...lists.filter((l) => !l.readonly && l.id !== t.listId).map((l) => ({ label: l.name, icon: FolderInput, hint: l.source === 'caldav' ? 'synced' : undefined, onClick: () => patch(t, { listId: l.id }) })), 'sep'] : []),
    { label: t.priority ? 'Not important' : 'Mark important', icon: Flag, onClick: () => patch(t, { priority: t.priority ? 0 : 1 }) },
    t.sourceMessageId && { label: 'Open the email', icon: Mail, onClick: () => jump(`#/mail/unified/${t.sourceMessageId}`) },
    // From one's own tasks into a shared space (only from one's own mail; it then disappears from here).
    ...(!store.get().acting ? (store.get().shared || []).map((s) => ({ label: `Share in “${s.name}”`, icon: Share2, onClick: async () => {
      if (!confirm(`Move “${t.title}” into the shared space “${s.name}”? Its members will see it there.`)) return;
      try { await api.post(`/api/shared/${s.id}/move-in`, { taskIds: [t.id] }); toast(`Moved to “${s.name}”`); load(); } catch (err) { toastError(err); }
    } })) : []),
    'sep',
    { label: 'Delete', icon: Trash2, danger: true, onClick: () => remove(t) },
  ]);

  const listMenu = (e, l) => openMenu(e, [
    { label: 'Rename', icon: Pencil, onClick: async () => { const n = prompt('Name', l.name); if (n?.trim()) { await api.patch(`/api/task-lists/${l.id}`, { name: n.trim() }).catch(toastError); loadLists(); load(); } } },
    !l.isDefault && !l.readonly && { label: 'Make the default list', icon: Star, onClick: async () => { await api.patch(`/api/task-lists/${l.id}`, { isDefault: true }).catch(toastError); loadLists(); } },
    { label: 'Choose its space…', icon: ListTodo, onClick: () => navigate('#/settings/spaces') },
    l.source === 'local' && 'sep',
    l.source === 'local' && { label: 'Delete list and its tasks', icon: Trash2, danger: true, onClick: async () => {
      if (!confirm(`Delete the list “${l.name}” and its ${l.open} open task${l.open === 1 ? '' : 's'}? It is kept in Halcyon only, so they are not anywhere else.`)) return;
      try { await api.del(`/api/task-lists/${l.id}`); if (shown === l.id) setListId(null); loadLists(); load(); } catch (err) { toastError(err); }
    } },
  ]);
  const newList = async () => {
    const n = prompt('Name of the new task list (in the current space)');
    if (!n?.trim()) return;
    try { const l = await api.post('/api/task-lists', { name: n.trim() }); await loadLists(); setListId(l.id); } catch (e) { toastError(e); }
  };
  const showList = lists.length > 1 && !shown;
  const shownList = lists.find((l) => l.id === shown);

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
        <div className="task-lists">
          <button className={`chip clickable ${!shown ? 'on' : ''}`} onClick={() => setListId(null)}>All lists</button>
          {lists.map((l) => (
            <button key={l.id} className={`chip clickable ${shown === l.id ? 'on' : ''}`} onClick={() => setListId(l.id)} onContextMenu={(e) => listMenu(e, l)}
              title={`${l.name}${l.source === 'caldav' ? ' — synced with your calendar server' : ' — kept in Halcyon'}${l.space ? ` · space ${l.space}` : ''}${l.syncError ? `\n${l.syncError}` : ''}`}>
              <span className="dot" style={{ background: l.color || 'var(--accent)' }} />{l.name}{l.readonly && <Lock size={11} />}{l.syncError && <AlertTriangle size={11} color="var(--warning)" />}
              {l.open > 0 && <span className="faint"> {l.open}</span>}
            </button>))}
          {shownList && <button className="icon-btn" title="List options" onClick={(e) => listMenu(e, shownList)}><MoreHorizontal size={15} /></button>}
          <button className="btn ghost sm" onClick={newList}><Plus size={13} /> List</button>
        </div>
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
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <RepeatField value={rrule} onChange={setRrule} disabled={!due && !preview?.due} />
              {!shown && <ListField lists={lists} value={addTo} onChange={setAddTo} />}
            </div>
          </>}
        </form>
        {groups.map(([label, list]) => list.length > 0 && (
          <div key={label} style={{ marginBottom: 18 }}>
            <div className="small" style={{ fontWeight: 700, color: label === 'Overdue' ? 'var(--danger)' : 'var(--text-2)', marginBottom: 4 }}>{label} · {list.length}</div>
            <div className="card">
              {list.map((t) => (
                <div key={t.id} className={`task-row ${t.done ? 'done' : ''}`} onContextMenu={(e) => taskMenu(e, t)}>
                  <input type="checkbox" checked={t.done} disabled={t.readonly} title={t.readonly ? 'This list is read-only' : undefined} onChange={(e) => patch(t, { done: e.target.checked })} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="t" onDoubleClick={() => setEditing(t)}>
                      {t.notes && <button className="icon-btn inline" title={open.has(t.id) ? 'Hide details' : 'Show details'} onClick={() => toggleOpen(t.id)}>{open.has(t.id) ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>}
                      {t.priority ? <Flag size={12} className="imp-flag" /> : null}{t.title}
                    </div>
                    {t.notes && (open.has(t.id) ? <div className="task-notes">{t.notes}</div> : <div className="small faint truncate" onClick={() => toggleOpen(t.id)} style={{ cursor: 'pointer' }}>{t.notes.split('\n').filter(Boolean).slice(-1)[0]}</div>)}
                    <div className="row small faint" style={{ gap: 10 }}>
                      {t.due && <span className="clickable" style={{ color: !t.done && t.due < now ? 'var(--danger)' : undefined }} title="Change due date" onClick={(e) => taskMenu(e, t)}><Calendar size={11} /> {fmtDue(t.due, t.dueAllDay)}</span>}
                      {t.rrule && <span title={t.rrule}><Repeat size={11} /> {repeatLabel(t.rrule)}</span>}
                      {showList && <span className="clickable" onClick={() => setListId(t.listId)} title="Show this list"><ListTodo size={11} /> {t.list}</span>}
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
      {editing && <TaskEditor task={editing} lists={lists} onClose={() => setEditing(null)} onSave={async (p) => { await patch(editing, p); setEditing(null); }} />}
    </div>
  );
}

function TaskEditor({ task, lists, onClose, onSave }) {
  const [f, setF] = useState({ title: task.title, notes: task.notes || '', due: task.due, priority: task.priority, rrule: task.rrule, listId: task.listId });
  // Only what changed is sent (a date-only due from another app stays date-only unless the date is changed).
  const changes = () => Object.fromEntries(Object.entries(f).filter(([k, v]) => v !== (k === 'notes' ? task.notes || '' : task[k])));
  return (
    <Modal title="Edit task" onClose={onClose} footer={<>
      <button className="btn ghost" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={!f.title.trim() || task.readonly} onClick={() => onSave(changes())}>Save</button>
    </>}>
      <div style={{ display: 'grid', gap: 10 }}>
        <label className="field">Task<input className="input" autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
        <label className="field">Details<textarea className="input" rows={6} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
        <div className="field">Due<DueField value={f.due} onChange={(due) => setF({ ...f, due, rrule: due ? f.rrule : null })} /></div>
        <div className="field">Repeat<RepeatField value={f.rrule} disabled={!f.due} onChange={(rrule) => setF({ ...f, rrule })} /></div>
        {lists.filter((l) => !l.readonly).length > 1 && <div className="field">List<ListField lists={lists} auto={false} value={f.listId} onChange={(listId) => setF({ ...f, listId })} /></div>}
        {task.readonly && <div className="small faint"><Lock size={11} /> This list is read-only.</div>}
        <label className="row small"><input type="checkbox" checked={!!f.priority} onChange={(e) => setF({ ...f, priority: e.target.checked ? 1 : 0 })} /> Important</label>
      </div>
    </Modal>
  );
}
