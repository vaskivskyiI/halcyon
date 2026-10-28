import { useEffect, useState } from 'react';
import { Calendar as CalendarIcon, ListTodo, Users, Eye, EyeOff, Pencil, Star, Trash2, FolderInput, Cloud, HardDrive, Link2, Lock } from 'lucide-react';
import { api } from '../api.js';
import { toast, toastError, navigate } from '../util.js';
import { Modal, Spinner } from '../components/common.jsx';

// Every calendar, task list and address book in one place — of all spaces, hidden ones too: show again, hide, rename,
// make default, move everything from one kept in Halcyon to a synced one, delete what is kept in Halcyon.
const KINDS = {
  calendar: { title: 'Calendars', icon: CalendarIcon, url: '/api/calendars', move: 'move-events', items: 'events', count: (x) => x.events, event: 'calendar' },
  taskList: { title: 'Task lists', icon: ListTodo, url: '/api/task-lists', move: 'move-tasks', items: 'tasks', count: (x) => x.total, event: 'tasks' },
  addressBook: { title: 'Address books', icon: Users, url: '/api/address-books', move: 'move-contacts', items: 'contacts', count: (x) => x.contacts, event: 'contacts' },
};
const fromServer = (x) => x.source === 'caldav' || x.source === 'carddav';

