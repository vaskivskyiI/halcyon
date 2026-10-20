import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Reply, ReplyAll, Forward, CloudOff, Archive, Trash2, AlertOctagon, Star, Clock, MoreHorizontal, Sparkles, Paperclip, Download, Image as ImageIcon,
  CalendarPlus, CheckSquare, Languages, Printer, FileCode, BellOff, ArrowLeft, Tag, Folder, MailOpen, Mail as MailIcon, AlertTriangle, Check, HelpCircle, X as XIcon, MapPin, Video, RefreshCw,
  ThumbsUp, ThumbsDown, Hourglass, CornerUpLeft, PenLine, ClipboardCheck,
} from 'lucide-react';
import { api, stream, onEvent } from '../api.js';
import { store } from '../store.js';
import { fmtFull, fmtSize, addrLabel, addrFull, toast, toastError, navigate, textToHtml, escapeHtml, CATEGORY_COLORS } from '../util.js';
import { Avatar, useMenu, Spinner, Markdown } from '../components/common.jsx';
import { openComposer, replyPayload } from './Composer.jsx';
import { mailAction, snoozeOptions, confirmDelete, afterSend } from './mailActions.js';
import { EventEditor } from '../calendar/CalendarView.jsx';
import { loadFolders } from '../data.js';
import { QUOTE_HEAD, splitPlainQuote } from '../../../server/src/util/quotes.js';
import { topicView, categoryView } from './MailView.jsx';

// Recently opened conversations (per page load), shown instantly when reopened.
const threadCache = new Map();

