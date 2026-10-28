import { useState } from 'react';
import { HardDrive } from 'lucide-react';
import { api } from '../api.js';
import { toast, toastError } from '../util.js';

const seen = (key) => { try { return localStorage.getItem(key) === '1'; } catch { return false; } };

/**
 * The default calendar / task list is kept only in Halcyon while a synced one (on the account's CalDAV server) exists:
 * new events / tasks would never reach the server. Offers to make the synced one the default and to move what is in
 * the local one there (what the server already has is skipped; nothing is deleted). "Keep it" hides this on the device.
 * kind: 'calendar' | 'taskList'; items: { id, name, source, readonly, isDefault, origin }.
 */
export default function LocalDefault({ kind, items, reload }) {
  const cal = kind === 'calendar';
  const key = `halcyon.localDefaultOk.${kind}`;
  const def = items.find((x) => x.isDefault);
  const synced = items.filter((x) => x.source === 'caldav' && !x.readonly);
  const [to, setTo] = useState(null);
  const [hidden, setHidden] = useState(() => seen(key));
  const [busy, setBusy] = useState(false);
  if (hidden || !def || def.source !== 'local' || !synced.length) return null;
  const target = synced.find((x) => x.id === to) || synced[0];
  const what = cal ? 'events' : 'tasks';
  const makeDefault = async () => {
    try { await api.patch(cal ? `/api/calendars/${target.id}` : `/api/task-lists/${target.id}`, { isDefault: true }); toast(`New ${what} now go to “${target.name}”`); reload(); } catch (e) { toastError(e); }
  };
  const move = async () => {
    if (!confirm(`Move the ${what} of “${def.name}” to “${target.name}” (${target.origin})?\n\nThey will be saved on that server${cal ? ' (without sending invitations to anyone)' : ''}. ${cal ? 'Events' : 'Tasks'} it already has are skipped; nothing is deleted.`)) return;
    setBusy(true);
    try {
      const r = await api.post(cal ? `/api/calendars/${def.id}/move-events` : `/api/task-lists/${def.id}/move-tasks`, { to: target.id });
      toast(`${r.moved} ${what} moved to “${target.name}”${r.skipped ? ` · ${r.skipped} already there (left in “${def.name}”)` : ''}`);
      reload();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return (
    <div className="notice local-default small">
      <div className="row" style={{ gap: 6, alignItems: 'flex-start' }}><HardDrive size={14} style={{ flex: 'none', marginTop: 2 }} />
        <span>New {what} go to <b>“{def.name}”</b>, which is kept only in Halcyon — they do not reach your calendar server.</span></div>
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
