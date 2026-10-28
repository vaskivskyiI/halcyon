import { useEffect, useState } from 'react';
import { CheckSquare, Calendar } from 'lucide-react';
import { api } from '../api.js';
import { store } from '../store.js';
import { Modal, Spinner } from '../components/common.jsx';
import { toast, toastError, navigate, toLocalInput } from '../util.js';

/** Quick due dates: [label, epoch ms | null]. "Today" is the end of the work day (or an hour from now when later). */
export function dueOptions() {
  const s = store.get().settings?.calendar || {};
  const [eh, em] = String(s.workEnd || '17:00').split(':').map(Number);
  const [sh, sm] = String(s.workStart || '09:00').split(':').map(Number);
  const at = (days, h, m = 0) => { const x = new Date(); x.setDate(x.getDate() + days); x.setHours(h, m, 0, 0); return x.getTime(); };
  const today = Math.max(at(0, eh, em), Date.now() + 3600e3);
  const mon = (1 - new Date().getDay() + 7) % 7 || 7;
  return [
    ['Today', today], ['Tomorrow', at(1, sh, sm)], ['In 2 days', at(2, sh, sm)], ['In 3 days', at(3, sh, sm)],
    ['Next Monday', at(mon, sh, sm)], ['In a week', at(7, sh, sm)], ['In 2 weeks', at(14, sh, sm)], ['In a month', at(30, sh, sm)],
  ];
}

export const fmtDue = (t, allDay = false) => new Date(t).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', ...(allDay ? {} : { hour: '2-digit', minute: '2-digit' }) });

/** Repeat choices for a task ([label, RRULE]); the rule repeats from the due date. */
export const REPEATS = [['Does not repeat', ''], ['Every day', 'FREQ=DAILY'], ['Every weekday', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'], ['Every week', 'FREQ=WEEKLY'],
  ['Every 2 weeks', 'FREQ=WEEKLY;INTERVAL=2'], ['Every month', 'FREQ=MONTHLY'], ['Every 3 months', 'FREQ=MONTHLY;INTERVAL=3'], ['Every year', 'FREQ=YEARLY']];
export const repeatLabel = (r) => (r ? (REPEATS.find(([, v]) => v === r)?.[0] || 'Repeats') : '');

/** Repeat picker; a rule made elsewhere (another app) is shown as it is and kept unless changed. */
export function RepeatField({ value, onChange, disabled }) {
  const known = REPEATS.some(([, v]) => v === (value || ''));
  return (
    <select className="input" style={{ width: 210 }} value={value || ''} disabled={disabled} title={disabled ? 'Set a due date first' : 'Repeats from the due date; when done, it moves to the next date'} onChange={(e) => onChange(e.target.value || null)}>
      {REPEATS.map(([l, v]) => <option key={v} value={v}>{l}</option>)}
      {!known && <option value={value}>Custom: {value}</option>}
    </select>);
}

/** Task list picker (lists of the active space; "" = the space's default). */
export function ListField({ lists, value, onChange, auto = true }) {
  const writable = lists.filter((l) => !l.readonly);
  if (writable.length < 2 && !(value && !writable.some((l) => l.id === value))) return null;
  return (
    <select className="input" style={{ width: 210 }} value={value || ''} onChange={(e) => onChange(Number(e.target.value) || null)} title="Task list">
      {auto && <option value="">{`Default list (${writable.find((l) => l.isDefault)?.name || writable[0]?.name || 'Tasks'})`}</option>}
      {writable.map((l) => <option key={l.id} value={l.id}>{l.name}{l.source === 'caldav' ? ' (synced)' : ''}</option>)}
    </select>);
}

/** Date-time field with quick choices underneath. */
export function DueField({ value, onChange }) {
  return (
    <div>
      <div className="row" style={{ gap: 6 }}>
        <input className="input" type="datetime-local" style={{ width: 210 }} value={value ? toLocalInput(value) : ''} onChange={(e) => onChange(e.target.value ? new Date(e.target.value).getTime() : null)} />
        {value && <button type="button" className="btn ghost sm" onClick={() => onChange(null)}>No date</button>}
      </div>
      <div className="row" style={{ gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
        {dueOptions().slice(0, 6).map(([l, t]) => <button type="button" key={l} className="btn ghost sm" onClick={() => onChange(t)}>{l}</button>)}
      </div>
    </div>
  );
}

/** Tasks proposed from an email: each can be edited (title, details, due) or left out before it is created. */
export default function TaskDialog({ messageId, onClose }) {
  const [items, setItems] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get(`/api/tasks/from-message/${messageId}`).then((p) => setItems(p.items.map((x) => ({ ...x, on: true })))).catch((e) => { toastError(e); onClose(); });
  }, [messageId]);
  const set = (i, p) => setItems((cur) => cur.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const create = async () => {
    const chosen = items.filter((x) => x.on && x.title.trim());
    if (!chosen.length) return onClose();
    setBusy(true);
    try {
      const r = await api.post(`/api/tasks/from-message/${messageId}`, { items: chosen });
      toast(`${r.length} task${r.length > 1 ? 's' : ''} added`, { action: { label: 'View', onClick: () => navigate('#/tasks') } });
      onClose();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <Modal title="Add to tasks" onClose={onClose} wide footer={<>
      <button className="btn ghost" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={!items || busy} onClick={create}>{busy ? <Spinner size={14} /> : <CheckSquare size={15} />} Add {items?.filter((x) => x.on).length || ''} task{items?.filter((x) => x.on).length === 1 ? '' : 's'}</button>
    </>}>
      {!items ? <Spinner /> : items.map((it, i) => (
        <div key={i} className="task-propose" style={{ opacity: it.on ? 1 : 0.5 }}>
          <input type="checkbox" checked={it.on} onChange={(e) => set(i, { on: e.target.checked })} title="Include this task" />
          <div className="grow" style={{ display: 'grid', gap: 6, minWidth: 0 }}>
            <input className="input" value={it.title} onChange={(e) => set(i, { title: e.target.value })} placeholder="Task" />
            <textarea className="input" rows={4} value={it.notes} onChange={(e) => set(i, { notes: e.target.value })} placeholder="Details" />
            <div className="row small faint" style={{ gap: 6 }}><Calendar size={12} /> Due</div>
            <DueField value={it.due} onChange={(due) => set(i, { due })} />
          </div>
        </div>
      ))}
    </Modal>
  );
}
