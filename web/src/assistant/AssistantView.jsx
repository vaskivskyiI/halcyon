import { useEffect, useRef, useState } from 'react';
import { Sparkles, Send, Sun, MessageSquare, Plus, Trash2, RefreshCw, Mail } from 'lucide-react';
import { api, stream, onEvent } from '../api.js';
import { store } from '../store.js';
import { Markdown, Spinner } from '../components/common.jsx';
import { navigate, toast, toastError, fmtListDate } from '../util.js';

const SUGGESTIONS = [
  'What needs my attention today?',
  'Which emails am I supposed to reply to?',
  'When am I free tomorrow for a 1-hour meeting?',
  'Summarize what happened in my inbox this week',
  'Are there any invoices or payments due?',
  'What tasks are overdue?',
];

export default function AssistantView({ route }) {
  const chatId = route[1] === 'chat' && route[2] ? Number(route[2]) : null;
  const mode = route[1] === 'chat' ? 'chat' : 'brief';
  const [chats, setChats] = useState([]);
  const loadChats = () => api.get('/api/ai/chats').then(setChats).catch(() => {});
  useEffect(() => { loadChats(); }, []);
  const providers = store.use((s) => s.aiProviders);
  const settings = store.use((s) => s.settings);
  if (!settings.ai.enabled || !providers.length) {
    return <div className="assistant"><div className="empty" style={{ margin: 'auto', maxWidth: 460 }}><Sparkles size={40} color="var(--ai)" />
      <h3 style={{ margin: 0, color: 'var(--text)' }}>Connect an AI provider</h3>
      <div>Halcyon works with self-hosted Ollama, OpenAI, Anthropic Claude, Google Gemini and any OpenAI-compatible server. Once connected, your mail is analysed in the background so summaries, priorities and reply drafts are ready when you open a message.</div>
      <button className="btn primary" onClick={() => navigate('#/settings/ai')}>Set up AI</button></div></div>;
  }
  return (
    <div className="assistant">
      <aside className="sidebar">
        <div className="sidebar-head"><button className="btn primary grow" style={{ justifyContent: 'center', height: 38 }} onClick={() => navigate('#/assistant/chat')}><Plus size={16} /> New chat</button></div>
        <div className="sidebar-scroll">
          <div className={`nav-item ${mode === 'brief' ? 'active' : ''}`} onClick={() => navigate('#/assistant')}><Sun size={16} /> Daily brief</div>
          <div className="nav-section">Recent chats</div>
          {chats.map((c) => (
            <div key={c.id} className={`nav-item ${chatId === c.id ? 'active' : ''}`} onClick={() => navigate(`#/assistant/chat/${c.id}`)}>
              <MessageSquare size={15} /><span className="truncate grow">{c.title}</span>
              <button className="icon-btn" style={{ width: 22, height: 22 }} onClick={async (e) => { e.stopPropagation(); await api.del(`/api/ai/chats/${c.id}`); loadChats(); if (chatId === c.id) navigate('#/assistant/chat'); }}><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
      </aside>
      {mode === 'brief' ? <Brief /> : <Chat key={chatId || 'new'} chatId={chatId} onCreated={(id) => { loadChats(); navigate(`#/assistant/chat/${id}`); }} />}
    </div>
  );
}

function Brief() {
  const [brief, setBrief] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [newTask, setNewTask] = useState('');
  const user = store.use((s) => s.user);
  const space = store.use((s) => s.space);
  const load = async (refresh) => {
    if (refresh) setBusy(true);
    setErr(null);
    try { const b = await api.get(`/api/ai/brief${refresh ? '?refresh=1' : ''}`); setBrief(b); if (b.error) setErr(b.error); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  // The lists are live: reload (debounced) whenever mail, AI results or tasks change.
  const timer = useRef();
  useEffect(() => {
    load(false);
    return onEvent((e) => {
      if (!['ai:brief', 'ai:insight', 'tasks:changed', 'mail:new', 'mail:changed', 'calendar:changed'].includes(e.type)) return;
      if (e.type === 'ai:brief' && (e.payload.space || '') !== space) return;
      clearTimeout(timer.current); timer.current = setTimeout(() => load(false), 600);
    });
  }, []);
  const dismiss = async (id) => {
    setBrief((b) => ({ ...b, live: { ...b.live, attention: b.live.attention.filter((m) => m.id !== id), awaiting: b.live.awaiting.filter((m) => m.id !== id), actions: (b.live.actions || []).filter((m) => m.id !== id) } }));
    try {
      await api.post(`/api/messages/${id}/dismiss`, {});
      toast('Removed from the brief', { action: { label: 'Undo', onClick: () => api.post(`/api/messages/${id}/dismiss`, { dismissed: false }).then(() => load(false)) } });
    } catch (e) { toastError(e); load(false); }
  };
  const taskDone = async (t) => {
    setBrief((b) => ({ ...b, live: { ...b.live, tasks: b.live.tasks.filter((x) => x.id !== t.id) } }));
    try {
      await api.patch(`/api/tasks/${t.id}`, { done: true });
      toast(`Done: ${t.title}`, { action: { label: 'Undo', onClick: () => api.patch(`/api/tasks/${t.id}`, { done: false }).then(() => load(false)) } });
    } catch (e) { toastError(e); load(false); }
  };
  const addTask = async (e) => {
    e.preventDefault();
    if (!newTask.trim()) return;
    try {
      const t = await api.post('/api/tasks', { text: newTask.trim() });
      if (t.due) toast(`Added “${t.title}” — due ${new Date(t.due).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`);
      setNewTask(''); load(false);
    } catch (err2) { toastError(err2); }
  };
  const hour = new Date().getHours();
  const live = brief?.live;
  const time = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const MailRow = ({ m }) => (
    <div className={`brief-row ${m.isRead ? '' : 'unread'}`}>
      <div className="grow" style={{ minWidth: 0, cursor: 'pointer' }} onClick={() => navigate(`#/mail/unified/${m.id}`)}>
        <div className="truncate"><b>{m.from}</b> — {m.subject || '(no subject)'}{m.topic && <span className="chip topic" style={{ marginLeft: 6 }}>#{m.topic}</span>}</div>
        {m.summary && <div className="small muted truncate">{m.summary}</div>}
      </div>
      <button className="btn sm" title="Handled — remove from the brief (the email stays in your mailbox)" onClick={() => dismiss(m.id)}>✓ Done</button>
    </div>
  );
  return (
    <div className="chat"><div className="chat-scroll"><div className="brief" style={{ width: '100%' }}>
      <div className="row"><h2 className="grow" style={{ margin: 0 }}>{hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}, {user.name?.split(' ')[0]}{space && <span className="chip" style={{ marginLeft: 10, verticalAlign: 'middle' }}>{space}</span>}</h2>
        <button className="btn" onClick={() => load(true)} disabled={busy} title="Re-write the AI overview now">{busy ? <Spinner size={14} /> : <RefreshCw size={15} />} Refresh</button></div>
      <div className="small faint" style={{ marginBottom: 16 }}>{brief?.content ? `Overview written ${fmtListDate(brief.createdAt)} · ${brief.model || ''} · lists below are live` : 'The overview is prepared in the background; the lists below are always current.'}</div>
      {err && <div className="notice warn" style={{ margin: '0 0 12px' }}>AI overview unavailable: {err}</div>}
      {brief?.content && <div className="card" style={{ padding: '14px 18px' }}><Markdown text={brief.content} onOpenMessage={(id) => navigate(`#/mail/unified/${id}`)} /></div>}
      {!brief && <div className="empty"><Spinner size={22} /> Loading…</div>}

      {live && <>
        <h3 className="brief-h">Needs your attention <span className="faint small">· {live.attention.length}</span></h3>
        <div className="card">{live.attention.length ? live.attention.map((m) => <MailRow key={m.id} m={m} />) : <div className="brief-empty">Nothing urgent.</div>}</div>
        {live.actions?.length > 0 && <>
          <h3 className="brief-h">Action needed <span className="faint small">· {live.actions.length}</span></h3>
          <div className="card">{live.actions.map((m) => <MailRow key={m.id} m={{ ...m, summary: m.action ? `→ ${m.action}` : m.summary }} />)}</div>
        </>}
        {live.awaiting.length > 0 && <>
          <h3 className="brief-h">Waiting for your reply <span className="faint small">· {live.awaiting.length}</span></h3>
          <div className="card">{live.awaiting.map((m) => <MailRow key={m.id} m={m} />)}</div>
        </>}
        <h3 className="brief-h">Today</h3>
        <div className="card">{live.events.length ? live.events.map((e) => (
          <div key={e.id + String(e.start)} className="brief-row" style={{ cursor: 'pointer' }} onClick={() => navigate('#/calendar')}>
            <span className="dot" style={{ background: e.color || 'var(--accent)' }} />
            <span style={{ width: 96, flex: 'none' }} className="small">{e.allDay ? 'All day' : `${time(e.start)}–${time(e.end)}`}</span>
            <span className="grow truncate">{e.title}{e.location ? <span className="faint"> · {e.location}</span> : ''}</span>
          </div>)) : <div className="brief-empty">No events today.</div>}</div>
        <h3 className="brief-h">Tasks <span className="faint small">· {live.tasks.length}</span></h3>
        <div className="card">
          {live.tasks.map((t) => (
            <div key={t.id} className="brief-row">
              <input type="checkbox" title="Mark as done" onChange={() => taskDone(t)} />
              <span className="grow truncate" style={{ color: t.overdue ? 'var(--danger)' : undefined }}>{t.title}
                {t.due && <span className="small faint"> · {t.overdue ? 'overdue, ' : ''}due {new Date(t.due).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>}
                {t.sourceMessageId && <a href={`#/mail/unified/${t.sourceMessageId}`} className="small" style={{ marginLeft: 6 }}><Mail size={11} /> email</a>}</span>
            </div>))}
          <form className="brief-row" onSubmit={addTask}>
            <Plus size={15} className="faint" />
            <input className="input grow" style={{ border: 0, background: 'transparent' }} placeholder="Add a task… (“call Ana tomorrow at 10”)" value={newTask} onChange={(e) => setNewTask(e.target.value)} />
            {newTask.trim() && <button className="btn sm primary">Add</button>}
          </form>
        </div>
      </>}

      <h3 style={{ marginTop: 28 }}>Ask about your mail and schedule</h3>
      <div className="suggestions">{SUGGESTIONS.map((q) => <button key={q} className="btn" onClick={() => { sessionStorage.setItem('halcyon.ask', q); navigate('#/assistant/chat'); }}>{q}</button>)}</div>
    </div></div></div>
  );
}

function Chat({ chatId, onCreated }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scroller = useRef();
  const ctl = useRef();
  const space = store.use((s) => s.space);
  useEffect(() => {
    if (chatId) api.get(`/api/ai/chats/${chatId}`).then((c) => setMessages(c.messages)).catch(toastError);
    const pending = sessionStorage.getItem('halcyon.ask');
    if (pending && !chatId) { sessionStorage.removeItem('halcyon.ask'); ask(pending); }
  }, [chatId]);
  useEffect(() => { scroller.current?.scrollTo(0, scroller.current.scrollHeight); }, [messages]);

  async function ask(q) {
    const question = (q ?? input).trim();
    if (!question || busy) return;
    setInput(''); setBusy(true);
    setMessages((m) => [...m, { role: 'user', content: question }, { role: 'assistant', content: '', pending: true }]);
    ctl.current = new AbortController();
    try {
      let out = '';
      const r = await stream('/api/ai/ask', { chatId, question }, {
        signal: ctl.current.signal,
        onStatus: (st) => setMessages((m) => (m.at(-1)?.pending && !out ? [...m.slice(0, -1), { role: 'assistant', content: '', pending: true, status: st }] : m)),
        onToken: (t) => { out += t; setMessages((m) => [...m.slice(0, -1), { role: 'assistant', content: out, pending: true }]); },
      });
      setMessages((m) => [...m.slice(0, -1), { role: 'assistant', content: r.answer, sources: r.sources }]);
      if (!chatId) onCreated(r.chatId);
    } catch (e) {
      setMessages((m) => [...m.slice(0, -1), { role: 'assistant', content: `⚠️ ${e.message}` }]);
    } finally { setBusy(false); }
  }

  return (
    <div className="chat">
      <div className="chat-scroll" ref={scroller}>
        {!messages.length && <div className="empty" style={{ marginTop: 40 }}><Sparkles size={36} color="var(--ai)" /><div>Ask anything about your email, calendar, contacts and tasks.</div>
          <div className="suggestions" style={{ justifyContent: 'center' }}>{SUGGESTIONS.map((s) => <button key={s} className="btn sm" onClick={() => ask(s)}>{s}</button>)}</div></div>}
        {messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.role === 'user' ? m.content : <>
              {m.pending && !m.content ? <span className="pulse muted"><Sparkles size={14} /> {m.status || 'Searching your mailbox…'}</span> : <Markdown text={m.content} onOpenMessage={(id) => navigate(`#/mail/unified/${id}`)} />}
              {m.sources?.length > 0 && <div className="row" style={{ flexWrap: 'wrap', marginTop: 6, gap: 4 }}><span className="small faint">Sources — open to check:</span>{m.sources.map((s) => (
                <button key={s.id} className={`chip ${s.cited ? 'ai' : ''}`} style={{ border: 0, cursor: 'pointer' }} title={s.cited ? 'Cited in the answer' : 'Given to the AI as context'} onClick={() => navigate(`#/mail/unified/${s.id}`)}>
                  <Mail size={11} /> #{s.id} {s.from}: {String(s.subject).slice(0, 40)}{s.date ? ` · ${new Date(s.date).toLocaleDateString()}` : ''}</button>))}</div>}
            </>}
          </div>
        ))}
      </div>
      <div className="chat-input">
        <textarea className="input" rows={1} placeholder={space ? `Ask about your ${space} mail, schedule or contacts… (or “remember that …”)` : 'Ask about your mail, schedule or contacts… (or “remember that …”)'} value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } }} />
        {busy ? <button className="btn" onClick={() => ctl.current?.abort()}><Spinner size={14} /> Stop</button> : <button className="btn primary" onClick={() => ask()} disabled={!input.trim()}><Send size={15} /></button>}
      </div>
    </div>
  );
}
