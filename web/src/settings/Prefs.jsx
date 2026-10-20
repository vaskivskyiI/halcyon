import { useEffect, useState } from 'react';
import { Plus, Trash2, Pencil } from 'lucide-react';
import { api } from '../api.js';
import { store } from '../store.js';
import { saveSettings, loadLabels } from '../data.js';
import { Switch, Modal } from '../components/common.jsx';
import { toast, toastError } from '../util.js';

const useSettings = () => store.use((s) => s.settings);
const save = (patch) => saveSettings(patch).catch(toastError);

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
    </div>
  );
}

export function Notifications() {
  const s = useSettings();
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  return (
    <div className="settings-section">
      <h2>Notifications</h2>
      {perm !== 'granted' && <div className="notice warn" style={{ margin: 0 }}>Desktop notifications are {perm}. <button className="btn sm" onClick={() => Notification.requestPermission().then(() => location.reload())}>Allow notifications</button></div>}
      <Switch label="New mail" checked={s.notifications.newMail} onChange={(v) => save({ notifications: { newMail: v } })} />
      <Switch label="Only notify for important mail" hint="Uses AI priority — no notifications for newsletters and promotions" checked={s.notifications.onlyImportant} onChange={(v) => save({ notifications: { onlyImportant: v } })} />
      <Switch label="Event and task reminders" checked={s.notifications.reminders} onChange={(v) => save({ notifications: { reminders: v } })} />
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
        <label className="field">Theme<select className="input" value={s.ui.theme} onChange={(e) => save({ ui: { theme: e.target.value } })}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
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
        <div><button className="btn" onClick={async () => { await api.post('/api/auth/logout'); location.reload(); }}>Sign out</button></div>
      </>}
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