export default function CalendarsTasks() {
  const [data, setData] = useState(null);
  const [moving, setMoving] = useState(null);
  const load = () => Promise.all(Object.values(KINDS).map((k) => api.get(`${k.url}?all=1`)))
    .then(([calendar, taskList, addressBook]) => setData({ calendar, taskList, addressBook })).catch(toastError);
  useEffect(() => { load(); }, []);
  if (!data) return <div className="settings-section"><Spinner /></div>;

  const act = async (fn, msg) => { try { const r = await fn(); if (msg) toast(typeof msg === 'function' ? msg(r) : msg); await load(); } catch (e) { toastError(e); } };
  const path = (kind, x) => `${KINDS[kind].url}/${x.id}`;
  const rename = (kind, x) => { const n = prompt('Name', x.name); if (n?.trim() && n.trim() !== x.name) act(() => api.patch(path(kind, x), { name: n.trim() })); };
  const setHidden = (kind, x, hidden) => act(() => api.patch(path(kind, x), { hidden }), hidden ? `“${x.name}” hidden — it stays on its server and can be shown again here` : `“${x.name}” is shown again`);
  const remove = (kind, x) => {
    const k = KINDS[kind], n = k.count(x) || 0;
    const text = x.source === 'subscription' ? `Unsubscribe from “${x.name}”? You can subscribe again with its link.`
      : `Delete “${x.name}”${n ? ` and its ${n} ${k.items}` : ''}? It is kept in Halcyon only, so ${n ? 'they are' : 'it is'} not anywhere else.${n && k.move ? '\n\nTo keep them, use “Move all to…” first.' : ''}`;
    if (confirm(text)) act(() => api.del(path(kind, x)), `“${x.name}” deleted`);
  };

  const Section = ({ kind }) => {
    const k = KINDS[kind], list = data[kind];
    const writable = list.filter((x) => !x.readonly && !x.hidden);
    return (<>
      <h3 className="row" style={{ gap: 6 }}><k.icon size={16} /> {k.title}</h3>
      {list.map((x) => {
        const n = k.count(x) || 0;
        const targets = writable.filter((t) => t.id !== x.id && fromServer(t));
        return (
          <div key={x.id} className={`card item-card ${x.hidden ? 'faded' : ''}`}>
            {x.color && <span style={{ width: 10, height: 10, borderRadius: 5, background: x.color, flex: 'none' }} />}
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="truncate">{x.name}
                {x.isDefault && <span className="chip" style={{ marginLeft: 6 }}>default</span>}
                {x.hidden && <span className="chip" style={{ marginLeft: 6 }}>hidden</span>}</div>
              <div className="small faint truncate">
                {fromServer(x) ? <Cloud size={11} /> : x.source === 'local' ? <HardDrive size={11} /> : <Link2 size={11} />} {x.origin}
                {x.readonly && <> · <Lock size={10} /> read-only</>} · {n} {k.items}{x.space ? ` · space ${x.space}` : ''}</div>
            </div>
            <button className="icon-btn" title="Rename" onClick={() => rename(kind, x)}><Pencil size={14} /></button>
            {!x.readonly && !x.isDefault && <button className="icon-btn" title="Make it the default (new ones go here)" onClick={() => act(() => api.patch(path(kind, x), { isDefault: true }), `New ${k.items} now go to “${x.name}”`)}><Star size={14} /></button>}
            {k.move && x.source === 'local' && n > 0 && targets.length > 0 && <button className="btn sm" onClick={() => setMoving({ kind, from: x, to: targets[0].id, targets })}><FolderInput size={13} /> Move all to…</button>}
            {fromServer(x) || x.sourceId
              ? <button className="btn sm ghost" title={x.hidden ? 'Show it again in Halcyon' : 'Hide it in Halcyon — it stays on its server and keeps syncing'} onClick={() => setHidden(kind, x, !x.hidden)}>
                {x.hidden ? <><Eye size={13} /> Show</> : <><EyeOff size={13} /> Hide</>}</button>
              : <button className="icon-btn danger" title={x.source === 'subscription' ? 'Unsubscribe' : 'Delete (kept in Halcyon only)'} onClick={() => remove(kind, x)}><Trash2 size={14} /></button>}
          </div>);
      })}
    </>);
  };

  const doMove = async () => {
    const { kind, from, to } = moving;
    const k = KINDS[kind], target = moving.targets.find((t) => t.id === to);
    try {
      const r = await api.post(`${k.url}/${from.id}/${k.move}`, { to });
      setMoving(null);
      await load();
      const left = r.skipped;
      // Everything that was not moved is already in the target (same UID): the local one can go.
      if (confirm(`${r.moved} ${k.items} moved to “${target.name}”${r.collected ? ` (and ${r.collected} addresses collected from your mail, kept in Halcyon for suggestions)` : ''}${left ? `; ${left} were already there` : ''}.\n\nDelete the now ${left ? 'redundant' : 'empty'} “${from.name}”${left ? ` (its ${left} remaining ${k.items} are copies of ones in “${target.name}”)` : ''}?`)) {
        await api.del(`${k.url}/${from.id}`);
        toast(`“${from.name}” deleted`);
        await load();
      }
    } catch (e) { toastError(e); }
  };

  return (
    <div className="settings-section">
      <div><h2>Calendars &amp; tasks</h2>
        <div className="muted">All calendars, task lists and address books, of every space. Ones from a server (<Cloud size={12} style={{ verticalAlign: -1 }} /> synced) can be hidden and shown again — they stay on the server.
          Ones kept in Halcyon only (<HardDrive size={12} style={{ verticalAlign: -1 }} />) can be moved to a synced one and deleted. Which space each belongs to: <a href="#/settings/spaces" onClick={(e) => { e.preventDefault(); navigate('#/settings/spaces'); }}>Spaces</a>.</div></div>
      <Section kind="calendar" />
      <Section kind="taskList" />
      <Section kind="addressBook" />
      {moving && (
        <Modal title={`Move all ${KINDS[moving.kind].items} of “${moving.from.name}”`} onClose={() => setMoving(null)} footer={<>
          <button className="btn ghost" onClick={() => setMoving(null)}>Cancel</button>
          <button className="btn primary" onClick={doMove}><FolderInput size={14} /> Move</button>
        </>}>
          <div style={{ display: 'grid', gap: 10 }}>
            <label className="field">To
              <select className="input" value={moving.to} onChange={(e) => setMoving({ ...moving, to: Number(e.target.value) })}>
                {moving.targets.map((t) => <option key={t.id} value={t.id}>{t.name} — {t.origin}</option>)}
              </select></label>
            <div className="small muted">They are saved on that server{moving.kind === 'calendar' ? ' (no invitations are sent to anyone)' : ''}. Any it already has ({moving.kind === 'calendar' ? 'the same event' : moving.kind === 'taskList' ? 'the same task' : 'the same person, by UID or email address'}, e.g. imported from there earlier) is skipped.
              {moving.kind === 'addressBook' && ' Addresses Halcyon collected from your mail (for suggestions while writing) move along but are not uploaded as contacts.'} Nothing is deleted — afterwards you can delete “{moving.from.name}”.</div>
          </div>
        </Modal>
      )}
    </div>
  );
}
