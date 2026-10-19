import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Reply, ReplyAll, Forward, Archive, Trash2, AlertOctagon, Star, Clock, MoreHorizontal, Sparkles, Paperclip, Download, Image as ImageIcon,
  CalendarPlus, CheckSquare, Languages, Printer, FileCode, BellOff, ArrowLeft, Tag, Folder, MailOpen, Mail as MailIcon, AlertTriangle, Check, HelpCircle, X as XIcon, MapPin, Video, RefreshCw,
} from 'lucide-react';
import { api, stream, onEvent } from '../api.js';
import { store } from '../store.js';
import { fmtFull, fmtSize, addrLabel, addrFull, toast, toastError, navigate, textToHtml, escapeHtml, CATEGORY_COLORS } from '../util.js';
import { Avatar, useMenu, Spinner, Markdown } from '../components/common.jsx';
import { openComposer, replyPayload } from './Composer.jsx';
import { mailAction, snoozeOptions } from './mailActions.js';
import { EventEditor } from '../calendar/CalendarView.jsx';
import { loadFolders } from '../data.js';

export default function Reader({ id, view }) {
  const [thread, setThread] = useState(null);
  const [loading, setLoading] = useState(false);
  const [allowImages, setAllowImages] = useState(false);
  const [expanded, setExpanded] = useState(new Set());
  const [eventDraft, setEventDraft] = useState(null);
  const [aiWorking, setAiWorking] = useState(false);
  const [openMenu, menuNode] = useMenu();
  const settings = store.use((s) => s.settings);
  const folders = store.use((s) => s.folders);
  const labels = store.use((s) => s.labels);
  const conv = settings.ui.conversationView;

  const load = useCallback(async (images = allowImages) => {
    if (!id) { setThread(null); return; }
    setLoading(true);
    try {
      const m = await api.get(`/api/messages/${id}${images ? '?images=1' : ''}`);
      let data = { messages: [m], summary: null };
      if (conv && m.threadId) {
        const t = await api.get(`/api/threads/${encodeURIComponent(m.threadId)}${images ? '?images=1' : ''}`);
        if (t.messages.length) data = t;
      }
      setThread({ ...data, current: m });
      const last = data.messages[data.messages.length - 1];
      setExpanded(new Set([m.id, last.id, ...data.messages.filter((x) => !x.isRead).map((x) => x.id)]));
    } catch (e) { toastError(e); setThread(null); } finally { setLoading(false); }
  }, [id, conv, allowImages]);

  useEffect(() => { setAllowImages(false); load(false); }, [id, conv]);

  useEffect(() => onEvent((e) => {
    if (!thread) return;
    if (e.type === 'ai:insight' && thread.messages.some((m) => m.id === e.payload.messageId)) {
      setThread((t) => ({ ...t, messages: t.messages.map((m) => (m.id === e.payload.messageId ? { ...m, insight: e.payload.insight } : m)), current: t.current.id === e.payload.messageId ? { ...t.current, insight: e.payload.insight } : t.current }));
    }
    if (e.type === 'ai:thread' && e.payload.threadId === thread.current.threadId) setThread((t) => ({ ...t, summary: e.payload.summary }));
    if (e.type === 'ai:draft' && thread.messages.some((m) => m.id === e.payload.messageId)) load();
  }), [thread]);

  // Keyboard reply shortcuts dispatched from the list.
  useEffect(() => {
    const h = (e) => thread && reply(e.detail.mode);
    window.addEventListener('halcyon:reply', h);
    return () => window.removeEventListener('halcyon:reply', h);
  });

  if (!id) return <section className="reader"><div className="empty" style={{ margin: 'auto' }}><MailIcon size={44} strokeWidth={1.2} /><div>Select a message to read</div><div className="small">Shortcuts: j/k navigate · r reply · a reply all · f forward · e archive · # delete · s flag · / search · c compose</div></div></section>;
  if (!thread) return <section className="reader"><div className="empty" style={{ margin: 'auto' }}>{loading ? <Spinner size={22} /> : 'Message not found'}</div></section>;

  const msgs = thread.messages;
  const latest = [...msgs].reverse().find((m) => m.folder?.specialUse !== '\\Sent') || msgs[msgs.length - 1];
  const target = thread.current;
  const ins = latest.insight || target.insight;
  const ids = conv ? msgs.filter((m) => m.folder?.specialUse !== '\\Sent').map((m) => m.id) : [target.id];
  const act = (action, extra) => {
    mailAction(action, ids.length ? ids : [target.id], extra, { onDone: () => { if (['archive', 'trash', 'spam', 'move', 'snooze', 'delete'].includes(action)) navigate(`#/mail/${view}`); else load(); } });
  };
  function reply(mode, msg = latest, extra = {}) { openComposer(replyPayload(mode, msg, store.get().accounts, extra)); }

  const aiReply = async (intent) => {
    // Opens a reply composer that streams the AI draft into the body.
    openComposer(replyPayload('reply', latest, store.get().accounts, { aiIntent: intent ?? '' }));
  };

  const addEvent = async (ev) => {
    if (ev) {
      const start = Date.parse(ev.start);
      setEventDraft({ title: ev.title, start, end: Date.parse(ev.end) || start + 3600e3, allDay: !!ev.all_day, location: ev.location || '', description: `From email: ${target.subject}`, sourceMessageId: latest.id });
      return;
    }
    setAiWorking(true);
    try { setEventDraft(await api.post('/api/ai/extract-event', { messageId: latest.id })); } catch (e) { toastError(e); } finally { setAiWorking(false); }
  };

  const createTasks = async (items) => {
    try { const r = await api.post(`/api/tasks/from-message/${latest.id}`, items ? { items } : {}); toast(`${r.length} task${r.length > 1 ? 's' : ''} added`, { action: { label: 'View', onClick: () => navigate('#/tasks') } }); } catch (e) { toastError(e); }
  };

  const translate = async (m) => {
    let out = '';
    setThread((t) => ({ ...t, translations: { ...(t.translations || {}), [m.id]: '…' } }));
    try {
      await stream('/api/ai/translate', { messageId: m.id }, { onToken: (tk) => { out += tk; setThread((t) => ({ ...t, translations: { ...t.translations, [m.id]: out } })); } });
    } catch (e) { toastError(e); }
  };

  const unsubscribe = async () => {
    try {
      const r = await api.post(`/api/messages/${target.id}/unsubscribe`);
      if (r.method === 'browser') window.open(r.url, '_blank', 'noopener');
      else toast('Unsubscribed');
    } catch (e) { toastError(e); }
  };

  const moreMenu = (e) => openMenu(e, [
    { label: 'Create event with AI', icon: CalendarPlus, onClick: () => addEvent() },
    { label: 'Create task', icon: CheckSquare, onClick: () => createTasks() },
    { label: 'Translate', icon: Languages, onClick: () => translate(latest) },
    target.listUnsubscribe && { label: 'Unsubscribe', icon: BellOff, onClick: unsubscribe },
    'sep',
    { label: target.isRead ? 'Mark as unread' : 'Mark as read', icon: target.isRead ? MailIcon : MailOpen, onClick: () => act(target.isRead ? 'unread' : 'read') },
    { label: 'Print', icon: Printer, onClick: () => printThread(msgs) },
    { label: 'Download .eml', icon: FileCode, onClick: () => window.open(api.url(`/api/messages/${target.id}/raw`)) },
    target.folder?.specialUse === '\\Junk' ? { label: 'Not spam', icon: AlertOctagon, onClick: () => act('notspam') } : { label: 'Report spam', icon: AlertOctagon, onClick: () => act('spam') },
    { label: 'Delete permanently', icon: Trash2, danger: true, onClick: () => confirm('Delete permanently?') && act('delete') },
    'sep', { section: 'Labels' },
    ...labels.map((l) => ({ label: `${target.labels?.includes(l.id) ? '✓ ' : ''}${l.name}`, icon: Tag, onClick: () => act(target.labels?.includes(l.id) ? 'unlabel' : 'label', { labelId: l.id }) })),
  ]);

  const moveMenu = (e) => openMenu(e, folders.accounts.flatMap((a) => [{ section: a.email }, ...a.folders.map((f) => ({ label: f.name, icon: Folder, onClick: () => act('move', { folderId: f.id }) }))]));
  const snoozeMenu = (e) => openMenu(e, [...snoozeOptions().map(([label, until]) => ({ label, hint: new Date(until).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }), onClick: () => act('snooze', { until }) })),
    target.snoozedUntil && { label: 'Unsnooze', onClick: () => act('unsnooze') }]);

  return (
    <section className="reader">
      <div className="reader-toolbar">
        <button className="icon-btn mobile-only" onClick={() => navigate(`#/mail/${view}`)}><ArrowLeft size={18} /></button>
        <button className="btn ghost" onClick={() => reply('reply')}><Reply size={16} /> Reply</button>
        <button className="btn ghost" onClick={() => reply('replyAll')}><ReplyAll size={16} /> All</button>
        <button className="btn ghost" onClick={() => reply('forward')}><Forward size={16} /> Forward</button>
        <span className="grow" />
        <button className="icon-btn" title="Archive (e)" onClick={() => act('archive')}><Archive size={17} /></button>
        <button className="icon-btn" title="Delete (#)" onClick={() => act('trash')}><Trash2 size={17} /></button>
        <button className="icon-btn" title="Move" onClick={moveMenu}><Folder size={17} /></button>
        <button className="icon-btn" title="Snooze" onClick={snoozeMenu}><Clock size={17} /></button>
        <button className="icon-btn" title="Flag (s)" onClick={() => act(target.isFlagged ? 'unflag' : 'flag')}><Star size={17} fill={target.isFlagged ? '#f59e0b' : 'none'} color={target.isFlagged ? '#f59e0b' : 'currentColor'} /></button>
        <button className="icon-btn" title="More" onClick={moreMenu}><MoreHorizontal size={17} /></button>
      </div>
      <div className="reader-scroll">
        <h1>{target.subject || '(no subject)'}</h1>
        <div className="row" style={{ gap: 6, marginTop: -6, marginBottom: 12, flexWrap: 'wrap' }}>
          {target.folder && <span className="chip"><Folder size={11} /> {target.folder.name}</span>}
          {ins?.category && <span className="chip" style={{ color: CATEGORY_COLORS[ins.category] }}>{ins.category}</span>}
          {target.labels?.map((lid) => { const l = labels.find((x) => x.id === lid); return l && <span key={lid} className="chip" style={{ background: l.color, color: '#fff' }}>{l.name}</span>; })}
        </div>

        {ins?.isPhishing && <div className="notice danger" style={{ margin: '0 0 12px' }}><AlertTriangle size={16} /> This message looks suspicious. Don't click links or share credentials unless you're sure it's genuine.</div>}

        {settings.ai.enabled && <AiCard ins={ins} summary={thread.summary} count={msgs.length} latest={latest} aiWorking={aiWorking}
          onReply={aiReply} onEvent={addEvent} onTasks={createTasks} onAnalyze={async () => {
            setAiWorking(true);
            try { const i = await api.get(`/api/messages/${latest.id}/insight?wait=1`); setThread((t) => ({ ...t, messages: t.messages.map((m) => (m.id === latest.id ? { ...m, insight: i } : m)) })); if (msgs.length >= 2 && !thread.summary) { const s = await api.post('/api/ai/thread-summary', { threadId: latest.threadId }); setThread((t) => ({ ...t, summary: s.summary })); } } catch (e) { toastError(e); } finally { setAiWorking(false); }
          }} />}

        {msgs.map((m) => (
          <MessageCard key={m.id} m={m} expanded={expanded.has(m.id) || msgs.length === 1} toggle={() => setExpanded((s) => { const n = new Set(s); n.has(m.id) ? n.delete(m.id) : n.add(m.id); return n; })}
            onReply={(mode) => reply(mode, m)} onShowImages={() => { setAllowImages(true); load(true); }} translation={thread.translations?.[m.id]} onInviteChanged={load} />
        ))}

        <QuickReply latest={latest} onSent={() => load()} hasDraft={!!ins?.draftReply} />
      </div>
      {menuNode}
      {eventDraft && <EventEditor initial={eventDraft} onClose={() => setEventDraft(null)} onSaved={() => { setEventDraft(null); toast('Event added to calendar', { action: { label: 'Open', onClick: () => navigate('#/calendar') } }); }} />}
    </section>
  );
}

