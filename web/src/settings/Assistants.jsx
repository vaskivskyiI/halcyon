import { useEffect, useState } from 'react';
import { Plus, Trash2, Copy, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../api.js';
import { store } from '../store.js';
import { toast, toastError } from '../util.js';

const url = () => `${(window.HALCYON_SERVER || location.origin).replace(/\/$/, '')}/api/mcp`;
const copy = (text) => navigator.clipboard.writeText(text).then(() => toast('Copied')).catch(() => toast('Select the text and copy it', { kind: 'error' }));

/**
 * Other assistants (Claude, Hermes, OpenClaw…) connected over MCP: each gets its own token. They read with what
 * Halcyon has worked out; they never send, delete, move or forward — at most they write drafts and tasks and ask for
 * mail actions, which wait for approval here.
 */
export default function Assistants() {
  const [tokens, setTokens] = useState([]);
  const [open, setOpen] = useState(null);
  const [created, setCreated] = useState(null);
  const shared = store.use((s) => s.shared) || [];
  const spaces = store.use((s) => s.spaces) || [];
  const acting = store.use((s) => s.acting);
  const [f, setF] = useState({ name: '', targetId: '', space: '', access: 'read' });
  const load = () => api.get('/api/mcp-tokens').then(setTokens).catch(toastError);
  useEffect(() => { load(); }, []);

  const create = async () => {
    try {
      const r = await api.post('/api/mcp-tokens', { ...f, targetId: f.targetId || undefined, space: f.targetId ? '' : f.space });
      setCreated({ ...r, name: f.name || 'Assistant' }); setF({ name: '', targetId: '', space: '', access: 'read' }); load();
    } catch (e) { toastError(e); }
  };
  const revoke = async (t) => { if (!confirm(`Disconnect “${t.name}”? Its token stops working at once.`)) return; await api.del(`/api/mcp-tokens/${t.id}`).catch(toastError); load(); };

  return (
    <div className="settings-section">
      <h2>Assistants (MCP)</h2>
      <div className="muted">Connect another AI assistant — e.g. Claude, Hermes or OpenClaw — so it can use your mail, calendar, contacts and tasks together with what Halcyon has already worked out (summaries, open items, the daily brief). Each assistant gets its own key. It can <b>never send, delete, move or forward</b> mail: with “can propose” it may write drafts (which you send yourself) and tasks, and ask for mail actions, which wait for your approval here. Email text is passed to it marked as untrusted.</div>
      {acting && <div className="notice">Keys are made from your own mail; choose the shared space below to give an assistant access to it.</div>}

      {tokens.map((t) => (
        <div key={t.id} className="card" style={{ padding: 12 }}>
          <div className="row">
            <button className="icon-btn" onClick={() => setOpen(open === t.id ? null : t.id)} title="Recent activity">{open === t.id ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button>
            <b className="grow">{t.name}</b>
            <span className="small faint">{t.target}{t.space ? ` · ${t.space}` : ''} · {t.access === 'propose' ? 'can propose' : 'read only'} · {t.lastUsedAt ? `used ${new Date(t.lastUsedAt).toLocaleString()}` : 'not used yet'}</span>
            <button className="icon-btn" title="Disconnect" onClick={() => revoke(t)}><Trash2 size={15} /></button>
          </div>
          {open === t.id && <div className="small" style={{ marginTop: 8, display: 'grid', gap: 2 }}>
            {t.log.length ? t.log.map((l, i) => <div key={i} className={l.ok ? 'faint' : 'error-text'}>{new Date(l.at).toLocaleString()} · <b>{l.tool}</b> {l.detail}</div>) : <div className="faint">No activity yet.</div>}
          </div>}
        </div>
      ))}

      {created && (
        <div className="card" style={{ padding: 14, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 8, borderColor: 'var(--accent)' }}>
          <b>Key for “{created.name}” — shown only now</b>
          <div className="row"><code className="grow" style={{ fontSize: 12, wordBreak: 'break-all', minWidth: 0 }}>{created.token}</code><button className="btn sm" onClick={() => copy(created.token)}><Copy size={13} /> Copy</button></div>
          <div className="small">Server address: <code>{url()}</code> (MCP over HTTP, header <code>Authorization: Bearer &lt;key&gt;</code>)</div>
          <Snippet title="Claude Code" text={`claude mcp add --transport http halcyon ${url()} --header "Authorization: Bearer ${created.token}"`} />
          <Snippet title="Claude Desktop, Hermes, OpenClaw or other apps (via mcp-remote)" text={JSON.stringify({ mcpServers: { halcyon: { command: 'npx', args: ['-y', 'mcp-remote', url(), '--header', `Authorization: Bearer ${created.token}`] } } }, null, 2)} />
          <div><button className="btn sm" onClick={() => setCreated(null)}>Done</button></div>
        </div>
      )}

      <h3>Connect an assistant</h3>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
        <label className="field" style={{ maxWidth: 220 }}>Name<input className="input" placeholder="e.g. Claude on my laptop" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="field" style={{ maxWidth: 200 }}>Mail<select className="input" value={f.targetId} onChange={(e) => setF({ ...f, targetId: e.target.value })}>
          <option value="">My mail</option>{shared.map((s) => <option key={s.id} value={s.id}>{s.name} (shared)</option>)}</select></label>
        {!f.targetId && spaces.length > 0 && <label className="field" style={{ maxWidth: 180 }}>Only the space<select className="input" value={f.space} onChange={(e) => setF({ ...f, space: e.target.value })}>
          <option value="">All my spaces</option>{spaces.map((s) => <option key={s}>{s}</option>)}</select></label>}
        <label className="field" style={{ maxWidth: 220 }}>Access<select className="input" value={f.access} onChange={(e) => setF({ ...f, access: e.target.value })}>
          <option value="read">Read only</option><option value="propose">Can propose (drafts, tasks, actions to approve)</option></select></label>
        <button className="btn primary" onClick={create}><Plus size={15} /> Create key</button>
      </div>
    </div>
  );
}

function Snippet({ title, text }) {
  return (
    <div className="small">
      <div className="row"><span className="grow">{title}</span><button className="btn sm ghost" onClick={() => copy(text)}><Copy size={13} /> Copy</button></div>
      <pre className="diag" style={{ maxHeight: 180, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{text}</pre>
    </div>
  );
}
