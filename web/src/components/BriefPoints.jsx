// The AI overview of the daily brief: the overview, then "Heads-up" and "FYI" points, each with the emails, events
// and tasks it is about and what can be done with it right there. Used by the Assistant's brief and by Home.
import { useState } from 'react';
import { Mail, Calendar, CheckSquare, ListPlus, Check, EyeOff } from 'lucide-react';
import { api } from '../api.js';
import { Markdown } from './common.jsx';
import { navigate, toast, toastError } from '../util.js';

const dayOf = (t) => new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });

function Point({ p, day, onGone, fyi }) {
  const [taskAdded, setTaskAdded] = useState(false);
  const ignore = (msg = 'Set aside') => api.post('/api/ai/brief/ignore', { day, key: p.key }).then(() => {
    onGone(p.key);
    toast(msg, { action: { label: 'Undo', onClick: () => api.post('/api/ai/brief/ignore', { day, key: p.key, ignored: false }).then(() => onGone(p.key, true)) } });
  }).catch(toastError);
  // Handled: its emails leave the brief and the open lists (as "Done" there), and the point goes with them.
  const done = async () => {
    try {
      for (const m of p.emails.filter((x) => !x.handled)) await api.post(`/api/messages/${m.id}/dismiss`, {});
      await api.post('/api/ai/brief/ignore', { day, key: p.key });
      onGone(p.key);
      toast('Done', { action: { label: 'Undo', onClick: async () => {
        for (const m of p.emails.filter((x) => !x.handled)) await api.post(`/api/messages/${m.id}/dismiss`, { dismissed: false });
        await api.post('/api/ai/brief/ignore', { day, key: p.key, ignored: false }); onGone(p.key, true);
      } } });
    } catch (e) { toastError(e); }
  };
  const addTask = async () => {
    try {
      const t = await api.post('/api/tasks', { title: (p.task || p.text).slice(0, 200), notes: p.task ? p.text : '', sourceMessageId: p.emails[0]?.id, due: p.due ? new Date(`${p.due}T17:00`).getTime() : undefined });
      setTaskAdded(true);
      toast(`Task added: ${t.title}`, { action: { label: 'Undo', onClick: () => api.del(`/api/tasks/${t.id}`).then(() => setTaskAdded(false)) } });
    } catch (e) { toastError(e); }
  };
  const canTask = !fyi && !p.tasks.length && !taskAdded;
  return (
    <div className="brief-point">
      <div className="brief-point-text">{p.text}</div>
      {(p.emails.length > 0 || p.events.length > 0 || p.tasks.length > 0) && <div className="brief-point-refs">
        {p.emails.map((m) => <button key={`m${m.id}`} className={`chip clickable ${m.handled ? 'faint' : ''}`} title={`Open the email${m.handled ? ' (handled)' : ''}`} onClick={() => navigate(`#/mail/unified/${m.id}`)}><Mail size={11} /> <span className="truncate">{m.from}: {m.subject || '(no subject)'}</span></button>)}
        {p.events.map((e) => <button key={`e${e.id}`} className="chip clickable" title="Open the calendar" onClick={() => navigate('#/calendar')}><Calendar size={11} /> <span className="truncate">{e.title} · {dayOf(e.start)}</span></button>)}
        {p.tasks.map((t) => <button key={`t${t.id}`} className="chip clickable" title="Open tasks" onClick={() => navigate('#/tasks')}><CheckSquare size={11} /> <span className="truncate">{t.title}</span></button>)}
      </div>}
      <div className="brief-point-actions">
        {canTask && <button className="btn sm ghost" title={`Add “${p.task || p.text}” to your tasks${p.due ? `, due ${p.due}` : ''}`} onClick={addTask}><ListPlus size={13} /> Add task</button>}
        {taskAdded && <span className="small faint"><Check size={12} /> Task added</span>}
        {p.emails.some((m) => !m.handled) && <button className="btn sm ghost" title="Handled: the emails leave the brief and the open lists (they stay in your mailbox)" onClick={done}><Check size={13} /> Done</button>}
        <button className="btn sm ghost" title="Not important: no longer in the brief" onClick={() => ignore()}><EyeOff size={13} /> Ignore</button>
      </div>
    </div>
  );
}

/** brief: { key, items: {overview, headsUp, fyi} } or an older one with only Markdown `content`. */
export default function BriefPoints({ brief, compact = false }) {
  const [gone, setGone] = useState(() => new Set());
  if (!brief) return null;
  if (!brief.items) return brief.content ? <Markdown text={brief.content} onOpenMessage={(id) => navigate(`#/mail/unified/${id}`)} /> : null;
  const onGone = (key, back = false) => setGone((g) => { const n = new Set(g); if (back) n.delete(key); else n.add(key); return n; });
  const heads = brief.items.headsUp.filter((p) => !gone.has(p.key)), fyi = brief.items.fyi.filter((p) => !gone.has(p.key));
  return (
    <div className={`brief-points ${compact ? 'compact' : ''}`}>
      {brief.items.overview && <p className="brief-overview">{brief.items.overview}</p>}
      {heads.length > 0 && <><h4>Heads-up</h4>{heads.map((p) => <Point key={p.key} p={p} day={brief.key} onGone={onGone} />)}</>}
      {fyi.length > 0 && <><h4>FYI</h4>{fyi.map((p) => <Point key={p.key} p={p} day={brief.key} onGone={onGone} fyi />)}</>}
    </div>
  );
}