function AiCard({ ins, summary, count, latest, onReply, onEvent, onTasks, onAnalyze, aiWorking }) {
  if (!ins && !summary) {
    return <div className="card ai-card"><div className="row"><div className="title" style={{ margin: 0 }}><Sparkles size={15} /> AI assistant</div><span className="grow small faint">{latest.aiStatus === 'pending' ? 'Analysis queued in the background…' : 'Not analyzed yet.'}</span>
      <button className="btn sm ai" onClick={onAnalyze} disabled={aiWorking}>{aiWorking ? <Spinner size={13} /> : <Sparkles size={13} />} Analyze now</button></div></div>;
  }
  return (
    <div className="card ai-card">
      <div className="title"><Sparkles size={15} /> {count > 1 && summary ? `Conversation summary · ${count} messages` : 'Summary'}
        {ins?.priority != null && <span className="chip" style={{ marginLeft: 'auto', background: ins.priority >= 70 ? '#fee2e2' : undefined, color: ins.priority >= 70 ? '#991b1b' : undefined }}>Priority {ins.priority}{ins.priorityReason ? ` · ${ins.priorityReason}` : ''}</span>}
      </div>
      {summary ? <Markdown text={summary} /> : <div>{ins?.summary}</div>}
      {ins?.actionItems?.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div className="small muted" style={{ fontWeight: 600 }}>Action items</div>
          <ul>{ins.actionItems.map((a, i) => <li key={i}>{a.text}{a.due && <span className="faint"> · due {a.due}</span>}</li>)}</ul>
          <button className="btn sm" onClick={() => onTasks(ins.actionItems)}><CheckSquare size={13} /> Add to tasks</button>
        </div>
      )}
      {ins?.events?.length > 0 && (
        <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          {ins.events.map((e, i) => <button key={i} className="btn sm" onClick={() => onEvent(e)}><CalendarPlus size={13} /> {e.title} · {new Date(e.start).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</button>)}
        </div>
      )}
      {(ins?.needsReply || ins?.suggestedReplies?.length > 0) && (
        <div className="replies">
          {ins.draftReply && <button className="btn sm ai" onClick={() => onReply(null)}><Sparkles size={13} /> Use prepared draft</button>}
          {ins.suggestedReplies?.map((r, i) => <button key={i} className="btn sm" onClick={() => onReply(r)}>{r}</button>)}
          <button className="btn sm ghost" onClick={() => onReply('')}><Reply size={13} /> Write reply with AI</button>
        </div>
      )}
    </div>
  );
}

