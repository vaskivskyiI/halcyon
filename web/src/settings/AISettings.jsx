import { useEffect, useState } from 'react';
import { Plus, Trash2, Pencil, CheckCircle2, XCircle, Server, Cloud, RefreshCw, Lock, Download } from 'lucide-react';
import { api } from '../api.js';
import { store } from '../store.js';
import { loadProviders, saveSettings } from '../data.js';
import { Modal, Spinner, Switch } from '../components/common.jsx';
import { toast, toastError } from '../util.js';

// Presets on top of the five provider types.
const PRESETS = [
  { key: 'ollama', type: 'ollama', label: 'Ollama (this machine)', baseUrl: 'http://localhost:11434', defaultModel: 'llama3.1:8b', embedModel: 'nomic-embed-text' },
  { key: 'ollama-remote', type: 'ollama', label: 'Ollama (self-hosted server)', baseUrl: 'http://ollama.lan:11434', defaultModel: 'qwen2.5:14b', embedModel: 'nomic-embed-text' },
  { key: 'openai', type: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4.1-mini', embedModel: 'text-embedding-3-small' },
  { key: 'anthropic', type: 'anthropic', label: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com', defaultModel: 'claude-haiku-5-5', embedModel: '' },
  { key: 'gemini', type: 'gemini', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', defaultModel: 'gemini-2.5-flash', embedModel: 'gemini-embedding-001' },
  { key: 'mistral', type: 'openai-compatible', label: 'Mistral AI', baseUrl: 'https://api.mistral.ai/v1', defaultModel: 'mistral-small-latest', embedModel: 'mistral-embed' },
  { key: 'groq', type: 'openai-compatible', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile', embedModel: '' },
  { key: 'openrouter', type: 'openai-compatible', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'meta-llama/llama-3.3-70b-instruct', embedModel: '' },
  { key: 'deepseek', type: 'openai-compatible', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat', embedModel: '' },
  { key: 'foundry', type: 'openai-compatible', label: 'Foundry Local (Windows NPU / GPU)', baseUrl: 'http://127.0.0.1:5273/v1', defaultModel: '', embedModel: '' },
  { key: 'lmstudio', type: 'openai-compatible', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', defaultModel: '', embedModel: '' },
  { key: 'vllm', type: 'openai-compatible', label: 'vLLM / llama.cpp / LocalAI', baseUrl: 'http://localhost:8000/v1', defaultModel: '', embedModel: '' },
  { key: 'custom', type: 'openai-compatible', label: 'Other OpenAI-compatible endpoint', baseUrl: '', defaultModel: '', embedModel: '' },
];
const TASKS = [
  ['background', 'Background analysis', 'Triage, summaries, priorities, reply drafts, daily brief. Runs on every new email — a fast/cheap or local model is ideal.'],
  ['compose', 'Writing', 'Drafting, replying, rewriting, translating.'],
  ['chat', 'Assistant chat', 'Questions about your mailbox and calendar.'],
  ['embeddings', 'Semantic search', 'Embedding model for meaning-based search and assistant retrieval.'],
];

export default function AISettings() {
  const settings = store.use((s) => s.settings);
  const providers = store.use((s) => s.aiProviders);
  const [editing, setEditing] = useState(null);
  const [status, setStatus] = useState(null);
  const ai = settings.ai;
  const setAi = (patch) => saveSettings({ ai: patch }).catch(toastError);
  const loadStatus = () => api.get('/api/ai/status').then(setStatus).catch(() => {});
  useEffect(() => { loadStatus(); const t = setInterval(loadStatus, 5000); return () => clearInterval(t); }, []);
  const q = (type, st) => status?.queue.rows.filter((r) => (!type || r.type === type) && r.status === st).reduce((a, r) => a + r.n, 0) || 0;

  return (
    <div className="settings-section">
      <div><h2>AI & assistant</h2><div className="muted">Bring your own AI: run fully private with Ollama on your own hardware, or use cloud providers. Different tasks can use different models.</div></div>
      <Switch label="Enable AI features" checked={ai.enabled} onChange={(v) => setAi({ enabled: v })} />
      <Switch label="Privacy mode" hint="Only use providers on this machine or your local network (e.g. Ollama). Cloud providers are ignored." checked={ai.privacyMode} onChange={(v) => setAi({ privacyMode: v })} />

      <h3>Providers</h3>
      {providers.map((p) => (
        <div key={p.id} className="card item-card">
          {p.local ? <Server size={18} color="var(--success)" /> : <Cloud size={18} color="var(--accent)" />}
          <div className="grow" style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{p.name} {!p.enabled && <span className="chip">disabled</span>}</div>
            <div className="small muted truncate">{p.type} · {p.baseUrl} · chat: {p.defaultModel || '—'}{p.embedModel ? ` · embeddings: ${p.embedModel}` : ''}</div>
            {p.insecure && <div className="small error-text">Unencrypted connection over the internet: email content sent for analysis can be read in transit. Use https (e.g. a reverse proxy with TLS) or a VPN/LAN address.</div>}
          </div>
          <button className="icon-btn" onClick={() => setEditing(p)}><Pencil size={16} /></button>
          <button className="icon-btn" onClick={async () => { if (confirm(`Remove ${p.name}?`)) { await api.del(`/api/ai/providers/${p.id}`); loadProviders(); } }}><Trash2 size={16} /></button>
        </div>
      ))}
      <div><button className="btn" onClick={() => setEditing({})}><Plus size={15} /> Add provider</button></div>

      {providers.length > 0 && <>
        <h3>Model routing</h3>
        <div className="small muted" style={{ marginTop: -6 }}>Choose which provider and model handle each kind of work. Leave on “Automatic” to use the first provider's default model.</div>
        {TASKS.map(([task, label, hint]) => <RouteRow key={task} task={task} label={label} hint={hint} providers={providers} route={ai.routes?.[task]} onChange={(r) => setAi({ routes: { ...ai.routes, [task]: r } })} />)}
      </>}

      <h3>Background processing</h3>
      <div className="small muted" style={{ marginTop: -6 }}>New mail is analysed as it arrives so summaries, priorities, action items and reply drafts are ready the moment you open it.</div>
      <Switch label="Analyse new mail automatically" checked={ai.autoAnalyze} onChange={(v) => setAi({ autoAnalyze: v })} />
      <div className="form-grid">
        <label className="field">Analyse messages newer than (days)<input className="input" type="number" min="1" value={ai.analyzeDays} onChange={(e) => setAi({ analyzeDays: Number(e.target.value) })} /></label>
        <label className="field">Folders to analyse<select className="input" value={ai.analyzeFolders} onChange={(e) => setAi({ analyzeFolders: e.target.value })}><option value="inbox">Inbox only</option><option value="all">All folders (except trash/spam)</option></select></label>
        <label className="field">Parallel AI jobs<input className="input" type="number" min="1" max="8" value={ai.maxConcurrency} onChange={(e) => setAi({ maxConcurrency: Number(e.target.value) })} /></label>
      </div>
      <Switch label="Conversation summaries" hint="Summarise threads with 3+ messages" checked={ai.threadSummaries} onChange={(v) => setAi({ threadSummaries: v })} />
      <Switch label="Smart replies and pre-written drafts" checked={ai.smartReplies} onChange={(v) => setAi({ smartReplies: v })} />
      <Switch label="Semantic search index" hint="Find emails by meaning, not just keywords (needs an embedding model)" checked={ai.embeddings} onChange={(v) => setAi({ embeddings: v })} />
      <Switch label="Daily brief" checked={ai.dailyBrief} onChange={(v) => setAi({ dailyBrief: v })} />
      {ai.dailyBrief && <label className="field" style={{ maxWidth: 200 }}>Brief ready by<input className="input" type="time" value={ai.briefTime} onChange={(e) => setAi({ briefTime: e.target.value })} /></label>}

      <h3>Personalisation</h3>
      <label className="field">About you (role, company, what matters — helps prioritisation)<textarea className="input" defaultValue={ai.aboutMe} onBlur={(e) => setAi({ aboutMe: e.target.value })} placeholder="e.g. I'm a researcher at the Jožef Stefan Institute; emails from students and grant agencies are important." /></label>
      <label className="field">Writing style<textarea className="input" defaultValue={ai.writingStyle} onBlur={(e) => setAi({ writingStyle: e.target.value })} placeholder="e.g. Concise and friendly. Use 'Best regards'. Avoid exclamation marks." /></label>
      <label className="field" style={{ maxWidth: 320 }}>Reply language<select className="input" value={ai.replyLanguage} onChange={(e) => setAi({ replyLanguage: e.target.value })}>
        <option value="auto">Same as the email</option>{['English', 'Slovenian', 'German', 'French', 'Spanish', 'Italian', 'Croatian', 'Serbian', 'Ukrainian', 'Polish'].map((l) => <option key={l}>{l}</option>)}</select></label>

      <Memory enabled={ai.embeddings} />

      <h3>Status</h3>
      {status && <div className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="row small" style={{ flexWrap: 'wrap', gap: 16 }}>
          <span><b>{status.analyzed}</b> emails analysed</span>
          <span><b>{status.index.count}</b> in semantic index {status.index.model && <span className="faint">({status.index.model})</span>}</span>
          <span><b>{q(null, 'queued') + q(null, 'running')}</b> jobs pending</span>
          {q(null, 'waiting') > 0 && <span className="error-text"><b>{q(null, 'waiting')}</b> waiting for a provider</span>}
          {q(null, 'failed') > 0 && <span className="error-text"><b>{q(null, 'failed')}</b> failed</span>}
          {status.approvals > 0 && <a href="#/mail/unified"><b>{status.approvals}</b> AI rule actions awaiting your approval</a>}
        </div>
        {status.queue.lastError && <div className="small error-text">Last error ({status.queue.lastError.type}): {status.queue.lastError.error}</div>}
        <div className="row">
          <button className="btn sm" onClick={async () => { const r = await api.post('/api/ai/reprocess', { what: 'analyze', days: 14 }); toast(`Queued ${r.queued} emails`); }}><RefreshCw size={13} /> Re-analyse last 14 days</button>
          <button className="btn sm" onClick={async () => { const r = await api.post('/api/ai/reprocess', { what: 'embed', days: 365 }); toast(`Indexing ${r.queued} emails`); }}><RefreshCw size={13} /> Rebuild search index</button>
        </div>
        {status.usage.length > 0 && <table className="simple"><thead><tr><th>Model</th><th>Task</th><th>Calls (30d)</th><th>Tokens in/out</th><th>Avg time</th><th>Errors</th></tr></thead>
          <tbody>{status.usage.map((u, i) => <tr key={i}><td>{u.model}</td><td>{u.task}</td><td>{u.calls}</td><td>{Math.round(u.input / 1000)}k / {Math.round(u.output / 1000)}k</td><td>{(u.avgMs / 1000).toFixed(1)}s</td><td>{u.errors || ''}</td></tr>)}</tbody></table>}
      </div>}
      {editing && <ProviderEditor provider={editing.id ? editing : null} onClose={() => setEditing(null)} />}
    </div>
  );
}

const KIND_LABELS = { message: 'email chunks', thread: 'conversation summaries', event: 'events', contact: 'contacts', fact: 'facts' };

/** What the AI remembers: index statistics and the facts it learned or was told, with add / delete / clear. */
function Memory({ enabled }) {
  const [mem, setMem] = useState(null);
  const [text, setText] = useState('');
  const space = store.use((s) => s.space);
  const load = () => api.get('/api/ai/memory').then(setMem).catch(() => {});
  useEffect(() => { load(); }, []);
  const add = async () => { if (!text.trim()) return; try { await api.post('/api/ai/memory/facts', { text }); setText(''); setTimeout(load, 300); } catch (e) { toastError(e); } };
  const del = async (id) => { await api.del(`/api/ai/memory/facts/${id}`).catch(toastError); load(); };
  const clear = async (what) => {
    if (!confirm(what === 'all' ? 'Delete all facts and the whole semantic index? The index is rebuilt in the background from your mail.' : 'Forget all facts (learned and the ones you told the assistant)?')) return;
    await api.del(`/api/ai/memory?what=${what}`).catch(toastError); load();
  };
  const byKind = {};
  for (const r of mem?.stats.rows || []) (byKind[r.kind] ||= { items: 0, chunks: 0 }), byKind[r.kind].items += r.items, byKind[r.kind].chunks += r.n;
  return <>
    <h3>Memory</h3>
    <div className="small muted" style={{ marginTop: -6 }}>For search and the assistant, Halcyon keeps a semantic memory of your emails (split into passages), conversation summaries, events, contacts and short facts.
      It is stored only in this Halcyon database, per user, and respects spaces{space ? ` — showing facts visible in “${space}”` : ''}. {!enabled && <b>Turn on “Semantic search index” above to build it.</b>}</div>
    {mem && <div className="row small" style={{ flexWrap: 'wrap', gap: 14 }}>
      {Object.entries(KIND_LABELS).map(([k, label]) => <span key={k}><b>{byKind[k]?.items || 0}</b> {label}{k === 'message' && byKind[k] ? <span className="faint"> ({byKind[k].chunks} passages)</span> : ''}</span>)}
    </div>}
    <div className="row">
      <input className="input" placeholder={`Tell the assistant something to remember${space ? ` in ${space}` : ''}, e.g. “My office is room 4.12”`} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
      <button className="btn" onClick={add} disabled={!text.trim()}><Plus size={14} /> Remember</button>
    </div>
    {mem?.facts.length > 0 && <div className="card" style={{ padding: 6, maxHeight: 320, overflow: 'auto' }}>
      {mem.facts.map((f) => (
        <div key={f.id} className="row small" style={{ padding: '5px 8px', borderBottom: '1px solid var(--border)' }}>
          <span className="grow">{f.text}
            <span className="faint"> · {f.origin === 'user' ? 'told by you' : <>learned from {f.sourceMessageId ? <a href={`#/mail/unified/${f.sourceMessageId}`}>{f.sourceSubject || 'an email'}</a> : 'an email'}</>}{f.space ? ` · ${f.space}` : ''}</span></span>
          <button className="icon-btn" style={{ width: 24, height: 24 }} title="Forget this" onClick={() => del(f.id)}><Trash2 size={13} /></button>
        </div>))}
    </div>}
    <div className="row">
      <button className="btn sm" onClick={() => clear('facts')}><Trash2 size={13} /> Forget all facts</button>
      <button className="btn sm" onClick={() => clear('all')}><Trash2 size={13} /> Clear all memory</button>
    </div>
  </>;
}

function RouteRow({ task, label, hint, providers, route, onChange }) {
  const [models, setModels] = useState([]);
  const pid = route?.providerId || '';
  useEffect(() => { if (pid) api.post('/api/ai/providers/models', { id: pid }).then(setModels).catch(() => setModels([])); }, [pid]);
  const eligible = task === 'embeddings' ? providers.filter((p) => p.type !== 'anthropic') : providers;
  return (
    <div className="card" style={{ padding: 12 }}>
      <div style={{ fontWeight: 600 }}>{label}</div><div className="small faint" style={{ marginBottom: 8 }}>{hint}</div>
      <div className="row">
        <select className="input" value={pid} onChange={(e) => onChange(e.target.value ? { providerId: Number(e.target.value), model: '' } : null)}>
          <option value="">Automatic</option>{eligible.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {pid && <><input className="input" list={`models-${task}`} placeholder="Provider default" value={route?.model || ''} onChange={(e) => onChange({ providerId: Number(pid), model: e.target.value })} />
          <datalist id={`models-${task}`}>{models.filter((m) => (task === 'embeddings' ? m.embedding !== false : !m.embedding)).map((m) => <option key={m.id} value={m.id}>{m.name || ''}</option>)}</datalist></>}
      </div>
    </div>
  );
}

function ProviderEditor({ provider, onClose }) {
  const [preset, setPreset] = useState(provider ? null : 'ollama');
  const p0 = PRESETS.find((x) => x.key === 'ollama');
  const [f, setF] = useState(provider ? { ...provider, apiKey: '' } : { name: p0.label, type: p0.type, baseUrl: p0.baseUrl, defaultModel: p0.defaultModel, embedModel: p0.embedModel, apiKey: '' });
  const [models, setModels] = useState([]);
  const [test, setTest] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pull, setPull] = useState('');
  const [detected, setDetected] = useState(null);
  const detect = async () => { setBusy(true); try { setDetected(await api.get('/api/ai/local-detect')); } catch (e) { toastError(e); } finally { setBusy(false); } };
  const useDetected = (d) => { setPreset(PRESETS.some((x) => x.key === d.key) ? d.key : 'custom'); setF((x) => ({ ...x, name: d.label, type: d.type, baseUrl: d.baseUrl, defaultModel: d.models.find((m) => !/embed/i.test(m)) || '', embedModel: d.models.find((m) => /embed/i.test(m)) || '' })); setModels(d.models.map((id) => ({ id, embedding: /embed/i.test(id) }))); setTest(null); };
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const choose = (key) => { const p = PRESETS.find((x) => x.key === key); setPreset(key); setF((x) => ({ ...x, name: p.label, type: p.type, baseUrl: p.baseUrl, defaultModel: p.defaultModel, embedModel: p.embedModel })); setModels([]); setTest(null); };
  const req = () => ({ id: provider?.id, type: f.type, baseUrl: f.baseUrl, apiKey: f.apiKey || undefined, defaultModel: f.defaultModel, embedModel: f.embedModel });
  const fetchModels = async () => { setBusy(true); try { setModels(await api.post('/api/ai/providers/models', req())); } catch (e) { toastError(e); } finally { setBusy(false); } };
  const runTest = async () => { setBusy(true); setTest(null); try { setTest(await api.post('/api/ai/providers/test', req())); } catch (e) { toastError(e); } finally { setBusy(false); } };
  const save = async () => {
    try {
      if (provider) await api.patch(`/api/ai/providers/${provider.id}`, { name: f.name, baseUrl: f.baseUrl, apiKey: f.apiKey || undefined, defaultModel: f.defaultModel, embedModel: f.embedModel, enabled: f.enabled });
      else await api.post('/api/ai/providers', f);
      await loadProviders(); toast('Provider saved — background AI will start processing'); onClose();
    } catch (e) { toastError(e); }
  };
  const chatModels = models.filter((m) => !m.embedding);
  const embedModels = models.filter((m) => m.embedding !== false);
  return (
    <Modal title={provider ? `Edit ${provider.name}` : 'Add AI provider'} onClose={onClose} wide footer={<>
      <button className="btn" onClick={runTest} disabled={busy}>{busy && <Spinner size={14} />} Test</button><span className="grow" />
      <button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save</button></>}>
      {!provider && <div className="row" style={{ flexWrap: 'wrap' }}><button className="btn sm" onClick={detect} disabled={busy}><Server size={13} /> Detect AI on this machine</button>
        {detected && !detected.length && <span className="small faint">Nothing found. Start Foundry Local (<code>foundry model run phi-4-mini</code>), Ollama or LM Studio and try again.</span>}
        {detected?.map((d) => <button key={d.key} className="btn sm ai" onClick={() => useDetected(d)}>{d.label} · {d.models.length} models</button>)}</div>}
      {!provider && <label className="field">Provider<select className="input" value={preset} onChange={(e) => choose(e.target.value)}>{PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select></label>}
      <div className="form-grid">
        <label className="field">Name<input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} /></label>
        <label className="field">Base URL<input className="input" value={f.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} /></label>
        {f.type !== 'ollama' && <label className="field full">API key {provider?.hasKey && <span className="faint">(stored — leave empty to keep)</span>}<input className="input" type="password" value={f.apiKey} onChange={(e) => set('apiKey', e.target.value)} autoComplete="off" /></label>}
        <label className="field">Default chat model<input className="input" list="chat-models" value={f.defaultModel} onChange={(e) => set('defaultModel', e.target.value)} /></label>
        <label className="field">Embedding model {f.type === 'anthropic' && <span className="faint">(not offered by Anthropic)</span>}<input className="input" list="embed-models" value={f.embedModel || ''} onChange={(e) => set('embedModel', e.target.value)} disabled={f.type === 'anthropic'} /></label>
        <datalist id="chat-models">{chatModels.map((m) => <option key={m.id} value={m.id}>{m.name || ''}</option>)}</datalist>
        <datalist id="embed-models">{embedModels.map((m) => <option key={m.id} value={m.id} />)}</datalist>
      </div>
      <div className="row"><button className="btn sm" onClick={fetchModels} disabled={busy}><RefreshCw size={13} /> Load available models</button>{models.length > 0 && <span className="small faint">{models.length} models found</span>}</div>
      {f.type === 'ollama' && provider && <div className="row"><input className="input" placeholder="Pull a model, e.g. qwen2.5:7b" value={pull} onChange={(e) => setPull(e.target.value)} /><button className="btn sm" disabled={!pull} onClick={async () => { toast(`Pulling ${pull}… this can take a while`); try { await api.post(`/api/ai/providers/${provider.id}/pull`, { model: pull }); toast(`${pull} ready`); fetchModels(); } catch (e) { toastError(e); } }}><Download size={13} /> Pull</button></div>}
      {preset === 'foundry' && <div className="small faint"><Lock size={12} /> Runs on this PC's NPU/GPU via Microsoft Foundry Local — email content stays on the device. Install with <code>winget install Microsoft.FoundryLocal</code>, then <code>foundry model run phi-4-mini</code> (it picks the NPU build when available). The port can change: use “Detect AI on this machine”.</div>}
      {f.type === 'ollama' && <div className="small faint"><Lock size={12} /> Runs on your own hardware — email content never leaves your network. Recommended: <code>llama3.1:8b</code>, <code>qwen2.5:7b</code> or <code>gemma2:9b</code> for analysis and <code>nomic-embed-text</code> for search.</div>}
      {test && <div className="card" style={{ padding: 10 }}>
        <div className="row small">{test.chat?.ok ? <CheckCircle2 size={15} color="var(--success)" /> : <XCircle size={15} color="var(--danger)" />}<b>Chat</b>{test.chat?.ok ? `“${test.chat.reply}” in ${test.chat.ms} ms` : <span className="error-text">{test.chat?.error}</span>}</div>
        {test.embeddings && <div className="row small">{test.embeddings.ok ? <CheckCircle2 size={15} color="var(--success)" /> : <XCircle size={15} color="var(--danger)" />}<b>Embeddings</b>{test.embeddings.ok ? `${test.embeddings.dim} dimensions` : <span className="error-text">{test.embeddings.error}</span>}</div>}
      </div>}
    </Modal>
  );
}