export default function Reader({ id, view }) {
  const [thread, setThread] = useState(null);
  const [loading, setLoading] = useState(false);
  const [allowImages, setAllowImages] = useState(false);
  const [expanded, setExpanded] = useState(new Set());
  const [eventDraft, setEventDraft] = useState(null);
  const [aiWorking, setAiWorking] = useState(false);
  const [showAll, setShowAll] = useState(false);
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
      const t = { ...data, related: data.related || m.related || { tasks: [], events: [], drafts: [] }, current: m };
      setThread(t);
      const last = data.messages[data.messages.length - 1];
      const ex = new Set([m.id, last.id, ...data.messages.filter((x) => !x.isRead).map((x) => x.id)]);
      setExpanded(ex);
      if (!images) { threadCache.delete(id); threadCache.set(id, { thread: t, expanded: ex }); if (threadCache.size > 40) threadCache.delete(threadCache.keys().next().value); }
    } catch (e) {
      setThread(null);
      threadCache.delete(id);
      // Gone (moved or deleted, here or by another mail app): say so and refresh the list instead of an error.
      if (e.status === 404) window.dispatchEvent(new Event('halcyon:poll')); else toastError(e);
    } finally { setLoading(false); }
  }, [id, conv, allowImages]);

  useEffect(() => {
    setAllowImages(false); setShowAll(false);
    // A conversation opened before shows at once; the fresh copy replaces it when it arrives.
    const c = conv && threadCache.get(id);
    if (c) { setThread(c.thread); setExpanded(c.expanded); }
    load(false);
  }, [id, conv]);

  useEffect(() => onEvent((e) => {
    if (!thread) return;
    if (e.type === 'ai:insight' && thread.messages.some((m) => m.id === e.payload.messageId)) {
      setThread((t) => ({ ...t, messages: t.messages.map((m) => (m.id === e.payload.messageId ? { ...m, insight: e.payload.insight } : m)), current: t.current.id === e.payload.messageId ? { ...t.current, insight: e.payload.insight } : t.current }));
    }
    if (e.type === 'ai:thread' && e.payload.threadId === thread.current.threadId) setThread((t) => ({ ...t, summary: e.payload.summary }));
    if (e.type === 'ai:draft' && thread.messages.some((m) => m.id === e.payload.messageId)) load();
    // A reply was just delivered: show it in the conversation.
    if (e.type === 'mail:sent') load();
  }), [thread]);
  useEffect(() => { const h = () => load(); window.addEventListener('halcyon:sent', h); return () => window.removeEventListener('halcyon:sent', h); }, [thread]);

  // Keyboard reply shortcuts dispatched from the list.
  useEffect(() => {
    const h = (e) => thread && reply(e.detail.mode);
    window.addEventListener('halcyon:reply', h);
    return () => window.removeEventListener('halcyon:reply', h);
  });

  if (!id) return <section className="reader"><div className="empty" style={{ margin: 'auto' }}><MailIcon size={44} strokeWidth={1.2} /><div>Select a message to read</div><div className="small">Shortcuts: j/k navigate · r reply · a reply all · f forward · e archive · # delete · s flag · / search · c compose</div></div></section>;
  if (!thread) return <section className="reader"><div className="empty" style={{ margin: 'auto' }}>{loading ? <Spinner size={22} /> : <div style={{ textAlign: 'center' }}><div>This message is no longer here.</div><div className="small muted">It was moved or deleted (possibly in another mail app). The list has been refreshed.</div></div>}</div></section>;

  const msgs = thread.messages;
  const latest = [...msgs].reverse().find((m) => m.folder?.specialUse !== '\\Sent') || msgs[msgs.length - 1];
  const target = thread.current;
  const ins = latest.insight || target.insight;
  const ids = conv ? msgs.filter((m) => m.folder?.specialUse !== '\\Sent').map((m) => m.id) : [target.id];
  const act = (requested, extra) => {
    const action = confirmDelete(requested, target.folder?.specialUse, 1);
    if (!action) return;
    mailAction(action, ids.length ? ids : [target.id], extra, { onDone: (undone) => { if (undone) load(); else if (['archive', 'trash', 'spam', 'move', 'snooze', 'delete'].includes(action)) navigate(`#/mail/${view}`); else load(); } });
  };
  // Reply / Reply all: continue an existing draft for that message instead of starting a second one.
  async function reply(mode, msg = latest, extra = {}) {
    if (mode !== 'forward' && !extra.aiIntent && thread?.related?.drafts?.some((d) => d.inReplyToId === msg.id)) {
      const d = (await api.get(`/api/drafts?inReplyTo=${msg.id}`).catch(() => []))[0];
      if (d) return openComposer({ ...d, draftId: d.id });
    }
    openComposer(replyPayload(mode, msg, store.get().accounts, extra));
  }
  const openDraft = async (draftId) => {
    const d = (await api.get('/api/drafts').catch(() => [])).find((x) => x.id === draftId);
    if (d) openComposer({ ...d, draftId: d.id });
  };
  const deleteDraft = async (draftId) => {
    if (!confirm('Delete this draft?')) return;
    await api.del(`/api/drafts/${draftId}`).catch(toastError);
    load();
  };
  const toggleTask = async (t) => { await api.patch(`/api/tasks/${t.id}`, { done: !t.done }).catch(toastError); load(); };
  const setNeedsReply = async (value) => {
    try { await api.post('/api/messages/needs-reply', { ids: [latest.id], value }); toast(value ? 'Marked as needs reply' : 'Removed “needs reply”'); load(); } catch (e) { toastError(e); }
  };

  const aiReply = async (intent) => {
    // Opens a reply composer that streams the AI draft into the body.
    openComposer(replyPayload('reply', latest, store.get().accounts, { aiIntent: intent ?? '' }));
  };

  // Corrections teach the AI (per sender) and fix this message right away.
  const feedback = async (kind, value) => {
    try {
      const r = await api.post(`/api/messages/${latest.id}/feedback`, { kind, value });
      setThread((t) => ({ ...t, messages: t.messages.map((m) => (m.id === latest.id ? { ...m, insight: r.insight } : m)), current: t.current.id === latest.id ? { ...t.current, insight: r.insight } : t.current }));
      toast(`Noted — future mail from ${r.sender} will be treated the same way`);
    } catch (e) { toastError(e); }
  };
  const forwardTo = async (messageId) => {
    try {
      const full = await api.get(`/api/messages/${messageId}`);
      openComposer({ ...replyPayload('forward', full, store.get().accounts), to: [latest.from] });
    } catch (e) { toastError(e); }
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
    store.set({ taskDialog: latest.id });
  };

  const translate = async (m) => {
    let out = '';
    setThread((t) => ({ ...t, translations: { ...(t.translations || {}), [m.id]: '…' } }));
    try {
      await stream('/api/ai/translate', { messageId: m.id }, { onToken: (tk) => { out += tk; setThread((t) => ({ ...t, translations: { ...t.translations, [m.id]: out } })); } });
    } catch (e) { toastError(e); }
  };

  const unsubscribe = async () => {
    if (!confirm(`Unsubscribe from ${target.from.name || target.from.address}? Halcyon contacts the sender's unsubscribe address for you.`)) return;
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
    { label: latest.insight?.needsReply ? 'Remove “needs reply”' : 'Mark as needs reply', icon: CornerUpLeft, onClick: () => setNeedsReply(!latest.insight?.needsReply) },
    settings.ai.enabled && { label: 'Mark as important', icon: ThumbsUp, hint: 'AI learns', onClick: () => feedback('important') },
    settings.ai.enabled && { label: 'Mark as not important', icon: ThumbsDown, hint: 'AI learns', onClick: () => feedback('unimportant') },
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

        {msgs.some((m) => m.notOnServer) && (
          <div className="banner warn">
            <CloudOff size={15} /><span className="grow">Sent, but the copy is not saved on the mail server yet — other mail apps will not show it in Sent.</span>
            <button className="btn sm" onClick={() => api.post('/api/messages/save-to-server', { ids: msgs.filter((m) => m.notOnServer).map((m) => m.id) }).then((r) => toast(r.queued ? 'Saving on the server…' : 'Nothing to save')).catch(toastError)}>Save on server</button>
          </div>
        )}
        <RelatedBar related={thread.related} onTask={toggleTask} onDraft={openDraft} onDeleteDraft={deleteDraft} />

        {ins?.isPhishing && <div className="notice danger" style={{ margin: '0 0 12px' }}><AlertTriangle size={16} /> This message looks suspicious. Don't click links or share credentials unless you're sure it's genuine.</div>}

        {settings.ai.enabled && <AiCard ins={ins} summary={thread.summary} count={msgs.length} latest={latest} aiWorking={aiWorking}
          onReply={aiReply} onEvent={addEvent} onTasks={createTasks} onFeedback={feedback} onNeedsReply={setNeedsReply}
          onDone={async () => { await api.post(`/api/messages/${latest.id}/dismiss`, {}).catch(toastError); toast('Marked as done'); load(); }} onForward={forwardTo} requester={latest.from} onAnalyze={async () => {
            setAiWorking(true);
            try { const i = await api.get(`/api/messages/${latest.id}/insight?wait=1`); setThread((t) => ({ ...t, messages: t.messages.map((m) => (m.id === latest.id ? { ...m, insight: i } : m)) })); if (msgs.length >= 2 && !thread.summary) { const s = await api.post('/api/ai/thread-summary', { threadId: latest.threadId }); setThread((t) => ({ ...t, summary: s.summary })); } } catch (e) { toastError(e); } finally { setAiWorking(false); }
          }} />}

        {msgs.map((m, i) => {
          // Long conversations: collapsed messages between the first and the last two fold into one row.
          const foldable = !showAll && msgs.length > 4 && i > 0 && i < msgs.length - 2 && !expanded.has(m.id);
          if (foldable) {
            const prev = i > 1 && !expanded.has(msgs[i - 1].id);
            if (prev) return null;
            let n = 0; while (i + n < msgs.length - 2 && !expanded.has(msgs[i + n].id)) n++;
            return <button key={`fold${m.id}`} className="thread-fold" onClick={() => setShowAll(true)}>{n} earlier message{n > 1 ? 's' : ''}</button>;
          }
          return <MessageCard key={m.id} m={m} expanded={expanded.has(m.id) || msgs.length === 1} toggle={() => setExpanded((s) => { const x = new Set(s); x.has(m.id) ? x.delete(m.id) : x.add(m.id); return x; })}
            onReply={(mode) => reply(mode, m)} onShowImages={() => { setAllowImages(true); load(true); }} translation={thread.translations?.[m.id]} onInviteChanged={load} />;
        })}

        <QuickReply latest={latest} onSent={() => load()} hasDraft={!!ins?.draftReply} />
      </div>
      {menuNode}
      {eventDraft && <EventEditor initial={eventDraft} onClose={() => setEventDraft(null)} onSaved={() => { setEventDraft(null); toast('Event added to calendar', { action: { label: 'Open', onClick: () => navigate('#/calendar') } }); }} />}
    </section>
  );
}