function MessageCard({ m, expanded, toggle, onReply, onShowImages, translation, onInviteChanged }) {
  const recipients = [...m.to, ...m.cc];
  return (
    <div className={`card msg-card ${expanded ? '' : 'collapsed'}`}>
      <div className="msg-card-head" onClick={toggle}>
        <Avatar name={m.from.name} email={m.from.address} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row"><span className="who truncate">{m.from.name || m.from.address}</span>{expanded && m.from.name && <span className="small faint truncate">&lt;{m.from.address}&gt;</span>}<span className="grow" /><span className="small muted" style={{ flex: 'none' }}>{fmtFull(m.date)}</span></div>
          {expanded ? <div className="small muted truncate" title={recipients.map(addrFull).join(', ')}>to {recipients.map(addrLabel).join(', ') || 'undisclosed recipients'}{m.bcc?.length ? `, bcc ${m.bcc.map(addrLabel).join(', ')}` : ''}</div>
            : <div className="small muted truncate">{m.snippet}</div>}
        </div>
        {expanded && <div className="row" onClick={(e) => e.stopPropagation()}>
          <button className="icon-btn" title="Reply" onClick={() => onReply('reply')}><Reply size={16} /></button>
          <button className="icon-btn" title="Reply all" onClick={() => onReply('replyAll')}><ReplyAll size={16} /></button>
          <button className="icon-btn" title="Forward" onClick={() => onReply('forward')}><Forward size={16} /></button>
        </div>}
      </div>
      {expanded && <>
        {m.hasInvite && <Invitation messageId={m.id} onChanged={onInviteChanged} />}
        {m.blockedRemote > 0 && <div className="notice"><ImageIcon size={15} /> Remote images were blocked to protect your privacy.<span className="grow" /><button className="btn sm" onClick={onShowImages}>Show images</button></div>}
        {translation && <div className="notice" style={{ display: 'block' }}><div className="small" style={{ fontWeight: 600, marginBottom: 4 }}><Languages size={13} /> Translation</div><div style={{ whiteSpace: 'pre-wrap' }}>{translation}</div></div>}
        <div className="msg-body">{m.html ? <HtmlFrame html={m.html} /> : <pre className="plain">{linkify(m.text)}</pre>}</div>
        {m.attachments?.length > 0 && <div className="attachments">{m.attachments.map((a) => (
          <a key={a.index} className="attachment" href={api.url(`/api/messages/${m.id}/attachments/${a.index}?inline=1`)} target="_blank" rel="noreferrer">
            <Paperclip size={15} /><span className="truncate grow">{a.filename}</span><span className="faint small">{fmtSize(a.size || 0)}</span>
            <span className="icon-btn" style={{ width: 24, height: 24 }} onClick={(e) => { e.preventDefault(); window.open(api.url(`/api/messages/${m.id}/attachments/${a.index}`)); }}><Download size={14} /></span>
          </a>))}</div>}
      </>}
    </div>
  );
}

