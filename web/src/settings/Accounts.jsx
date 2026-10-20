import { useEffect, useState } from 'react';
import { Plus, RefreshCw, Trash2, Pencil, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import { api } from '../api.js';
import { store } from '../store.js';
import { loadAccounts, loadFolders } from '../data.js';
import { Modal, Spinner, Switch } from '../components/common.jsx';
import { toast, toastError, fmtListDate } from '../util.js';

export default function Accounts() {
  const accounts = store.use((s) => s.accounts);
  const [editing, setEditing] = useState(null);
  const [status, setStatus] = useState({});
  const [tests, setTests] = useState({});
  const loadStatus = () => api.get('/api/accounts/status').then((l) => setStatus(Object.fromEntries(l.map((x) => [x.id, x])))).catch(() => {});
  useEffect(() => { loadStatus(); const t = setInterval(loadStatus, 10e3); return () => clearInterval(t); }, []);
  const test = async (a) => {
    setTests((t) => ({ ...t, [a.id]: { busy: true } }));
    try { const r = await api.post(`/api/accounts/${a.id}/test`); setTests((t) => ({ ...t, [a.id]: r })); loadStatus(); } catch (e) { setTests((t) => ({ ...t, [a.id]: { error: e.message } })); }
  };
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
            <AccountStatus st={status[a.id]} test={tests[a.id]} account={a} reload={loadStatus} />
            <label className="row small" style={{ marginTop: 6 }}>Download mail from
              <select className="input" style={{ width: 'auto', height: 28 }} value={a.syncHistory || '90'} onChange={async (e) => {
                const v = e.target.value;
                if (v === 'all' && !confirm('Download all mail from the server? For large mailboxes this can take a while and uses disk space; it runs in the background and never delays new mail.')) return;
                try { await api.patch(`/api/accounts/${a.id}`, { syncHistory: v }); loadAccounts(); setTimeout(loadStatus, 1500); } catch (err) { toastError(err); }
              }}>
                <option value="90">the last 90 days</option><option value="365">the last year</option><option value="all">all time</option>
              </select></label>
            {(a.caldavUrl || a.carddavUrl) && <div className="small faint">{a.caldavUrl && 'CalDAV'}{a.caldavUrl && a.carddavUrl && ' + '}{a.carddavUrl && 'CardDAV'} sync enabled</div>}
          </div>
          <button className="btn sm" title="Log in to the IMAP and SMTP servers with the stored settings (nothing is changed or sent)" onClick={() => test(a)} disabled={tests[a.id]?.busy}>{tests[a.id]?.busy ? <Spinner size={13} /> : <CheckCircle2 size={13} />} Test connection</button>
          <button className="icon-btn" title="Reconnect and sync now" onClick={() => api.post(`/api/accounts/${a.id}/sync`).then(() => { toast('Reconnecting and syncing…'); setTimeout(loadStatus, 2000); })}><RefreshCw size={16} /></button>
          <button className="icon-btn" title="Edit" onClick={() => setEditing(a)}><Pencil size={16} /></button>
          <button className="icon-btn" title="Remove" onClick={async () => { if (confirm(`Remove ${a.email} from Halcyon? Mail stays on the server.`)) { await api.del(`/api/accounts/${a.id}`); loadAccounts(); loadFolders(); } }}><Trash2 size={16} /></button>
        </div>
      ))}
      {!accounts.length && <div className="card empty">No accounts yet. Add your first mailbox to get started.</div>}
      {editing && <AccountEditor account={editing.id ? editing : null} onClose={() => setEditing(null)} />}
    </div>
  );
}

const OP_NAMES = { append: 'save a copy (sent mail / draft)', flags: 'flag change', move: 'move', delete: 'delete', createFolder: 'create folder', deleteByMessageId: 'replace draft' };
const ago = (t) => (t ? fmtListDate(t) : 'never');
const Line = ({ ok, warn, children }) => (
  <div className="small" style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
    <span className="status-dot" style={{ background: ok ? 'var(--success)' : warn ? 'var(--warning)' : 'var(--danger)', flex: 'none', transform: 'translateY(-1px)' }} /><span>{children}</span>
  </div>);

