import { useEffect, useState } from 'react';
import { Plus, Trash2, Pencil } from 'lucide-react';
import { api } from '../api.js';
import { store } from '../store.js';
import { saveSettings, loadLabels } from '../data.js';
import { Switch, Modal, Spinner } from '../components/common.jsx';
import { toast, toastError } from '../util.js';
import { pushState, enablePush, disablePush, resetPushCache } from '../push.js';

const useSettings = () => store.use((s) => s.settings);
const save = (patch) => saveSettings(patch).catch(toastError);

const SWIPE_OPTIONS = [['read', 'Read / unread'], ['archive', 'Archive'], ['trash', 'Delete'], ['flag', 'Flag'], ['snooze', 'Snooze until tomorrow'], ['none', 'Nothing']].map(([v, l]) => <option key={v} value={v}>{l}</option>);
const STEP_KINDS = [['markRead', 'Mark as read'], ['markUnread', 'Mark as unread'], ['flag', 'Flag'], ['followUp', 'Follow up (task)'], ['label', 'Add label'], ['category', 'Add to my category'], ['archive', 'Archive'], ['move', 'Move to folder'], ['trash', 'Delete']];

/** Quick steps: one click for a set of actions (e.g. "Done" = mark read + archive), in the reader and the list menu. */
function QuickSteps() {
  const steps = store.use((x) => x.quickSteps) || [];
  const labels = store.use((x) => x.labels);
  const folders = store.use((x) => x.folders);
  const [edit, setEdit] = useState(null);
  const reload = () => api.get('/api/quick-steps').then((q) => store.set({ quickSteps: q })).catch(() => {});
  const save2 = async () => {
    try { if (edit.id) await api.patch(`/api/quick-steps/${edit.id}`, edit); else await api.post('/api/quick-steps', edit); setEdit(null); reload(); toast('Quick step saved'); } catch (e) { toastError(e); }
  };
  const allFolders = (folders.accounts || []).flatMap((a) => a.folders.map((f) => ({ ...f, account: a.email })));
  return <>
    <h3>Quick steps</h3>
    <div className="small muted" style={{ marginTop: -8 }}>One click for several actions — e.g. “Done”: mark as read and archive; “To accountant”: label and move. Shown in the reader (the first three) and in the right-click menu.</div>
    {steps.map((q) => <div key={q.id} className="row small"><b>{q.name}</b><span className="grow faint">{q.actions.map((a) => STEP_KINDS.find((k) => k[0] === a.type)?.[1]).join(' → ')}</span>
      <button className="btn sm" onClick={() => setEdit({ ...q })}>Edit</button><button className="icon-btn" title="Delete" onClick={() => api.del(`/api/quick-steps/${q.id}`).then(reload)}><Trash2 size={14} /></button></div>)}
    <div><button className="btn sm" onClick={() => setEdit({ name: '', actions: [{ type: 'markRead' }, { type: 'archive' }] })}><Plus size={14} /> New quick step</button></div>
    {edit && <Modal title={edit.id ? 'Edit quick step' : 'New quick step'} onClose={() => setEdit(null)} footer={<><button className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn primary" onClick={save2}>Save</button></>}>
      <label className="field">Name<input className="input" autoFocus value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="e.g. Done" /></label>
      {edit.actions.map((a, i) => (
        <div key={i} className="row" style={{ gap: 6 }}>
          <select className="input" value={a.type} onChange={(e) => setEdit({ ...edit, actions: edit.actions.map((x, j) => (j === i ? { type: e.target.value } : x)) })}>{STEP_KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          {a.type === 'move' && <select className="input" value={a.folderId || ''} onChange={(e) => setEdit({ ...edit, actions: edit.actions.map((x, j) => (j === i ? { ...x, folderId: Number(e.target.value) } : x)) })}><option value="">Folder…</option>{allFolders.map((f) => <option key={f.id} value={f.id}>{f.name} · {f.account}</option>)}</select>}
          {a.type === 'label' && <select className="input" value={a.labelId || ''} onChange={(e) => setEdit({ ...edit, actions: edit.actions.map((x, j) => (j === i ? { ...x, labelId: Number(e.target.value) } : x)) })}><option value="">Label…</option>{labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>}
          {a.type === 'category' && <select className="input" value={a.categoryId || ''} onChange={(e) => setEdit({ ...edit, actions: edit.actions.map((x, j) => (j === i ? { ...x, categoryId: Number(e.target.value) } : x)) })}><option value="">Category…</option>{(folders.custom || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
          {a.type === 'followUp' && <select className="input" value={a.days ?? ''} onChange={(e) => setEdit({ ...edit, actions: edit.actions.map((x, j) => (j === i ? { ...x, days: e.target.value === '' ? null : Number(e.target.value) } : x)) })}><option value="">No date</option><option value="0">Today</option><option value="1">Tomorrow</option><option value="7">In a week</option></select>}
          <button className="icon-btn" title="Remove" onClick={() => setEdit({ ...edit, actions: edit.actions.filter((_, j) => j !== i) })}><Trash2 size={14} /></button>
        </div>))}
      <div><button className="btn sm ghost" onClick={() => setEdit({ ...edit, actions: [...edit.actions, { type: 'markRead' }] })}><Plus size={14} /> Add action</button></div>
    </Modal>}
  </>;
}

export function MailPrefs() {
  const s = useSettings();
  const accounts = store.use((x) => x.accounts);
  return (
    <div className="settings-section">
      <h2>Mail</h2>
      <Switch label="Focused inbox" hint="Split the inbox into Focused and Other using AI priority" checked={s.mail.focusedInbox} onChange={(v) => save({ mail: { focusedInbox: v } })} />
      <Switch label="Conversation view" hint="Group messages into threads" checked={s.ui.conversationView} onChange={(v) => save({ ui: { conversationView: v } })} />
      <Switch label="Load remote images automatically" hint="Off protects against tracking pixels. Images from your contacts are always shown." checked={s.mail.loadRemoteImages} onChange={(v) => save({ mail: { loadRemoteImages: v } })} />
      {'registerProtocolHandler' in navigator && !window.halcyonDesktop && <div className="row"><button className="btn" onClick={() => { try { navigator.registerProtocolHandler('mailto', `${location.origin}${location.pathname}#/compose?url=%s`); toast('Confirm the prompt in your browser to open mailto: links in Halcyon'); } catch (e) { toastError(e); } }}>Use Halcyon for mailto: links in this browser</button></div>}
      <Switch label="Collect contacts automatically" hint="Add people you write to into Contacts → Auto-collected" checked={s.mail.autoCollectContacts} onChange={(v) => save({ mail: { autoCollectContacts: v } })} />
      <div className="form-grid">
        <label className="field">Undo send window<select className="input" value={s.mail.undoSendSeconds} onChange={(e) => save({ mail: { undoSendSeconds: Number(e.target.value) } })}>{[0, 5, 10, 20, 30, 60].map((n) => <option key={n} value={n}>{n ? `${n} seconds` : 'Off'}</option>)}</select></label>
        <label className="field">Mark as read<select className="input" value={s.mail.markReadAfterMs} onChange={(e) => save({ mail: { markReadAfterMs: Number(e.target.value) } })}><option value={0}>Immediately</option><option value={1500}>After 1.5 seconds</option><option value={5000}>After 5 seconds</option><option value={-1}>Never automatically</option></select></label>
        <label className="field">Default sending account<select className="input" value={s.mail.defaultAccountId || ''} onChange={(e) => save({ mail: { defaultAccountId: e.target.value ? Number(e.target.value) : null } })}><option value="">First account</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.email}</option>)}</select></label>
      </div>
      <h3>Swipe on touch screens</h3>
      <div className="form-grid">
        <label className="field">Swipe right<select className="input" value={s.ui.swipeRight || 'read'} onChange={(e) => save({ ui: { swipeRight: e.target.value } })}>{SWIPE_OPTIONS}</select></label>
        <label className="field">Swipe left<select className="input" value={s.ui.swipeLeft || 'archive'} onChange={(e) => save({ ui: { swipeLeft: e.target.value } })}>{SWIPE_OPTIONS}</select></label>
      </div>
      <QuickSteps />
    </div>
  );
}

export function Notifications() {
  const s = useSettings();
  const n = s.notifications;
  const accounts = store.use((x) => x.accounts).filter((a) => !a.owner);
  const shared = store.use((x) => x.shared) || [];
  const [push, setPush] = useState(null);
  const [devs, setDevs] = useState([]);
  const refresh = () => { pushState().then(setPush); api.get('/api/push/devices').then(setDevs).catch(() => {}); };
  useEffect(() => { refresh(); }, []);
  const mail = n.mail || (n.newMail === false ? 'none' : n.onlyImportant ? 'important' : 'all');
  const toggleIn = (key, id) => { const cur = (n[key] || []).map(Number); save({ notifications: { [key]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] } }); };
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  return (
    <div className="settings-section">
      <h2>Notifications</h2>
      <h3>This device</h3>
      {push?.supported ? <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        {push.on ? <><span className="chip ai">Push notifications are on</span><span className="small faint grow">also when Halcyon is closed</span>
          <button className="btn sm" onClick={() => api.post('/api/push/test').then((r) => toast(r.quiet ? 'Quiet hours now — nothing is shown' : 'Test sent')).catch(toastError)}>Send a test</button>
          <button className="btn sm ghost" onClick={async () => { await disablePush(); resetPushCache(); refresh(); }}>Turn off here</button></>
          : <><span className="small grow">Get notifications on this device even when Halcyon is closed (phone, browser, the Android app).</span>
            <button className="btn sm primary" onClick={async () => { try { await enablePush(); resetPushCache(); toast('Push notifications are on'); refresh(); } catch (e) { toastError(e); } }}>Turn on</button></>}
      </div> : push?.android ? <div className="small muted">{push.problem}</div> : <div className="small muted">{perm === 'granted' ? 'Notifications are shown while Halcyon is open.' : perm === 'unsupported' ? 'This app shows notifications while it runs.' : <>Notifications are {perm}. <button className="btn sm" onClick={() => Notification.requestPermission().then(refresh)}>Allow</button></>}</div>}
      {devs.length > 0 && <div className="small faint">Devices with push: {devs.map((d) => d.device || 'device').join(', ')}</div>}

      <h3>What notifies</h3>
      <label className="field" style={{ maxWidth: 420 }}>New mail<select className="input" value={mail} onChange={(e) => save({ notifications: { mail: e.target.value } })}>
        <option value="all">Every new email</option><option value="important">Only important mail (AI priority; with its summary)</option><option value="none">None</option></select></label>
      <Switch label="Event and task reminders" checked={n.reminders} onChange={(v) => save({ notifications: { reminders: v } })} />
      <Switch label="Sound" checked={n.sound !== false} onChange={(v) => save({ notifications: { sound: v } })} />
      <Switch label="Hide content on the lock screen" hint="Only “New email” — no sender, subject or text" checked={!!n.hideContent} onChange={(v) => save({ notifications: { hideContent: v } })} />

      <h3>Quiet hours</h3>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Switch label="No notifications between" checked={!!n.quiet?.enabled} onChange={(v) => save({ notifications: { quiet: { ...n.quiet, enabled: v } } })} />
        <label className="field">From<input className="input" type="time" value={n.quiet?.start || '22:00'} onChange={(e) => save({ notifications: { quiet: { ...n.quiet, start: e.target.value } } })} /></label>
        <label className="field">Until<input className="input" type="time" value={n.quiet?.end || '07:00'} onChange={(e) => save({ notifications: { quiet: { ...n.quiet, end: e.target.value } } })} /></label>
      </div>

      {(accounts.length > 1 || shared.length > 0) && <h3>From</h3>}
      {accounts.length > 1 && accounts.map((a) => <Switch key={a.id} label={a.email} checked={!(n.muteAccounts || []).map(Number).includes(a.id)} onChange={() => toggleIn('muteAccounts', a.id)} />)}
      {shared.map((x) => <Switch key={`s${x.id}`} label={`${x.name} (shared)`} checked={!(n.muteShared || []).map(Number).includes(x.id)} onChange={() => toggleIn('muteShared', x.id)} />)}
    </div>
  );
}

export function CalendarPrefs() {
  const s = useSettings();
  const c = s.calendar;
  return (
    <div className="settings-section">
      <h2>Calendar</h2>
      <div className="form-grid">
        <label className="field">Work day starts<input className="input" type="time" value={c.workStart} onChange={(e) => save({ calendar: { workStart: e.target.value } })} /></label>
        <label className="field">Work day ends<input className="input" type="time" value={c.workEnd} onChange={(e) => save({ calendar: { workEnd: e.target.value } })} /></label>
        <label className="field">Default event length (minutes)<input className="input" type="number" value={c.defaultDurationMin} onChange={(e) => save({ calendar: { defaultDurationMin: Number(e.target.value) } })} /></label>
        <label className="field">Default reminder (minutes before)<input className="input" type="number" value={c.defaultReminderMin} onChange={(e) => save({ calendar: { defaultReminderMin: Number(e.target.value) } })} /></label>
        <label className="field">Week starts on<select className="input" value={s.ui.weekStart} onChange={(e) => save({ ui: { weekStart: Number(e.target.value) } })}><option value={1}>Monday</option><option value={0}>Sunday</option><option value={6}>Saturday</option></select></label>
        <label className="field">Time zone<input className="input" value={c.timezone} disabled={c.tzAuto !== false} onChange={(e) => save({ calendar: { timezone: e.target.value } })} list="tzs" /></label>
        <label className="row small" style={{ alignSelf: 'end' }}><input type="checkbox" checked={c.tzAuto !== false} onChange={(e) => save({ calendar: { tzAuto: e.target.checked, ...(e.target.checked ? { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } : {}) } })} /> Use this device's time zone</label>
        <div className="small muted" style={{ gridColumn: '1 / -1' }}>
          Times written in emails (“tomorrow at 8”) are read in <b>{c.timezone}</b>; this device is in {Intl.DateTimeFormat().resolvedOptions().timeZone}
          {store.get().serverTimezone ? `, the server in ${store.get().serverTimezone}` : ''}.
        </div>
        <datalist id="tzs">{(Intl.supportedValuesOf?.('timeZone') || []).map((z) => <option key={z} value={z} />)}</datalist>
      </div>
    </div>
  );
}

export function Appearance() {
  const s = useSettings();
  return (
    <div className="settings-section">
      <h2>Appearance</h2>
      <div className="form-grid">
        <label className="field">Theme<select className="input" value={s.ui.theme} onChange={(e) => save({ ui: { theme: e.target.value } })}><option value="system">Automatic (as the device)</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
        <label className="field">Density<select className="input" value={s.ui.density} onChange={(e) => save({ ui: { density: e.target.value } })}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label>
        <label className="field">Language for AI summaries<select className="input" value={s.ui.language} onChange={(e) => save({ ui: { language: e.target.value } })}>{[['en', 'English'], ['sl', 'Slovenščina'], ['de', 'Deutsch'], ['fr', 'Français'], ['es', 'Español'], ['it', 'Italiano'], ['hr', 'Hrvatski'], ['uk', 'Українська'], ['pl', 'Polski']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      </div>
    </div>
  );
}

export function Labels() {
  const labels = store.use((s) => s.labels);
  const [name, setName] = useState('');
  const [color, setColor] = useState('#2563eb');
  return (
    <div className="settings-section">
      <h2>Labels</h2>
      <div className="row"><input className="input" placeholder="New label" value={name} onChange={(e) => setName(e.target.value)} /><input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        <button className="btn primary" disabled={!name} onClick={async () => { await api.post('/api/labels', { name, color }); setName(''); loadLabels(); }}><Plus size={15} /> Add</button></div>
      {labels.map((l) => (
        <div key={l.id} className="card item-card"><span className="status-dot" style={{ background: l.color, width: 12, height: 12 }} /><span className="grow">{l.name}</span>
          <input type="color" value={l.color} onChange={async (e) => { await api.patch(`/api/labels/${l.id}`, { color: e.target.value }); loadLabels(); }} />
          <button className="icon-btn" onClick={async () => { const n = prompt('Rename label', l.name); if (n) { await api.patch(`/api/labels/${l.id}`, { name: n }); loadLabels(); } }}><Pencil size={15} /></button>
          <button className="icon-btn" onClick={async () => { await api.del(`/api/labels/${l.id}`); loadLabels(); }}><Trash2 size={15} /></button></div>
      ))}
    </div>
  );
}

export function Templates() {
  const [list, setList] = useState([]);
  const [editing, setEditing] = useState(null);
  const load = () => api.get('/api/templates').then(setList);
  useEffect(() => { load(); }, []);
  return (
    <div className="settings-section">
      <div className="row"><h2 className="grow">Templates</h2><button className="btn primary" onClick={() => setEditing({ name: '', subject: '', bodyHtml: '' })}><Plus size={15} /> New template</button></div>
      <div className="muted" style={{ marginTop: -8 }}>Reusable messages, available from the composer's Templates menu.</div>
      {list.map((t) => <div key={t.id} className="card item-card"><div className="grow"><div style={{ fontWeight: 600 }}>{t.name}</div><div className="small muted truncate">{t.subject}</div></div>
        <button className="icon-btn" onClick={() => setEditing(t)}><Pencil size={15} /></button><button className="icon-btn" onClick={async () => { await api.del(`/api/templates/${t.id}`); load(); }}><Trash2 size={15} /></button></div>)}
      {editing && <Modal title={editing.id ? 'Edit template' : 'New template'} onClose={() => setEditing(null)} wide footer={<><button className="btn" onClick={() => setEditing(null)}>Cancel</button><button className="btn primary" onClick={async () => { if (editing.id) await api.patch(`/api/templates/${editing.id}`, editing); else await api.post('/api/templates', editing); setEditing(null); load(); }}>Save</button></>}>
        <label className="field">Name<input className="input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
        <label className="field">Subject (optional)<input className="input" value={editing.subject} onChange={(e) => setEditing({ ...editing, subject: e.target.value })} /></label>
        <div className="field">Body<div className="input editor" contentEditable suppressContentEditableWarning style={{ minHeight: 160, height: 'auto' }} dangerouslySetInnerHTML={{ __html: editing.bodyHtml }} onBlur={(e) => setEditing({ ...editing, bodyHtml: e.currentTarget.innerHTML })} /></div>
      </Modal>}
    </div>
  );
}

export function Security() {
  const [f, setF] = useState({ current: '', password: '' });
  const single = store.use((s) => s.singleUser);
  const readOnly = store.use((s) => s.readOnly);
  return (
    <div className="settings-section">
      <h2>Security</h2>
      <div className="muted">Account passwords and API keys are encrypted at rest (AES-256-GCM). Email HTML is sanitised and rendered in a sandbox; remote images are blocked unless the sender is a contact.</div>
      {!single && <>
        <h3>Change password</h3>
        <div className="form-grid">
          <label className="field">Current password<input className="input" type="password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></label>
          <label className="field">New password<input className="input" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
        </div>
        <div><button className="btn primary" onClick={async () => { try { await api.post('/api/auth/password', f); toast('Password changed'); setF({ current: '', password: '' }); } catch (e) { toastError(e); } }}>Change password</button></div>
        <h3>Session</h3>
        {readOnly ? <div className="notice">This session is read-only: the server refuses every change (sending, deleting, moving, marking, settings, AI actions). Sign out and sign in normally to make changes.</div>
          : <div className="muted small">Before letting someone else look at your mail (e.g. support), make this session read-only. It cannot be switched back — only signing out ends it. You can also choose “Read-only session” when signing in.</div>}
        <div className="row">
          {!readOnly && <button className="btn" onClick={async () => { if (!confirm('Make this session read-only? Nothing can be changed in it until you sign out.')) return; try { await api.post('/api/auth/read-only'); location.reload(); } catch (e) { toastError(e); } }}>Make this session read-only</button>}
          <button className="btn" onClick={async () => { await api.post('/api/auth/logout'); location.reload(); }}>Sign out</button>
        </div>
      </>}
    </div>
  );
}

/** Numbers about this installation (no mail content) to find what is slow, failing or inaccurate; copy to share. */
export function Diagnostics() {
  const [d, setD] = useState(null);
  const load = () => api.get('/api/diagnostics').then(setD).catch(toastError);
  useEffect(() => { load(); }, []);
  const text = d ? JSON.stringify(d, null, 2) : '';
  return (
    <div className="settings-section">
      <h2>Diagnostics</h2>
      <div className="muted">Counts and timings of this installation — sync, sending, AI analysis, open items, your corrections and how fast each part of the app responds. It contains no subjects, message text, names or addresses (they are removed from error messages too), so you can share it to get help.</div>
      <div className="row"><button className="btn" onClick={load}>Refresh</button>
        <button className="btn primary" disabled={!d} onClick={() => navigator.clipboard.writeText(text).then(() => toast('Copied')).catch(() => toast('Select the text and copy it', { kind: 'error' }))}>Copy</button></div>
      {d ? <pre className="diag">{text}</pre> : <Spinner size={18} />}
    </div>
  );
}

export function AdminUsers() {
  const [users, setUsers] = useState([]);
  const [f, setF] = useState({ email: '', name: '', password: '', isAdmin: false });
  const load = () => api.get('/api/admin/users').then(setUsers).catch(toastError);
  useEffect(() => { load(); }, []);
  return (
    <div className="settings-section">
      <h2>Users</h2>
      <div className="muted">Each user has their own accounts, AI providers, calendars and contacts.</div>
      <table className="simple"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th /></tr></thead><tbody>
        {users.map((u) => <tr key={u.id}><td>{u.name}</td><td>{u.email}</td><td>{u.is_admin ? 'Admin' : 'User'}</td><td><button className="icon-btn" onClick={async () => { if (confirm(`Delete ${u.email} and all their data?`)) { await api.del(`/api/admin/users/${u.id}`).catch(toastError); load(); } }}><Trash2 size={15} /></button></td></tr>)}
      </tbody></table>
      <h3>Add user</h3>
      <div className="form-grid">
        <label className="field">Name<input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="field">Email<input className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
        <label className="field">Initial password<input className="input" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
        <label className="row small" style={{ alignSelf: 'end' }}><input type="checkbox" checked={f.isAdmin} onChange={(e) => setF({ ...f, isAdmin: e.target.checked })} /> Administrator</label>
      </div>
      <div><button className="btn primary" onClick={async () => { try { await api.post('/api/admin/users', f); setF({ email: '', name: '', password: '', isAdmin: false }); load(); toast('User created'); } catch (e) { toastError(e); } }}>Create user</button></div>
    </div>
  );
}

const SHORTCUTS = [['c', 'Compose'], ['/', 'Search'], ['j / ↓', 'Next message'], ['k / ↑', 'Previous message'], ['r', 'Reply'], ['a', 'Reply all'], ['f', 'Forward'], ['e', 'Archive'], ['# / Delete', 'Delete'], ['!', 'Report spam'], ['s', 'Flag / unflag'], ['u', 'Mark read / unread'], ['x', 'Select'], ['Esc', 'Close / clear selection'], ['Ctrl+Enter', 'Send (composer)']];

export function About() {
  return (
    <div className="settings-section">
      <h2>About Halcyon</h2>
      <div className="muted">Version 1.0.0 — AI-native email, calendar and contacts for IMAP/SMTP, CalDAV and CardDAV. Runs in the browser, on your own Ubuntu server, or as a Windows desktop app.</div>
      <h3>Keyboard shortcuts</h3>
      <table className="simple"><tbody>{SHORTCUTS.map(([k, v]) => <tr key={k}><td style={{ width: 160 }}><code>{k}</code></td><td>{v}</td></tr>)}</tbody></table>
      <h3>Search operators</h3>
      <div className="small muted">from:, to:, subject:, has:attachment, is:unread / read / flagged / important / needsreply / snoozed, in:inbox / sent / archive / trash / &lt;folder&gt;, before:YYYY-MM-DD, after:, newer_than:7d, older_than:1y, label:, category:, account:. Plain words use full-text + semantic (meaning-based) search. Prefix with - to negate.</div>
    </div>
  );
}