const AI_STATUS_TEXT = {
  pending: 'Analysis queued in the background…',
  waiting: 'Waiting for an AI provider — add one in Settings → AI.',
  failed: 'Background analysis failed — see Settings → AI → Status.',
  none: 'Not analyzed automatically (only recent mail in analysed folders is).',
};

const CATEGORIES = ['personal', 'work', 'finance', 'shopping', 'travel', 'newsletter', 'promotion', 'social', 'notification', 'security', 'calendar', 'support', 'other'];

function AiCard({ ins, summary, count, latest, onReply, onEvent, onTasks, onAnalyze, aiWorking, onFeedback, onForward, requester, onNeedsReply, onDone }) {
  const [openMenu, menuNode] = useMenu();
  if (!ins && !summary) {
    return <div className="card ai-card"><div className="row"><div className="title" style={{ margin: 0 }}><Sparkles size={15} /> AI assistant</div><span className="grow small faint">{AI_STATUS_TEXT[latest.aiStatus] || 'Not analyzed yet.'}</span>
      <button className="btn sm ai" onClick={onAnalyze} disabled={aiWorking}>{aiWorking ? <Spinner size={13} /> : <Sparkles size={13} />} Analyze now</button></div></div>;
  }
  return (
    <div className="card ai-card">
      <div className="title" style={{ flexWrap: 'wrap' }}><Sparkles size={15} /> {count > 1 && summary ? `Conversation summary · ${count} messages` : 'Summary'}
        <span className="row" style={{ marginLeft: 'auto', gap: 4, flexWrap: 'wrap' }}>
          {ins?.expired && <span className="chip" title="Time-sensitive content (e.g. a login code) that is no longer valid"><Hourglass size={11} /> expired</span>}
          {ins?.topic && <a className="chip topic" href={`#/mail/${topicView(ins.topic)}`} title={`Show all mail about “${ins.topic}”`}>#{ins.topic}</a>}
          {ins?.category && <button className="chip" style={{ border: 0, cursor: 'pointer' }} title="Show this category, or change it (the AI learns from it)"
            onClick={(e) => openMenu(e, [{ label: `Show all ${ins.category} mail`, onClick: () => navigate(`#/mail/${categoryView(ins.category)}`) }, 'sep', { section: 'Change category' }, ...CATEGORIES.map((c) => ({ label: c === ins.category ? `${c} ✓` : c, onClick: () => onFeedback('category', c) }))])}>{ins.category} ▾</button>}
          {ins?.priority != null && <span className="chip" style={{ background: ins.priority >= 70 ? '#fee2e2' : undefined, color: ins.priority >= 70 ? '#991b1b' : undefined }}>Priority {ins.priority}{ins.priorityReason ? ` · ${ins.priorityReason}` : ''}</span>}
          {ins && <button className={`chip ${ins.needsReply ? 'ai' : ''}`} style={{ border: 0, cursor: 'pointer' }} title={ins.needsReply ? 'Remove “needs reply”' : 'Mark as needs reply'} onClick={() => onNeedsReply(!ins.needsReply)}>
            <CornerUpLeft size={11} /> {ins.needsReply ? 'Needs reply ✕' : 'Needs reply?'}</button>}
          {ins && <button className="icon-btn" style={{ width: 26, height: 26 }} title="Important — the AI learns from this" onClick={() => onFeedback('important')}><ThumbsUp size={14} /></button>}
          {ins && <button className="icon-btn" style={{ width: 26, height: 26 }} title="Not important — the AI learns from this" onClick={() => onFeedback('unimportant')}><ThumbsDown size={14} /></button>}
        </span>
      </div>
      {menuNode}
      {summary ? <Markdown text={summary} /> : <div>{ins?.summary}</div>}
      {ins?.needsAction && !ins.expired && <div className={`notice action-needed ${ins.dismissed ? 'done' : ''}`} style={{ margin: '8px 0 0' }}>
        <ClipboardCheck size={15} /><span className="grow"><b>Action needed{ins.needsReply ? '' : ' (no reply needed)'}:</b> {ins.actionSummary || 'see the email'}</span>
        {!ins.dismissed && <button className="btn sm" title="Done — removes it from Action needed and the brief" onClick={() => onDone()}>✓ Done</button>}
      </div>}
      {ins?.requests?.map((rq, i) => (
        <div key={i} className="notice" style={{ display: 'block', margin: '8px 0 0' }}>
          <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}><Forward size={13} /> {requester?.name || requester?.address} asks for an earlier email{rq.description && rq.description !== 'requested email' ? `: ${rq.description}` : ''}</div>
          {rq.candidates.length ? rq.candidates.map((c) => (
            <div key={c.id} className="row small" style={{ padding: '3px 0' }}>
              <a href={`#/mail/unified/${c.id}`} className="grow truncate">{c.hasAttachments && <Paperclip size={11} />} {c.subject || '(no subject)'} <span className="faint">· {c.from} · {new Date(c.date).toLocaleDateString()}</span></a>
              <button className="btn sm" onClick={() => onForward(c.id)}><Forward size={12} /> Forward to {requester?.name?.split(' ')[0] || requester?.address}</button>
            </div>)) : <div className="small faint">No matching email found — try search.</div>}
        </div>))}
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

/** Tasks, events and draft replies created from this message / conversation. */
function RelatedBar({ related, onTask, onDraft, onDeleteDraft }) {
  if (!related || (!related.tasks.length && !related.events.length && !related.drafts.length)) return null;
  const when = (t, allDay) => new Date(t).toLocaleString([], allDay ? { weekday: 'short', day: 'numeric', month: 'short' } : { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return (
    <div className="related-bar">
      {related.drafts.map((d) => (
        <div key={`d${d.id}`} className="related-item draft">
          <PenLine size={14} /><span className="grow truncate"><b>Your draft reply</b> · {when(d.updatedAt)}{d.onServer ? ' · in Drafts folder' : ''}{d.snippet ? ` — ${d.snippet}` : ''}</span>
          <button className="btn sm primary" onClick={() => onDraft(d.id)}>Continue</button>
          <button className="icon-btn" title="Delete draft" onClick={() => onDeleteDraft(d.id)}><Trash2 size={14} /></button>
        </div>))}
      {related.tasks.map((t) => (
        <div key={`t${t.id}`} className={`related-item ${t.done ? 'done' : ''}`}>
          <input type="checkbox" checked={t.done} onChange={() => onTask(t)} title={t.done ? 'Mark as not done' : 'Mark as done'} />
          <span className="grow truncate"><b>Task:</b> {t.title}{t.due ? <span className="faint"> · due {when(t.due)}</span> : ''}</span>
          <a href="#/tasks" className="small">Tasks</a>
        </div>))}
      {related.events.map((e) => (
        <div key={`e${e.id}`} className="related-item">
          <CalendarPlus size={14} /><span className="grow truncate"><b>Event:</b> {e.title} <span className="faint">· {when(e.start, e.allDay)}{e.location ? ` · ${e.location}` : ''}</span></span>
          <a href="#/calendar" className="small">Calendar</a>
        </div>))}
    </div>
  );
}

/** One header line (To / Cc / Bcc): names, full address on hover; long lists folded to "and N more". */
function AddrLine({ label, list, empty }) {
  const [all, setAll] = useState(false);
  if (!list?.length && !empty) return null;
  const shown = all ? list : (list || []).slice(0, 6);
  return (
    <div className="small muted addr-line">
      <span className="addr-label">{label}</span>
      {!list?.length ? <span>{empty}</span> : <span>
        {shown.map((a, i) => <span key={i} title={addrFull(a)}>{addrLabel(a)}{i < shown.length - 1 ? ', ' : ''}</span>)}
        {list.length > shown.length && <> <button className="link-btn" onClick={() => setAll(true)}>and {list.length - shown.length} more</button></>}
      </span>}
    </div>
  );
}

function MessageCard({ m, expanded, toggle, onReply, onShowImages, translation, onInviteChanged }) {
  const realAtts = (m.attachments || []).filter((a) => !a.inline);
  return (
    <div className={`card msg-card ${expanded ? '' : 'collapsed'}`}>
      <div className="msg-card-head" onClick={toggle}>
        <Avatar name={m.from.name} email={m.from.address} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row"><span className="who truncate">{m.from.name || m.from.address}</span>{expanded && m.from.name && <span className="small faint truncate">&lt;{m.from.address}&gt;</span>}<span className="grow" /><span className="small muted" style={{ flex: 'none' }}>{fmtFull(m.date)}</span></div>
          {expanded ? <div className="addr-lines" onClick={(e) => e.stopPropagation()}>
            <AddrLine label="To" list={m.to} empty="undisclosed recipients" />
            <AddrLine label="Cc" list={m.cc} />
            <AddrLine label="Bcc" list={m.bcc} />
          </div>
            : <div className="small muted truncate">{realAtts.length > 0 && <><Paperclip size={11} /> {realAtts.length} · </>}{m.snippet}</div>}
          {/* Attachments right under the header, so they are not missed below a long message. */}
          {expanded && realAtts.length > 0 && <div className="att-chips" onClick={(e) => e.stopPropagation()}>
            {realAtts.map((a) => <a key={a.index} className="att-chip" href={api.url(`/api/messages/${m.id}/attachments/${a.index}?inline=1`)} target="_blank" rel="noreferrer" title={`${a.filename} · ${fmtSize(a.size || 0)}`}>
              <Paperclip size={11} /><span className="truncate">{a.filename}</span></a>)}
          </div>}
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
        <div className="msg-body">{m.html ? <HtmlFrame html={m.html} /> : <PlainBody text={m.text} />}</div>
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
// Where quoted history starts in an HTML email (Gmail, Outlook incl. Slovenian headers, Apple/Thunderbird, Halcyon).
const QUOTE_SELECTORS = ['[data-quote]', '.gmail_quote', '.gmail_extra', 'blockquote[type="cite"]', '#divRplyFwdMsg', '#appendonsend', '.moz-cite-prefix', '.yahoo_quoted', 'div[style*="border-top:solid #E1E1E1"]', 'div[style*="border-top: solid #E1E1E1"]', 'div[style*="border-top:solid #B5C4DF"]'];

function findQuoteStart(doc) {
  const body = doc.body;
  let el = null;
  for (const sel of QUOTE_SELECTORS) { el = body.querySelector(sel); if (el) break; }
  // The first element (document order) whose text starts with an attribution or a forwarded/original header.
  if (!el) el = [...body.querySelectorAll('div, p, span, td, font')].find((n) => QUOTE_HEAD.test((n.textContent || '').slice(0, 400)))
    || body.querySelector(':scope > blockquote, :scope > div > blockquote');
  if (!el) return null;
  // Only fold when the user-visible part before the quote has content (not for pure forwards).
  const range = doc.createRange();
  range.setStart(body, 0); range.setEndBefore(el);
  return range.toString().trim().length > 0 ? el : null;
}

/** Hides (or shows) the quote element and everything after it, at every level up to <body>. */
function setQuoteHidden(doc, start, hidden) {
  const nodes = [];
  for (let n = start; n && n !== doc.body; n = n.parentElement) {
    for (let s = n === start ? n : n.nextElementSibling; s; s = s.nextElementSibling) nodes.push(s);
  }
  for (const n of nodes) n.style.display = hidden ? 'none' : '';
}

function HtmlFrame({ html }) {
  const ref = useRef();
  const [h, setH] = useState(120);
  const [quote, setQuote] = useState(null); // { el, hidden }
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
  const onLoad = () => {
    const d = ref.current?.contentDocument;
    const el = d?.body && findQuoteStart(d);
    if (el) { setQuoteHidden(d, el, true); setQuote({ el, hidden: true }); } else setQuote(null);
    measure(); setTimeout(measure, 300);
  };
  const toggle = () => {
    const d = ref.current?.contentDocument;
    if (!d || !quote) return;
    setQuoteHidden(d, quote.el, !quote.hidden);
    setQuote({ ...quote, hidden: !quote.hidden });
    setTimeout(measure, 30);
  };
  return <>
    <iframe ref={ref} title="Message" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcDoc={doc} style={{ height: h }} onLoad={onLoad} />
    {quote && <button className="quote-toggle" onClick={toggle} title={quote.hidden ? 'Show the quoted earlier messages' : 'Hide quoted text'}>{quote.hidden ? '··· Show quoted text' : 'Hide quoted text'}</button>}
  </>;
}

/** Plain-text body with the quoted history ("On … wrote:", "> …") folded. */
function PlainBody({ text }) {
  const [open, setOpen] = useState(false);
  const q = splitPlainQuote(text);
  if (!q) return <pre className="plain">{linkify(text)}</pre>;
  return <>
    <pre className="plain">{linkify(q.own)}</pre>
    <button className="quote-toggle" onClick={() => setOpen(!open)}>{open ? 'Hide quoted text' : `··· Show quoted text (${q.lines} lines)`}</button>
    {open && <pre className="plain quoted">{linkify(q.quoted)}</pre>}
  </>;
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

/** Reply box under the conversation: reply or reply all; what is typed is kept as a draft of this reply. */
function QuickReply({ latest, onSent, hasDraft }) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState('reply');
  const [busy, setBusy] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [draftId, setDraftId] = useState(null);
  const accounts = store.use((s) => s.accounts);
  const settings = store.use((s) => s.settings);
  const typed = useRef(false);
  const payloadFor = (m) => replyPayload(m, latest, accounts);
  const all = payloadFor('replyAll');
  const canReplyAll = all.to.length + all.cc.length > payloadFor('reply').to.length;

  // Restore an unfinished quick reply (saved as a draft) for this message.
  useEffect(() => {
    setText(''); setDraftId(null); setMode('reply'); typed.current = false;
    api.get(`/api/drafts?inReplyTo=${latest.id}`).then((l) => {
      const d = l.find((x) => x.quick);
      if (d) { setDraftId(d.id); setText(d.text || ''); setMode(d.mode || 'reply'); }
    }).catch(() => {});
  }, [latest.id]);

  // Autosave the typed text as a draft (deleted again when sent or emptied).
  useEffect(() => {
    if (!typed.current) return undefined;
    const t = setTimeout(async () => {
      try {
        if (!text.trim()) { if (draftId) { await api.del(`/api/drafts/${draftId}`); setDraftId(null); } return; }
        const p = payloadFor(mode);
        const r = await api.post('/api/drafts', { ...p, id: draftId, html: textToHtml(text) + (p.quoteHtml || ''), quick: true, text, mode });
        setDraftId(r.id);
      } catch { /* retried on next change */ }
    }, 1500);
    return () => clearTimeout(t);
  }, [text, mode]);

  const send = async () => {
    setBusy(true);
    try {
      const p = payloadFor(mode);
      const r = await api.post('/api/send', { ...p, html: textToHtml(text) + (p.quoteHtml || ''), draftId: draftId || undefined });
      setText(''); setDraftId(null); typed.current = false;
      afterSend(r);
      if (settings.mail.undoSendSeconds > 0) {
        toast('Sending…', { duration: settings.mail.undoSendSeconds * 1000, action: { label: 'Undo', onClick: async () => {
          try { const c = await api.post(`/api/outbox/${r.id}/cancel`); openComposer({ ...c.payload, draftId: null }); } catch { toast('Too late — message already sent', { kind: 'error' }); }
        } } });
      } else toast('Sent');
      onSent?.();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const draft = async () => {
    setGenBusy(true); setText(''); typed.current = true;
    try {
      if (hasDraft) { const r = await api.post('/api/ai/draft-reply', { messageId: latest.id }); setText(r.text); }
      else { let t = ''; await stream('/api/ai/draft-reply', { messageId: latest.id, stream: true }, { onToken: (x) => { t += x; setText(t); } }); }
    } catch (e) { toastError(e); } finally { setGenBusy(false); }
  };
  const p = payloadFor(mode);
  const recipients = [...p.to, ...p.cc].map((a) => a.name || a.address);
  return (
    <div className="card quick-reply">
      <div className="row small" style={{ marginBottom: 6, gap: 6 }}>
        <div className="seg">
          <button className={mode === 'reply' ? 'on' : ''} onClick={() => { setMode('reply'); typed.current = true; }}><Reply size={13} /> Reply</button>
          <button className={mode === 'replyAll' ? 'on' : ''} disabled={!canReplyAll} title={canReplyAll ? '' : 'There are no other recipients'} onClick={() => { setMode('replyAll'); typed.current = true; }}><ReplyAll size={13} /> Reply all</button>
        </div>
        <span className="faint truncate" title={recipients.join(', ')}>to {recipients.slice(0, 4).join(', ')}{recipients.length > 4 ? ` +${recipients.length - 4}` : ''}</span>
        {draftId && <span className="faint" style={{ marginLeft: 'auto' }}>Draft saved</span>}
      </div>
      <textarea className="input" rows={text ? 6 : 2} placeholder={`Quick ${mode === 'replyAll' ? 'reply to all' : 'reply'} to ${latest.from.name || latest.from.address}…`} value={text}
        onChange={(e) => { typed.current = true; setText(e.target.value); }}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim()) send(); }} />
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn primary" disabled={!text.trim() || busy} onClick={send}>{busy ? <Spinner size={14} /> : <Reply size={15} />} Send</button>
        <button className="btn ai" disabled={genBusy} onClick={draft}>{genBusy ? <Spinner size={14} /> : <Sparkles size={15} />} {hasDraft ? 'Insert AI draft' : 'Draft with AI'}</button>
        {text && <button className="btn ghost" onClick={() => { openComposer({ ...payloadFor(mode), prefixHtml: textToHtml(text), draftId: draftId || undefined }); setText(''); setDraftId(null); typed.current = false; }}>Open in editor</button>}
        <span className="grow" /><span className="small faint">Ctrl+Enter to send</span>
      </div>
    </div>
  );
}

function printThread(msgs) {
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.write(`<html><head><title>${escapeHtml(msgs[0].subject)}</title><style>body{font-family:system-ui;padding:20px;max-width:800px;margin:auto}hr{margin:24px 0}.h{color:#555;font-size:13px}</style></head><body><h2>${escapeHtml(msgs[0].subject)}</h2>${msgs.map((m) => `<div class="h"><b>${escapeHtml(addrFull(m.from))}</b><br>To: ${escapeHtml(m.to.map(addrFull).join(', '))}${m.cc?.length ? `<br>Cc: ${escapeHtml(m.cc.map(addrFull).join(', '))}` : ''}<br>${fmtFull(m.date)}</div>${m.html || `<pre style="white-space:pre-wrap">${escapeHtml(m.text)}</pre>`}`).join('<hr>')}</body></html>`);
  w.document.close();
  setTimeout(() => w.print(), 400);
}
