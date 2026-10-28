import { useEffect, useState } from 'react';
import { Plus, RefreshCw, Trash2, Pencil, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import { api } from '../api.js';
import { store } from '../store.js';
import { loadAccounts, loadFolders } from '../data.js';
import { Modal, Spinner, Switch } from '../components/common.jsx';
import { davFound } from '../components/Problems.jsx';
import { toast, toastError, fmtListDate } from '../util.js';

export default function Accounts() {
  const accounts = store.use((s) => s.accounts).filter((a) => a.kind !== 'archive'); // archives: Settings → Archives
  const user = store.use((s) => s.user);
  const [editing, setEditing] = useState(null);
  const [oauthSetup, setOauthSetup] = useState(null);
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
      {user?.isAdmin && <OAuthStatus onSetup={setOauthSetup} />}
      {editing && <AccountEditor account={editing.id ? editing : null} onClose={() => setEditing(null)} onSetupOAuth={(p) => { setEditing(null); setOauthSetup(p); }} />}
      {oauthSetup && <OAuthSetup provider={oauthSetup} onClose={() => setOauthSetup(null)} />}
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

function AccountEditor({ account, onClose, onSetupOAuth }) {
  const oauth = store.use((s) => s.oauth);
  const [step, setStep] = useState(account ? 'details' : 'email');
  const [f, setF] = useState(() => account ? {
    email: account.email, displayName: account.displayName || '', name: account.name || '', signatureHtml: account.signatureHtml || '',
    imap: { ...account.imap, password: '' }, smtp: { ...account.smtp, password: '' }, caldavUrl: account.caldavUrl || '', carddavUrl: account.carddavUrl || '',
    davUser: account.davUser || '', davPassword: '', syncEnabled: account.syncEnabled, aliases: account.aliases || [], inviteCalendarId: account.inviteCalendarId || null,
    aboutMe: account.aboutMe || '', contextMode: account.contextMode || '',
  } : { email: '', displayName: '', password: '', imap: { host: '', port: 993, secure: true, user: '' }, smtp: { host: '', port: 465, secure: true, user: '' }, caldavUrl: '', carddavUrl: '', signatureHtml: '' });
  const [disc, setDisc] = useState(null);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState(null);
  const set = (path, v) => setF((x) => { const n = structuredClone(x); const ks = path.split('.'); let o = n; ks.slice(0, -1).forEach((k) => (o = o[k])); o[ks.at(-1)] = v; return n; });

  const discover = async () => {
    // Gmail / Google Workspace addresses get the Google step (sign-in or app password).
    if (/@(gmail|googlemail)\.com$/i.test(f.email)) { setStep('google'); return; }
    setBusy(true);
    try {
      const d = await api.get(`/api/accounts/discover?email=${encodeURIComponent(f.email)}`);
      setDisc(d);
      if (d.oauth === 'google') { setStep('google'); return; }
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

  // Google with an app password: Gmail's IMAP/SMTP, then (optionally) the calendar's secret iCal address.
  const [icalUrl, setIcalUrl] = useState('');
  const saveGoogle = async () => {
    const gm = { imap: { host: 'imap.gmail.com', port: 993, secure: true, user: f.email }, smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: f.email } };
    const b = { ...f, imap: { ...gm.imap, password: f.password }, smtp: { ...gm.smtp, password: f.password } };
    setBusy(true); setTest(null);
    try {
      const t = await api.post('/api/accounts/test', b);
      setTest(t);
      if (!t.imap?.ok || !t.smtp?.ok) return;
      await api.post('/api/accounts', b);
      if (icalUrl.trim()) await api.post('/api/calendars', { name: 'Google Calendar', url: icalUrl.trim(), showAs: 'busy' }).catch((e) => toastError(e));
      toast('Google account added — syncing your mail…');
      await loadAccounts(); loadFolders(); onClose();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };

  const save = async () => {
    if (!account) {
      const r = await runTest();
      if (!r?.imap?.ok || !r?.smtp?.ok) { setStep('details'); return; }
    }
    setBusy(true);
    try {
      const r = account ? await api.patch(`/api/accounts/${account.id}`, body()) : await api.post('/api/accounts', body());
      // Calendars / contacts: what the first sync found, or why it found nothing.
      if (r?.dav?.error) toastError(new Error(r.dav.error));
      else if (r?.dav?.pending) toast('Account updated — calendars and contacts are still being synced');
      else toast(account ? `Account updated${r?.dav ? ` — ${davFound(r.dav)}` : ''}` : 'Account added — syncing your mail…');
      await loadAccounts(); loadFolders(); onClose();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };

  const startOAuth = (provider) => {
    window.open(api.url(`/api/oauth/${provider}/start${account ? `?accountId=${account.id}` : ''}`), 'oauth', 'width=520,height=680');
    // The sign-in window reports back over a BroadcastChannel (its link to this window is cut by Google's pages),
    // with postMessage and a storage event as fallbacks.
    let finished = false;
    const bc = 'BroadcastChannel' in window ? new BroadcastChannel('halcyon-oauth') : null;
    const finish = (m) => {
      if (finished || m?.type !== 'halcyon-oauth') return;
      finished = true;
      bc?.close(); window.removeEventListener('message', onMsg); window.removeEventListener('storage', onStorage);
      loadAccounts(); loadFolders();
      if (m.ok) { toast('Account connected — syncing your mail…'); onClose(); }
    };
    const onMsg = (e) => { if (e.origin === location.origin) finish(e.data); };
    const onStorage = (e) => { if (e.key === 'halcyon-oauth' && e.newValue) { try { finish(JSON.parse(e.newValue)); } catch { /* ignore */ } } };
    if (bc) bc.onmessage = (e) => finish(e.data);
    window.addEventListener('message', onMsg);
    window.addEventListener('storage', onStorage);
  };


  const TestResult = () => test && (
    <div className="card" style={{ padding: 10 }}>
      {['imap', 'smtp'].map((k) => <div key={k} className="row small">{test[k]?.ok ? <CheckCircle2 size={15} color="var(--success)" /> : <XCircle size={15} color="var(--danger)" />}<b>{k.toUpperCase()}</b>{test[k]?.ok ? (k === 'imap' ? `connected · ${test.imap.folders} folders` : 'connected') : <span className="error-text">{test[k]?.error}</span>}</div>)}
    </div>
  );

  const footer = step === 'email'
    ? <><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!/@/.test(f.email) || busy} onClick={discover}>{busy && <Spinner size={14} />} Continue</button></>
    : step === 'google'
      ? <><button className="btn" onClick={() => setStep('email')}>Back</button><span className="grow" /><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !/@/.test(f.email) || !f.password} onClick={saveGoogle}>{busy && <Spinner size={14} />} Add with app password</button></>
      : <><button className="btn" onClick={runTest} disabled={busy}>{busy && <Spinner size={14} />} Test connection</button><span className="grow" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>{account ? 'Save' : 'Add account'}</button></>;

  return (
    <Modal title={account ? `Edit ${account.email}` : 'Add email account'} onClose={onClose} wide footer={footer}>
      {step === 'email' && <>
        {!account && <div className="provider-row">
          <button className="provider" onClick={() => setStep('google')}><b>Google</b><span>Gmail, Google Workspace</span></button>
          <button className="provider" onClick={() => (oauth.microsoft ? startOAuth('microsoft') : toast('Enter your Microsoft address below; sign-in with Microsoft can be set up by an administrator in Settings → Accounts.'))}><b>Microsoft</b><span>Outlook.com, Microsoft 365</span></button>
          <div className="provider muted"><b>Other</b><span>any IMAP/SMTP mailbox — enter the address below</span></div>
        </div>}
        <label className="field">Email address<input className="input" type="email" autoFocus value={f.email} onChange={(e) => set('email', e.target.value.trim())} onKeyDown={(e) => e.key === 'Enter' && /@/.test(f.email) && discover()} /></label>
        <label className="field">Your name (shown to recipients)<input className="input" value={f.displayName} onChange={(e) => set('displayName', e.target.value)} /></label>
        {(oauth.google || oauth.microsoft) && <div className="row">{oauth.google && <button className="btn" onClick={() => startOAuth('google')}>Sign in with Google</button>}{oauth.microsoft && <button className="btn" onClick={() => startOAuth('microsoft')}>Sign in with Microsoft</button>}</div>}
      </>}
      {step === 'google' && <>
        <div className="card google-step">
          <h3 style={{ margin: '0 0 4px' }}>Sign in with Google <span className="faint small">— recommended: mail, calendar and contacts</span></h3>
          {oauth.google ? <button className="btn primary" onClick={() => startOAuth('google')}>Sign in with Google</button>
            : <div className="small muted">Not set up on this server yet: it needs a (free) Google OAuth client, registered once.{' '}
              {store.get().user?.isAdmin ? <button className="link-btn" onClick={() => onSetupOAuth?.('google')}>Set it up now (about 5 minutes)</button> : 'Ask your administrator to set it up in Settings → Accounts.'}</div>}
        </div>
        <h3 style={{ margin: '12px 0 4px' }}>…or use an app password <span className="faint small">— mail only, works right away</span></h3>
        <ol className="small muted steps">
          <li>Turn on 2-Step Verification for your Google account.</li>
          <li>Create an app password at <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">myaccount.google.com/apppasswords</a> (name it “Halcyon”) and paste it below.</li>
          <li>In Gmail settings → “Forwarding and POP/IMAP”, make sure IMAP is enabled.</li>
        </ol>
        <div className="form-grid">
          <label className="field">Gmail address<input className="input" type="email" value={f.email} onChange={(e) => set('email', e.target.value.trim())} /></label>
          <label className="field">App password<input className="input" type="password" value={f.password} placeholder="xxxx xxxx xxxx xxxx" onChange={(e) => set('password', e.target.value.replace(/\s+/g, ''))} autoComplete="new-password" /></label>
          <label className="field">Your name (shown to recipients)<input className="input" value={f.displayName} onChange={(e) => set('displayName', e.target.value)} /></label>
          <label className="field">Google Calendar (optional, read-only)<input className="input" value={icalUrl} placeholder="Secret address in iCal format" onChange={(e) => setIcalUrl(e.target.value)} /></label>
        </div>
        <div className="small faint">Google Calendar does not accept app passwords. For your calendar: Google Calendar → settings of the calendar → “Integrate calendar” → copy the “Secret address in iCal format”.</div>
        <TestResult />
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
          <InviteCalendar value={f.inviteCalendarId} accountId={account.id} onChange={(v) => set('inviteCalendarId', v)} />
          <AutoReply accountId={account.id} />
          <label className="field full">What the AI knows about you for this account's mail<select className="input" value={f.contextMode} onChange={(e) => set('contextMode', e.target.value)}>
            <option value="">As in Settings → AI ({store.get().settings?.ai?.contextMode === 'global' ? 'everything' : 'this account only'})</option>
            <option value="account">Only this account's context (and your general “About you”)</option>
            <option value="global">Everything about you (all accounts)</option></select></label>
          <label className="field full">About you in this account <span className="faint">— who you are here (e.g. “owner of NM Studio, a photography studio…” or “private”). The AI uses it for this account's mail instead of everything about you; your general “About me” in Settings → AI is always included.</span>
            <textarea className="input" rows={4} maxLength={2000} value={f.aboutMe} onChange={(e) => set('aboutMe', e.target.value)} placeholder="e.g. Private mail: family, friends, home. Not work-related." /></label>
          {account.learnedAbout && <div className="small"><b>Learned from this account's sent mail</b> <span className="faint">({account.learnedAboutAt ? new Date(account.learnedAboutAt).toLocaleDateString() : ''}; your text above wins)</span>
            <div className="muted" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{account.learnedAbout}</div></div>}
          <Switch label="Sync this account" checked={f.syncEnabled} onChange={(v) => set('syncEnabled', v)} />
        </>}
      </>}
    </Modal>
  );
}

/** For administrators: whether "Sign in with Google / Microsoft" works on this server. */
function OAuthStatus({ onSetup }) {
  const [st, setSt] = useState(null);
  useEffect(() => { api.get('/api/admin/oauth').then(setSt).catch(() => {}); }, []);
  if (!st) return null;
  const line = (p, label) => (
    <div className="row small">
      {st[p].configured ? <CheckCircle2 size={14} color="var(--success)" /> : <AlertTriangle size={14} color="var(--text-3)" />}
      <span className="grow">Sign in with {label}: {st[p].configured ? `ready${st[p].source === 'env' ? ' (set in the server environment)' : ''}` : 'not set up'}</span>
      {st[p].source !== 'env' && <button className="btn sm" onClick={() => onSetup(p)}>{st[p].configured ? 'Change' : 'Set up'}</button>}
    </div>);
  return <div className="card" style={{ padding: 12, display: 'grid', gap: 6 }}><b className="small">Server sign-in options (administrator)</b>{line('google', 'Google')}{line('microsoft', 'Microsoft')}</div>;
}

/** Registering this server as an OAuth client with Google / Microsoft, step by step. */
function OAuthSetup({ provider, onClose }) {
  const [st, setSt] = useState(null);
  const [f, setF] = useState({ clientId: '', clientSecret: '', tenant: 'common' });
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/api/admin/oauth').then((r) => { setSt(r); setF((x) => ({ ...x, clientId: r[provider].clientId || '', tenant: r[provider].tenant || 'common' })); }).catch(toastError); }, []);
  const save = async (clear) => {
    setBusy(true);
    try {
      await api.put(`/api/admin/oauth/${provider}`, clear ? { clientId: '' } : f);
      const me = await api.get('/api/me'); store.set({ oauth: me.oauth });
      toast(clear ? 'Removed' : `Sign in with ${provider === 'google' ? 'Google' : 'Microsoft'} is ready`);
      onClose();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const uri = st?.redirectUri || '';
  const insecure = /^http:\/\/(?!localhost|127\.)/.test(uri);
  const copy = () => navigator.clipboard?.writeText(uri).then(() => toast('Copied'));
  return (
    <Modal title={`Set up sign-in with ${provider === 'google' ? 'Google' : 'Microsoft'}`} onClose={onClose} wide footer={<>
      {st?.[provider]?.source === 'settings' && <button className="btn danger" disabled={busy} onClick={() => confirm('Remove this sign-in option? Accounts connected with it stop syncing until set up again.') && save(true)}>Remove</button>}
      <span className="grow" /><button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={busy || !f.clientId.trim() || !f.clientSecret.trim()} onClick={() => save(false)}>{busy && <Spinner size={14} />} Save</button>
    </>}>
      <div className="small muted">This is done once per Halcyon server; afterwards every user can add Google accounts with one click. The client secret is stored encrypted.</div>
      <label className="field">Redirect address to register
        <div className="row"><input className="input grow" readOnly value={uri} onFocus={(e) => e.target.select()} /><button className="btn sm" onClick={copy}>Copy</button></div></label>
      {insecure && <div className="notice warn">{provider === 'google' ? 'Google' : 'Microsoft'} only accepts https addresses. Set <code>HALCYON_PUBLIC_URL=https://your-domain</code> in the server environment (deploy/pod.env), restart, and open this dialog again.</div>}
      {provider === 'google' ? <ol className="small steps">
        <li>Open <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noreferrer">Google Cloud console</a> and create a project (e.g. “Halcyon”).</li>
        <li>In <a href="https://console.cloud.google.com/apis/library" target="_blank" rel="noreferrer">APIs &amp; Services → Library</a>, enable <b>CalDAV API</b> and <b>Google Contacts CardDAV API</b> (mail needs no extra API).</li>
        <li>In <a href="https://console.cloud.google.com/apis/credentials/consent" target="_blank" rel="noreferrer">OAuth consent screen</a>: choose <b>External</b>, enter an app name and your email. Add yourself under Test users, then press <b>Publish app</b> — while it is in “Testing”, Google signs you out every 7 days. Google will show “unverified app” once at sign-in; that is expected for a private server.</li>
        <li>In <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">Credentials</a>: Create credentials → OAuth client ID → <b>Web application</b>, and add the redirect address above under “Authorized redirect URIs”.</li>
        <li>Copy the Client ID and Client secret here.</li>
      </ol> : <ol className="small steps">
        <li>Open <a href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noreferrer">Microsoft Entra → App registrations</a> → New registration (any account type you need), platform <b>Web</b>, redirect URI = the address above.</li>
        <li>Under API permissions add <b>Office 365 Exchange Online</b> (or APIs my organization uses → “Office 365 Exchange Online”) delegated permissions <b>IMAP.AccessAsUser.All</b> and <b>SMTP.Send</b>, plus <b>offline_access</b>, <b>openid</b>, <b>email</b>, <b>profile</b>.</li>
        <li>Under Certificates &amp; secrets create a client secret; copy its <b>value</b> and the Application (client) ID here. Tenant: <code>common</code>, or your organisation's tenant ID.</li>
      </ol>}
      <div className="form-grid">
        <label className="field">Client ID<input className="input" value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })} /></label>
        <label className="field">Client secret<input className="input" type="password" value={f.clientSecret} onChange={(e) => setF({ ...f, clientSecret: e.target.value })} autoComplete="new-password" /></label>
        {provider === 'microsoft' && <label className="field">Tenant<input className="input" value={f.tenant} onChange={(e) => setF({ ...f, tenant: e.target.value })} /></label>}
      </div>
    </Modal>
  );
}

/** Where accepted invitations to this account go: automatic (the account's own calendar) or a chosen calendar. */
function InviteCalendar({ value, accountId, onChange }) {
  const [cals, setCals] = useState([]);
  useEffect(() => { api.get('/api/calendars?allSpaces=1').then((l) => setCals(l.filter((c) => !c.readonly))).catch(() => {}); }, []);
  const own = cals.filter((c) => c.accountId === accountId);
  return (
    <label className="field">Calendar for accepted invitations
      <select className="input" value={value || ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
        <option value="">Automatic{own.length ? ` (${own[0].name}, this account's calendar)` : " (this account's calendar, else the default)"}</option>
        {cals.map((c) => <option key={c.id} value={c.id}>{c.name}{c.space ? ` · ${c.space}` : ''}</option>)}
      </select></label>
  );
}

/** Automatic replies (out of office): one reply per sender every few days, never to lists or automated mail. */
function AutoReply({ accountId }) {
  const [c, setC] = useState(null);
  useEffect(() => { api.get(`/api/accounts/${accountId}/auto-reply`).then(setC).catch(() => {}); }, [accountId]);
  if (!c) return null;
  const day = (t) => (t ? new Date(t - new Date(t).getTimezoneOffset() * 60e3).toISOString().slice(0, 10) : '');
  const save = async (patch) => {
    const next = { ...c, ...patch };
    try { setC(await api.put(`/api/accounts/${accountId}/auto-reply`, next)); if ('enabled' in patch) toast(next.enabled ? 'Automatic replies are on' : 'Automatic replies are off'); loadAccounts(); } catch (e) { toastError(e); setC(next); }
  };
  return (
    <div className="card" style={{ padding: 12, display: 'grid', gap: 8 }}>
      <Switch label="Automatic replies (out of office)" hint={c.active ? 'On now — people who write get your reply once every few days.' : 'One reply per sender every few days; never to mailing lists, automated mail or other automatic replies.'} checked={c.enabled} onChange={(v) => save({ enabled: v })} />
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <label className="field">From (optional)<input className="input" type="date" value={day(c.start)} onChange={(e) => save({ start: e.target.value ? new Date(`${e.target.value}T00:00`).getTime() : null })} /></label>
        <label className="field">Until (optional)<input className="input" type="date" value={day(c.end ? c.end - 1 : null)} onChange={(e) => save({ end: e.target.value ? new Date(`${e.target.value}T00:00`).getTime() + 864e5 : null })} /></label>
        <label className="field">Again after<select className="input" value={c.days} onChange={(e) => save({ days: Number(e.target.value) })}>{[1, 2, 4, 7, 14].map((d) => <option key={d} value={d}>{d} day{d > 1 ? 's' : ''}</option>)}</select></label>
      </div>
      <label className="field">Subject (optional)<input className="input" value={c.subject} placeholder="Automatic reply: <their subject>" onChange={(e) => setC({ ...c, subject: e.target.value })} onBlur={() => save({})} /></label>
      <label className="field">Message<textarea className="input" rows={4} value={c.message} placeholder="Thank you for your email. I am away until Monday 3 November and will reply after that." onChange={(e) => setC({ ...c, message: e.target.value })} onBlur={() => save({})} /></label>
      <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={c.onlyContacts} onChange={(e) => save({ onlyContacts: e.target.checked })} /> Only to people in my contacts</label>
    </div>
  );
}
