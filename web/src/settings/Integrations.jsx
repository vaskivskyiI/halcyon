import { useEffect, useState } from 'react';
import { Check, Unplug } from 'lucide-react';
import { api } from '../api.js';
import { toast, toastError } from '../util.js';
import { forgetInkwellLinks } from '../components/InkwellNotes.jsx';
import { CertField, tlsBody } from './Accounts.jsx';

/**
 * Other self-hosted apps of the user's. Inkwell (notes): its pages linked to mail, events and tasks show in the reader,
 * the event and the task. The token is kept encrypted and never sent back — only whether there is one.
 */
export default function Integrations() {
  const [ink, setInk] = useState(null);
  const [f, setF] = useState({ url: '', token: '', tls: null });
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/api/integrations/inkwell').then((r) => { setInk(r); setF({ url: r.url, token: '', tls: r.tls }); }).catch(toastError); }, []);

  const save = async () => {
    setBusy(true);
    try {
      const r = await api.put('/api/integrations/inkwell', { url: f.url, token: f.token || undefined, tls: tlsBody(f.tls) });
      setInk(r); setF({ url: r.url, token: '', tls: r.tls }); forgetInkwellLinks();
      if (!r.url) return toast('Inkwell disconnected');
      const t = await api.post('/api/integrations/inkwell/test');
      t.ok ? toast('Connected to Inkwell') : toast(`Saved, but: ${t.error}`, { kind: 'error' });
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const disconnect = async () => {
    if (!confirm('Disconnect Inkwell? Its notes no longer show next to mail, events and tasks.')) return;
    try { const r = await api.put('/api/integrations/inkwell', { url: '' }); setInk(r); forgetInkwellLinks(); setF({ url: '', token: '', tls: null }); } catch (e) { toastError(e); }
  };

  return (
    <div className="settings-section">
      <h2>Integrations</h2>
      <h3>Inkwell</h3>
      <div className="muted">Your Inkwell notes linked to an email, an event or a task show next to it here, with a button for a new note. Create a token in Inkwell → Settings → Apps &amp; tokens.</div>
      {ink && <div style={{ display: 'grid', gap: 10, maxWidth: 520 }}>
        <label className="field">Inkwell address<input className="input" placeholder="https://notes.example.org" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /></label>
        <label className="field">API token<input className="input" type="password" autoComplete="off" placeholder={ink.hasToken ? 'Saved — type a new one to replace it' : 'ink_…'} value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} /></label>
        {/^https:/i.test(f.url.trim()) && <CertField value={f.tls} onChange={(tls) => setF((x) => ({ ...x, tls }))} />}
        <div className="row">
          <button className="btn primary" disabled={busy || !f.url.trim() || (!f.token.trim() && !ink.hasToken)} onClick={save}>Save</button>
          {ink.configured && <span className="small faint"><Check size={12} /> Connected</span>}
          <span className="grow" />
          {ink.url && <button className="btn ghost" onClick={disconnect}><Unplug size={15} /> Disconnect</button>}
        </div>
      </div>}
    </div>
  );
}
