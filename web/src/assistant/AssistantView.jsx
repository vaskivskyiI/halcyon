import { useEffect, useRef, useState } from 'react';
import { Sparkles, Send, Sun, MessageSquare, Plus, Trash2, RefreshCw, Mail } from 'lucide-react';
import { api, stream, onEvent } from '../api.js';
import { store } from '../store.js';
import { Markdown, Spinner } from '../components/common.jsx';
import { navigate, toastError, fmtListDate } from '../util.js';

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
  const user = store.use((s) => s.user);
  const load = async (refresh) => {
    setBusy(true); setErr(null);
    try { setBrief(await api.get(`/api/ai/brief${refresh ? '?refresh=1' : ''}`)); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  useEffect(() => { load(false); return onEvent((e) => e.type === 'ai:brief' && load(false)); }, []);
  const hour = new Date().getHours();
  return (
    <div className="chat"><div className="chat-scroll"><div className="brief" style={{ width: '100%' }}>
      <div className="row"><h2 className="grow" style={{ margin: 0 }}>{hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}, {user.name?.split(' ')[0]}</h2>
        <button className="btn" onClick={() => load(true)} disabled={busy}>{busy ? <Spinner size={14} /> : <RefreshCw size={15} />} Refresh</button></div>
      <div className="small faint" style={{ marginBottom: 16 }}>{brief ? `Prepared ${fmtListDate(brief.createdAt)} · ${brief.model || ''}` : 'Your daily brief is prepared in the background before your day starts.'}</div>
      {err && <div className="notice warn" style={{ margin: 0 }}>{err}</div>}
      {busy && !brief && <div className="empty"><Spinner size={22} /> Preparing your brief…</div>}
      {brief && <div className="card" style={{ padding: '16px 20px' }}><Markdown text={brief.content} onOpenMessage={(id) => navigate(`#/mail/unified/${id}`)} /></div>}
      <h3 style={{ marginTop: 28 }}>Ask about your mail and schedule</h3>
      <div className="suggestions">{SUGGESTIONS.map((s) => <button key={s} className="btn" onClick={() => { sessionStorage.setItem('halcyon.ask', s); navigate('#/assistant/chat'); }}>{s}</button>)}</div>
    </div></div></div>
  );
}

function Chat({ chatId, onCreated }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scroller = useRef();
  const ctl = useRef();
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
              {m.pending && !m.content ? <span className="pulse muted"><Sparkles size={14} /> Searching your mailbox…</span> : <Markdown text={m.content} onOpenMessage={(id) => navigate(`#/mail/unified/${id}`)} />}
              {m.sources?.length > 0 && <div className="row" style={{ flexWrap: 'wrap', marginTop: 6 }}>{m.sources.map((s) => (
                <button key={s.id} className="chip ai" style={{ border: 0, cursor: 'pointer' }} onClick={() => navigate(`#/mail/unified/${s.id}`)}><Mail size={11} /> #{s.id} {s.from}: {String(s.subject).slice(0, 40)}</button>))}</div>}
            </>}
          </div>
        ))}
      </div>
      <div className="chat-input">
        <textarea className="input" rows={1} placeholder="Ask about your mail, schedule or contacts…" value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } }} />
        {busy ? <button className="btn" onClick={() => ctl.current?.abort()}><Spinner size={14} /> Stop</button> : <button className="btn primary" onClick={() => ask()} disabled={!input.trim()}><Send size={15} /></button>}
      </div>
    </div>
  );
}