function linkify(text = '') {
  const parts = String(text).split(/(https?:\/\/[^\s<>"]+)/g);
  return parts.map((p, i) => (i % 2 ? <a key={i} href={p} target="_blank" rel="noopener noreferrer">{p}</a> : p));
}

/** Email HTML rendered in a sandboxed iframe (no scripts) with auto height. */
function HtmlFrame({ html }) {
  const ref = useRef();
  const [h, setH] = useState(120);
  const doc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>
    html,body{margin:0;padding:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:14px;line-height:1.5;color:#1d2433;word-wrap:break-word;overflow-wrap:anywhere}
    body{padding:4px 2px} img{max-width:100%;height:auto} img[data-remote-src]{display:none} table{max-width:100%} pre{white-space:pre-wrap}
    blockquote{margin:0 0 0 6px;padding-left:10px;border-left:3px solid #d0d5dd;color:#5b6474} a{color:#2563eb}
  </style></head><body>${html}</body></html>`;
  const measure = () => {
    const d = ref.current?.contentDocument;
    if (d?.body) setH(Math.max(40, d.documentElement.scrollHeight + 4));
  };
  useEffect(() => {
    const d = ref.current?.contentDocument;
    if (!d) return;
    const ro = new ResizeObserver(measure);
    const t = setTimeout(() => d.body && ro.observe(d.body), 50);
    return () => { clearTimeout(t); ro.disconnect(); };
  }, [html]);
  return <iframe ref={ref} title="Message" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcDoc={doc} style={{ height: h }} onLoad={() => { measure(); setTimeout(measure, 300); }} />;
}

function Invitation({ messageId, onChanged }) {
  const [inv, setInv] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get(`/api/messages/${messageId}/invitation`).then(setInv).catch(() => {}); }, [messageId]);
  if (!inv?.event) return null;
  const e = inv.event;
  const respond = async (response) => {
    setBusy(true);
    try { await api.post(`/api/messages/${messageId}/invitation/respond`, { response }); toast(response === 'decline' ? 'Declined' : 'Added to your calendar'); setInv(await api.get(`/api/messages/${messageId}/invitation`)); onChanged?.(); } catch (err) { toastError(err); } finally { setBusy(false); }
  };
  const status = inv.existingStatus || inv.myStatus;
  return (
    <div className="invite-card">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <CalendarPlus size={20} color="var(--accent)" />
        <div className="grow">
          <div style={{ fontWeight: 650 }}>{inv.method === 'CANCEL' ? 'Cancelled: ' : ''}{e.title}</div>
          <div className="small muted">{e.allDay ? new Date(e.start).toLocaleDateString() : `${fmtFull(e.start)} – ${new Date(e.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}{e.rrule && ' · recurring'}</div>
          {e.location && <div className="small muted"><MapPin size={12} /> {e.location}</div>}
          {e.onlineMeeting && <a className="small" href={e.onlineMeeting} target="_blank" rel="noreferrer"><Video size={12} /> Join online meeting</a>}
          {e.organizer && <div className="small faint">Organizer: {e.organizer.name || e.organizer.email} · {e.attendees.length} attendees</div>}
        </div>
      </div>
      {inv.method === 'REQUEST' && (
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn sm" disabled={busy} onClick={() => respond('accept')} style={status === 'accepted' || status === 'confirmed' ? { borderColor: 'var(--success)', color: 'var(--success)' } : {}}><Check size={14} /> Accept</button>
          <button className="btn sm" disabled={busy} onClick={() => respond('tentative')} style={status === 'tentative' ? { borderColor: 'var(--warning)', color: 'var(--warning)' } : {}}><HelpCircle size={14} /> Maybe</button>
          <button className="btn sm" disabled={busy} onClick={() => respond('decline')} style={status === 'declined' || status === 'cancelled' ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : {}}><XIcon size={14} /> Decline</button>
          {status && status !== 'needs-action' && <span className="small faint">Your response: {status}</span>}
        </div>
      )}
    </div>
  );
}

function QuickReply({ latest, onSent, hasDraft }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const accounts = store.use((s) => s.accounts);
  useEffect(() => setText(''), [latest.id]);
  const send = async () => {
    setBusy(true);
    try {
      const p = replyPayload('reply', latest, accounts);
      await api.post('/api/send', { ...p, html: textToHtml(text) + (p.html || '') });
      toast('Sending…'); setText(''); onSent?.();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const draft = async () => {
    setGenBusy(true); setText('');
    try {
      if (hasDraft) { const r = await api.post('/api/ai/draft-reply', { messageId: latest.id }); setText(r.text); }
      else { let t = ''; await stream('/api/ai/draft-reply', { messageId: latest.id, stream: true }, { onToken: (x) => { t += x; setText(t); } }); }
    } catch (e) { toastError(e); } finally { setGenBusy(false); }
  };
  return (
    <div className="card quick-reply">
      <textarea className="input" rows={text ? 6 : 2} placeholder={`Quick reply to ${latest.from.name || latest.from.address}…`} value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim()) send(); }} />
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn primary" disabled={!text.trim() || busy} onClick={send}>{busy ? <Spinner size={14} /> : <Reply size={15} />} Send</button>
        <button className="btn ai" disabled={genBusy} onClick={draft}>{genBusy ? <Spinner size={14} /> : <Sparkles size={15} />} {hasDraft ? 'Insert AI draft' : 'Draft with AI'}</button>
        {text && <button className="btn ghost" onClick={() => { openComposer({ ...replyPayload('reply', latest, accounts), prefixHtml: textToHtml(text) }); setText(''); }}>Open in editor</button>}
        <span className="grow" /><span className="small faint">Ctrl+Enter to send</span>
      </div>
    </div>
  );
}

function printThread(msgs) {
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.write(`<html><head><title>${escapeHtml(msgs[0].subject)}</title><style>body{font-family:system-ui;padding:20px;max-width:800px;margin:auto}hr{margin:24px 0}.h{color:#555;font-size:13px}</style></head><body><h2>${escapeHtml(msgs[0].subject)}</h2>${msgs.map((m) => `<div class="h"><b>${escapeHtml(addrFull(m.from))}</b><br>To: ${escapeHtml(m.to.map(addrFull).join(', '))}<br>${fmtFull(m.date)}</div>${m.html || `<pre style="white-space:pre-wrap">${escapeHtml(m.text)}</pre>`}`).join('<hr>')}</body></html>`);
  w.document.close();
  setTimeout(() => w.print(), 400);
}
