import { useState } from 'react';
import { HardDrive } from 'lucide-react';
import { api } from '../api.js';
import { toast, toastError } from '../util.js';

const seen = (key) => { try { return localStorage.getItem(key) === '1'; } catch { return false; } };

const KIND = {
  calendar: { what: 'events', url: '/api/calendars', move: 'move-events', where: 'your calendar server' },
  taskList: { what: 'tasks', url: '/api/task-lists', move: 'move-tasks', where: 'your calendar server' },
  addressBook: { what: 'contacts', url: '/api/address-books', move: 'move-contacts', where: 'your contacts server' },
};

/**
 * The default calendar / task list / address book is kept only in Halcyon while a synced one (on the account's CalDAV server) exists:
 * new events / tasks would never reach the server. Offers to make the synced one the default and to move what is in
 * the local one there (what the server already has is skipped; nothing is deleted). "Keep it" hides this on the device.
 * kind: 'calendar' | 'taskList'; items: { id, name, source, readonly, isDefault, origin }.
 */
export default function LocalDefault({ kind, items, reload }) {
  const cal = kind === 'calendar', K = KIND[kind];
  const key = `halcyon.localDefaultOk.${kind}`;
  const def = items.find((x) => x.isDefault);
  const synced = items.filter((x) => (x.source === 'caldav' || x.source === 'carddav') && !x.readonly && !x.hidden);
  const [to, setTo] = useState(null);
  const [hidden, setHidden] = useState(() => seen(key));
  const [busy, setBusy] = useState(false);
  if (hidden || !def || def.source !== 'local' || !synced.length) return null;
  const target = synced.find((x) => x.id === to) || synced[0];
  const what = K.what;
  const makeDefault = async () => {
    try { await api.patch(`${K.url}/${target.id}`, { isDefault: true }); toast(`New ${what} now go to “${target.name}”`); reload(); } catch (e) { toastError(e); }
  };
  const move = async () => {
    if (!confirm(`Move the ${what} of “${def.name}” to “${target.name}” (${target.origin})?\n\nThey will be saved on that server${cal ? ' (without sending invitations to anyone)' : ''}${kind === 'addressBook' ? ' — addresses collected from your mail move along but are not uploaded' : ''}. ${what[0].toUpperCase()}${what.slice(1)} it already has are skipped; nothing is deleted.`)) return;
    setBusy(true);
    try {
      const r = await api.post(`${K.url}/${def.id}/${K.move}`, { to: target.id });
      toast(`${r.moved} ${what} moved to “${target.name}”${r.skipped ? ` · ${r.skipped} already there (left in “${def.name}”)` : ''}`);
      reload();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <div className="notice local-default small">
      <div className="row" style={{ gap: 6, alignItems: 'flex-start' }}><HardDrive size={14} style={{ flex: 'none', marginTop: 2 }} />
        <span>New {what} go to <b>“{def.name}”</b>, which is kept only in Halcyon — they do not reach {K.where}.</span></div>
      {synced.length > 1 && <select className="input" value={target.id} onChange={(e) => setTo(Number(e.target.value))}>
        {synced.map((x) => <option key={x.id} value={x.id}>{x.name} — {x.origin}</option>)}</select>}
      {synced.length === 1 && <div className="faint">Synced: “{target.name}” — {target.origin}</div>}
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <button className="btn sm primary" onClick={makeDefault}>Make it the default</button>
        <button className="btn sm" disabled={busy} onClick={move}>Move {what} there</button>
        <button className="btn sm ghost" onClick={() => { try { localStorage.setItem(key, '1'); } catch { /* private mode */ } setHidden(true); }}>Keep as it is</button>
      </div>
    </div>);
}
