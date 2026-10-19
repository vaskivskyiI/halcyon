import { useState } from 'react';
import { Plus, RefreshCw, Trash2, Pencil, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import { api } from '../api.js';
import { store } from '../store.js';
import { loadAccounts, loadFolders } from '../data.js';
import { Modal, Spinner, Switch } from '../components/common.jsx';
import { toast, toastError, fmtListDate } from '../util.js';

export default function Accounts() {
  const accounts = store.use((s) => s.accounts);
  const [editing, setEditing] = useState(null);
  return (
    <div className="settings-section">
      <div className="row"><div className="grow"><h2>Email accounts</h2><div className="muted">Connect any IMAP/SMTP mailbox — Gmail, Microsoft 365, iCloud, Fastmail, your company server, …</div></div>
        <button className="btn primary" onClick={() => setEditing({})}><Plus size={15} /> Add account</button></div>
      {accounts.map((a) => (
        <div key={a.id} className="card item-card">
          <span className="status-dot" style={{ background: a.syncState === 'error' ? 'var(--danger)' : a.syncState === 'idle' ? 'var(--success)' : 'var(--warning)' }} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{a.displayName ? `${a.displayName} · ` : ''}{a.email}</div>
            <div className="small muted truncate">{a.imap.host} · {a.authType.startsWith('oauth') ? 'OAuth' : 'password'} · {a.syncState}{a.lastSyncAt ? ` · last sync ${fmtListDate(a.lastSyncAt)}` : ''}</div>
            {a.syncError && <div className="small error-text"><AlertTriangle size={12} /> {a.syncError}</div>}
            {(a.caldavUrl || a.carddavUrl) && <div className="small faint">{a.caldavUrl && 'CalDAV'}{a.caldavUrl && a.carddavUrl && ' + '}{a.carddavUrl && 'CardDAV'} sync enabled</div>}
          </div>
          <button className="icon-btn" title="Sync now" onClick={() => api.post(`/api/accounts/${a.id}/sync`).then(() => toast('Re-syncing…'))}><RefreshCw size={16} /></button>
          <button className="icon-btn" title="Edit" onClick={() => setEditing(a)}><Pencil size={16} /></button>
          <button className="icon-btn" title="Remove" onClick={async () => { if (confirm(`Remove ${a.email} from Halcyon? Mail stays on the server.`)) { await api.del(`/api/accounts/${a.id}`); loadAccounts(); loadFolders(); } }}><Trash2 size={16} /></button>
        </div>
      ))}
      {!accounts.length && <div className="card empty">No accounts yet. Add your first mailbox to get started.</div>}
      {editing && <AccountEditor account={editing.id ? editing : null} onClose={() => setEditing(null)} />}
    </div>
  );
}

function AccountEditor({ account, onClose }) {
  const oauth = store.use((s) => s.oauth);
  const [step, setStep] = useState(account ? 'details' : 'email');
  const [f, setF] = useState(() => account ? {
    email: account.email, displayName: account.displayName || '', name: account.name || '', signatureHtml: account.signatureHtml || '',
    imap: { ...account.imap, password: '' }, smtp: { ...account.smtp, password: '' }, caldavUrl: account.caldavUrl || '', carddavUrl: account.carddavUrl || '',
    davUser: account.davUser || '', davPassword: '', syncEnabled: account.syncEnabled, aliases: account.aliases || [],
  } : { email: '', displayName: '', password: '', imap: { host: '', port: 993, secure: true, user: '' }, smtp: { host: '', port: 465, secure: true, user: '' }, caldavUrl: '', carddavUrl: '', signatureHtml: '' });
  const [disc, setDisc] = useState(null);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState(null);
  const set = (path, v) => setF((x) => { const n = structuredClone(x); const ks = path.split('.'); let o = n; ks.slice(0, -1).forEach((k) => (o = o[k])); o[ks.at(-1)] = v; return n; });

  const discover = async () => {
    setBusy(true);
    try {
      const d = await api.get(`/api/accounts/discover?email=${encodeURIComponent(f.email)}`);
      setDisc(d);
      setF((x) => ({ ...x, imap: { ...d.imap, user: f.email }, smtp: { ...d.smtp, user: f.email }, caldavUrl: d.caldav || '', carddavUrl: d.carddav || '' }));
      setStep('password');
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };

  const body = () => {
    const b = { ...f };
    if (!account) { b.imap = { ...f.imap, password: f.password }; b.smtp = { ...f.smtp, password: f.password }; }
    else { if (!f.imap.password) delete b.imap.password; if (!f.smtp.password) delete b.smtp.password; }
    return b;
  };

  const runTest = async () => {
    setBusy(true); setTest(null);
    try { const r = await api.post('/api/accounts/test', { ...body(), id: account?.id }); setTest(r); return r; } catch (e) { toastError(e); return null; } finally { setBusy(false); }
  };

  const save = async () => {
    if (!account) {
      const r = await runTest();
      if (!r?.imap?.ok || !r?.smtp?.ok) { setStep('details'); return; }
    }
    setBusy(true);
    try {
      if (account) await api.patch(`/api/accounts/${account.id}`, body()); else await api.post('/api/accounts', body());
      toast(account ? 'Account updated' : 'Account added — syncing your mail…');
      await loadAccounts(); loadFolders(); onClose();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };

  const startOAuth = (provider) => {
    const w = window.open(api.url(`/api/oauth/${provider}/start${account ? `?accountId=${account.id}` : ''}`), 'oauth', 'width=520,height=680');
    const on = (e) => { if (e.data?.type === 'halcyon-oauth') { window.removeEventListener('message', on); loadAccounts(); loadFolders(); onClose(); } };
    window.addEventListener('message', on);
    const t = setInterval(() => { if (w?.closed) { clearInterval(t); loadAccounts(); loadFolders(); } }, 1000);
  };

  const TestResult = () => test && (
    <div className="card" style={{ padding: 10 }}>
      {['imap', 'smtp'].map((k) => <div key={k} className="row small">{test[k]?.ok ? <CheckCircle2 size={15} color="var(--success)" /> : <XCircle size={15} color="var(--danger)" />}<b>{k.toUpperCase()}</b>{test[k]?.ok ? (k === 'imap' ? `connected · ${test.imap.folders} folders` : 'connected') : <span className="error-text">{test[k]?.error}</span>}</div>)}
    </div>
  );

  const footer = step === 'email'
    ? <><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!/@/.test(f.email) || busy} onClick={discover}>{busy && <Spinner size={14} />} Continue</button></>
    : <><button className="btn" onClick={runTest} disabled={busy}>{busy && <Spinner size={14} />} Test connection</button><span className="grow" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>{account ? 'Save' : 'Add account'}</button></>;

  return (
    <Modal title={account ? `Edit ${account.email}` : 'Add email account'} onClose={onClose} wide footer={footer}>
      {step === 'email' && <>
        <label className="field">Email address<input className="input" type="email" autoFocus value={f.email} onChange={(e) => set('email', e.target.value.trim())} onKeyDown={(e) => e.key === 'Enter' && /@/.test(f.email) && discover()} /></label>
        <label className="field">Your name (shown to recipients)<input className="input" value={f.displayName} onChange={(e) => set('displayName', e.target.value)} /></label>
        {(oauth.google || oauth.microsoft) && <div className="row">{oauth.google && <button className="btn" onClick={() => startOAuth('google')}>Sign in with Google</button>}{oauth.microsoft && <button className="btn" onClick={() => startOAuth('microsoft')}>Sign in with Microsoft</button>}</div>}
      </>}
      {step === 'password' && <>
        <div className="small muted">Settings found ({disc?.source}): IMAP {f.imap.host}:{f.imap.port} · SMTP {f.smtp.host}:{f.smtp.port}. <a href="#" onClick={(e) => { e.preventDefault(); setStep('details'); }}>Edit manually</a></div>
        {disc?.note && <div className="notice warn" style={{ margin: 0 }}>{disc.note}</div>}
        {disc?.oauth && oauth[disc.oauth] && <button className="btn" onClick={() => startOAuth(disc.oauth)}>Sign in with {disc.oauth === 'google' ? 'Google' : 'Microsoft'} instead</button>}
        <label className="field">Password / app password<input className="input" type="password" autoFocus value={f.password} onChange={(e) => set('password', e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} /></label>
        <TestResult />
      </>}
      {step === 'details' && <>
        <div className="form-grid">
          <label className="field">Email<input className="input" value={f.email} onChange={(e) => set('email', e.target.value)} disabled={!!account} /></label>
          <label className="field">Display name<input className="input" value={f.displayName} onChange={(e) => set('displayName', e.target.value)} /></label>
          {!account && <label className="field full">Password<input className="input" type="password" value={f.password} onChange={(e) => set('password', e.target.value)} /></label>}
        </div>
        {['imap', 'smtp'].map((k) => (
          <div key={k}><h3 style={{ margin: '6px 0' }}>{k === 'imap' ? 'Incoming (IMAP)' : 'Outgoing (SMTP)'}</h3>
            <div className="form-grid">
              <label className="field">Server<input className="input" value={f[k].host} onChange={(e) => set(`${k}.host`, e.target.value)} /></label>
              <div className="row"><label className="field grow">Port<input className="input" type="number" value={f[k].port} onChange={(e) => set(`${k}.port`, Number(e.target.value))} /></label>
                <label className="field">Security<select className="input" value={f[k].secure ? 'ssl' : 'starttls'} onChange={(e) => set(`${k}.secure`, e.target.value === 'ssl')}><option value="ssl">SSL/TLS</option><option value="starttls">STARTTLS / none</option></select></label></div>
              <label className="field">Username<input className="input" value={f[k].user || ''} placeholder={f.email} onChange={(e) => set(`${k}.user`, e.target.value)} /></label>
              {account && <label className="field">Password (leave empty to keep)<input className="input" type="password" value={f[k].password} onChange={(e) => set(`${k}.password`, e.target.value)} /></label>}
            </div>
          </div>
        ))}
        <TestResult />
        <h3 style={{ margin: '6px 0' }}>Calendar & contacts sync (optional)</h3>
        <div className="form-grid">
          <label className="field full">CalDAV URL<input className="input" placeholder="https://cloud.example.com/remote.php/dav" value={f.caldavUrl} onChange={(e) => set('caldavUrl', e.target.value)} /></label>
          <label className="field full">CardDAV URL<input className="input" placeholder="https://cloud.example.com/remote.php/dav" value={f.carddavUrl} onChange={(e) => set('carddavUrl', e.target.value)} /></label>
          <label className="field">DAV username (default: email)<input className="input" value={f.davUser} onChange={(e) => set('davUser', e.target.value)} /></label>
          <label className="field">DAV password (default: mail password)<input className="input" type="password" value={f.davPassword || ''} onChange={(e) => set('davPassword', e.target.value)} /></label>
        </div>
        {account && <>
          <h3 style={{ margin: '6px 0' }}>Signature</h3>
          <div className="input editor" contentEditable suppressContentEditableWarning style={{ minHeight: 90, height: 'auto' }} dangerouslySetInnerHTML={{ __html: f.signatureHtml }} onBlur={(e) => set('signatureHtml', e.currentTarget.innerHTML)} />
          <label className="field">Aliases / send-as addresses (comma separated)<input className="input" value={(f.aliases || []).map((a) => a.address || a).join(', ')} onChange={(e) => set('aliases', e.target.value.split(',').map((x) => x.trim()).filter(Boolean).map((address) => ({ address })))} /></label>
          <Switch label="Sync this account" checked={f.syncEnabled} onChange={(v) => set('syncEnabled', v)} />
        </>}
      </>}
    </Modal>
  );
}