/** IMAP / SMTP health of one account, from /api/accounts/status and the last "Test connection". */
function AccountStatus({ st, test, account, reload }) {
  if (!st) return null;
  const imap = st.imap;
  return (
    <div className="acct-status">
      {!st.syncEnabled ? <Line warn>IMAP: sync is turned off for this account</Line>
        : imap?.connected ? <Line ok>IMAP: connected{imap.push ? ' · new mail is pushed instantly (IDLE)' : ' · checking periodically'} · last full sync {ago(imap.lastFullAt)}{imap.lastFullMs != null ? ` (took ${(imap.lastFullMs / 1000).toFixed(1)} s)` : ''}{imap.lastNewMailAt ? ` · new mail ${ago(imap.lastNewMailAt)}` : ''}</Line>
          : <Line warn={st.state !== 'error'}>IMAP: {st.state === 'connecting' ? 'connecting…' : 'not connected'}{imap?.lastError ? ` · last error ${ago(imap.lastErrorAt)}: ${imap.lastError}` : ''}</Line>}
      {st.mailbox && <Line ok={!st.mailbox.foldersPending} warn>
        Mail: {st.mailbox.downloaded.toLocaleString()} of {st.mailbox.onServer.toLocaleString()} messages on the server downloaded
        {st.mailbox.foldersPending ? ` · downloading older mail${st.historyFolders?.length ? ` (${st.historyFolders.join(', ')})` : ''}…` : st.history === 'all' ? ' · complete' : ` · older than ${st.history === '365' ? 'a year' : '90 days'} not downloaded`}</Line>}
      {imap && Object.entries(imap.folderErrors || {}).map(([f, e]) => <Line key={f}>Folder “{f}”: {e}</Line>)}
      {st.pendingOps > 0 && <Line warn>{st.pendingOps} change{st.pendingOps > 1 ? 's' : ''} (move, flag, delete…) waiting to be applied on the server</Line>}
      {st.failedOps.map((o) => <Line key={o.id}>Server change “{OP_NAMES[o.op] || o.op}” failed {o.attempts}×: {o.error}{' '}
        <button className="link-btn" onClick={() => api.post(`/api/accounts/${account.id}/ops/${o.id}/retry`).then(() => setTimeout(reload, 2500)).catch(toastError)}>Retry</button>{' · '}
        <button className="link-btn" title="Forget this queued change; nothing on the server is touched" onClick={() => confirm('Forget this change? It will not be applied on the server (nothing is deleted).') && api.del(`/api/accounts/${account.id}/ops/${o.id}`).then(reload).catch(toastError)}>Dismiss</button></Line>)}
      {st.smtp ? (st.smtp.ok ? <Line ok>SMTP: {st.smtp.tested ? 'login OK' : 'last message sent'} {ago(st.smtp.at)}</Line> : <Line>SMTP: failed {ago(st.smtp.at)} — {st.smtp.error || 'no details from the server'}</Line>)
        : <Line warn>SMTP: not used since the server started — use “Test connection”</Line>}
      {(st.outboxFailed > 0 || st.outboxRetrying > 0) && <Line>{st.outboxFailed} message(s) could not be sent, {st.outboxRetrying} retrying — see Mail → Outbox & drafts</Line>}
      {test && !test.busy && <div className="acct-test">
        {test.error ? <Line>Test failed: {test.error}</Line> : <>
          <Line ok={test.imap?.ok}>IMAP test: {test.imap?.ok ? `login OK, ${test.imap.folders} folders` : test.imap?.error || 'failed (no details from the server)'}</Line>
          <Line ok={test.smtp?.ok}>SMTP test: {test.smtp?.ok ? 'login OK' : test.smtp?.error || 'failed (no details from the server)'}</Line>
        </>}
      </div>}
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
