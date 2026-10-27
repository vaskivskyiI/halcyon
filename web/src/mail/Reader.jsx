import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Reply, ReplyAll, Forward, CloudOff, Archive, Trash2, AlertOctagon, Star, Clock, MoreHorizontal, Sparkles, Paperclip, Download, Image as ImageIcon,
  CalendarPlus, CheckSquare, Languages, Printer, FileCode, BellOff, ArrowLeft, Tag, Folder, MailOpen, Mail as MailIcon, AlertTriangle, Check, HelpCircle, X as XIcon, MapPin, Video, RefreshCw,
  ThumbsUp, ThumbsDown, Hourglass, CornerUpLeft, PenLine, ClipboardCheck, Send, Pencil, ChevronDown, Zap,
} from 'lucide-react';
import { api, stream, onEvent } from '../api.js';
import { store } from '../store.js';
import { BackButton, jump } from '../back.js';
import { extraMenuItems, runQuickStep } from './extras.js';
import { fmtFull, fmtSize, addrLabel, addrFull, toast, toastError, navigate, textToHtml, escapeHtml, CATEGORY_COLORS } from '../util.js';
import { Avatar, useMenu, Spinner, Markdown } from '../components/common.jsx';
import { openComposer, replyPayload, Composer } from './Composer.jsx';
import { mailAction, snoozeOptions, confirmDelete, afterSend } from './mailActions.js';
import { EventEditor, showCalendarDate } from '../calendar/CalendarView.jsx';
import PersonProfile from '../components/PersonProfile.jsx';
import { loadFolders, setSpace } from '../data.js';
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
  const scroller = useRef();
  // Opening a conversation: start at its first unread message (as it was when opened), else at the top.
  const placedFor = useRef(null);
  const firstUnread = useRef(null);
  const labels = store.use((s) => s.labels);
  const quickSteps = store.use((s) => s.quickSteps);
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
      const muted = m.threadId ? (await api.get(`/api/threads/${encodeURIComponent(m.threadId)}/muted`).catch(() => ({}))).muted : false;
      const t = { ...data, related: data.related || m.related || { tasks: [], events: [], drafts: [] }, current: m, muted };
      setThread(t);
      store.set({ focusAccountId: m.accountId }); // new mail defaults to the account of the message being read
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
    if (!thread || thread.current?.id !== Number(id) || placedFor.current === id) return;
    placedFor.current = id;
    const unread = thread.messages.find((m) => !m.isRead && !m.isDraft);
    firstUnread.current = unread?.id || null;
    requestAnimationFrame(() => {
      const el = unread && scroller.current?.querySelector(`[data-msg="${unread.id}"]`);
      if (el && thread.messages.length > 1) el.scrollIntoView({ block: 'start' });
      else if (scroller.current) scroller.current.scrollTop = 0;
    });
  }, [thread, id]);

  // Opened = read (after the configured delay, if it is still the message shown): every unread message shown here.
  // Runs again whenever what is unread changes (a cached copy is shown first, then the fresh one), and always includes
  // the message that was opened (the conversation may show another copy of it, e.g. the one in Archive).
  const unreadKey = thread?.current?.id === Number(id)
    ? [...new Set([...(thread.messages || []).filter((x) => !x.isRead).map((x) => x.id), ...(thread.current.isRead ? [] : [thread.current.id])])].join(',') : '';
  useEffect(() => {
    const unread = unreadKey ? unreadKey.split(',').map(Number) : [];
    const delay = settings.mail.markReadAfterMs;
    if (!unread.length || delay < 0 || store.get().readOnly) return undefined; // read-only session: nothing changes
    const t = setTimeout(() => {
      if (location.hash.replace(/[?].*$/, '').split('/').pop() !== String(id)) return; // still the message shown
      api.post('/api/messages/actions', { ids: unread, action: 'read' }).then(() => loadFolders()).catch(() => {});
      setThread((th) => th && { ...th, current: { ...th.current, isRead: true }, messages: th.messages.map((x) => (unread.includes(x.id) ? { ...x, isRead: true } : x)) });
      window.dispatchEvent(new CustomEvent('halcyon:read', { detail: { ids: unread, threadId: thread?.current?.threadId } }));
    }, delay);
    return () => clearTimeout(t);
  }, [unreadKey]);

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

  // Discarded draft versions (in Trash etc.) are left out of the conversation, unless that is what was opened.
  const msgs = thread.messages.filter((m) => !isLeftoverDraft(m) || m.id === Number(id));
  // Drafts are shown as editors: Halcyon drafts of this conversation, and drafts in the Drafts folder (also from other
  // mail apps) — one editor per draft (a Halcyon draft's copy in the Drafts folder is not shown twice).
  const latest = [...msgs].reverse().find((m) => !isDraftMsg(m) && m.folder?.specialUse !== '\\Sent') || msgs[msgs.length - 1];
  const drafts = (thread.related?.drafts || []).filter((d) => !(d.quick && d.inReplyToId === latest.id)); // that one is in the quick reply box
  const adopted = new Set(drafts.map((d) => d.serverMsgid).filter(Boolean));
  const target = thread.current;
  const ins = latest.insight || target.insight;
  const ids = conv ? msgs.filter((m) => !isDraftMsg(m) && m.folder?.specialUse !== '\\Sent').map((m) => m.id) : [target.id];
  const act = (requested, extra) => {
    const action = confirmDelete(requested, target.folder?.specialUse, 1);
    if (!action) return;
    mailAction(action, ids.length ? ids : [target.id], extra, { onDone: (undone) => { if (undone) load(); else if (['archive', 'trash', 'spam', 'move', 'snooze', 'delete'].includes(action)) navigate(`#/mail/${view}`); else load(); } });
  };
  // Reply / Reply all: continue an existing draft for that message instead of starting a second one.
  async function reply(mode, msg = latest, extra = {}) {
    const inline = mode !== 'forward' && !extra.aiIntent && drafts.find((d) => d.inReplyToId === msg.id);
    const el = inline && document.querySelector(`[data-draft="${inline.id}"]`);
    if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.querySelector('.editor')?.focus(); return; }
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

  // Corrections teach the AI and fix this message right away: without a reason for the sender, with one as a rule
  // the AI applies to similar mail (from anyone).
  const feedback = async (kind, value, reason) => {
    try {
      const r = await api.post(`/api/messages/${latest.id}/feedback`, { kind, value, reason });
      setThread((t) => ({ ...t, messages: t.messages.map((m) => (m.id === latest.id ? { ...m, insight: r.insight } : m)), current: t.current.id === latest.id ? { ...t.current, insight: r.insight } : t.current }));
      if (reason) toast(`Noted — the AI will use your reason for similar mail${r.rechecked ? ` (checking ${r.rechecked} recent email${r.rechecked > 1 ? 's' : ''} again)` : ''}`);
      else toast(`Noted — future mail from ${r.sender} will be treated the same way. Add a reason to make it a rule for similar mail instead.`);
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
    ...extraMenuItems({ msg: latest, ids: [target.id], muted: thread.muted, onDone: () => load() }),
  ]);

  const moveMenu = (e) => openMenu(e, folders.accounts.flatMap((a) => [{ section: a.email }, ...a.folders.map((f) => ({ label: f.name, icon: Folder, onClick: () => act('move', { folderId: f.id }) }))]));
  const snoozeMenu = (e) => openMenu(e, [...snoozeOptions().map(([label, until]) => ({ label, hint: new Date(until).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }), onClick: () => act('snooze', { until }) })),
    target.snoozedUntil && { label: 'Unsnooze', onClick: () => act('unsnooze') }]);

  return (
    <section className="reader">
      <div className="reader-toolbar">
        <button className="icon-btn mobile-only" onClick={() => navigate(`#/mail/${view}`)}><ArrowLeft size={18} /></button>
        <BackButton />
        <button className="btn ghost" onClick={() => reply('reply')}><Reply size={16} /> Reply</button>
        <button className="btn ghost" onClick={() => reply('replyAll')}><ReplyAll size={16} /> All</button>
        <button className="btn ghost" onClick={() => reply('forward')}><Forward size={16} /> Forward</button>
        <span className="grow" />
        <button className="icon-btn" title="Archive (e)" onClick={() => act('archive')}><Archive size={17} /></button>
        <button className="icon-btn" title="Delete (#)" onClick={() => act('trash')}><Trash2 size={17} /></button>
        <button className="icon-btn" title="Move" onClick={moveMenu}><Folder size={17} /></button>
        <button className="icon-btn" title="Snooze" onClick={snoozeMenu}><Clock size={17} /></button>
        <button className="icon-btn" title="Flag (s)" onClick={() => act(target.isFlagged ? 'unflag' : 'flag')}><Star size={17} fill={target.isFlagged ? '#f59e0b' : 'none'} color={target.isFlagged ? '#f59e0b' : 'currentColor'} /></button>
        {(quickSteps || []).slice(0, 3).map((q) => <button key={q.id} className="btn ghost sm" title={`Quick step: ${q.name}`} onClick={() => runQuickStep(q, ids.length ? ids : [target.id], () => navigate(`#/mail/${view}`))}><Zap size={14} /> {q.name}</button>)}
        <button className="icon-btn" title="More" onClick={moreMenu}><MoreHorizontal size={17} /></button>
      </div>
      <div className="reader-scroll" ref={scroller}>
        <h1>{target.subject || '(no subject)'}</h1>
        <div className="row" style={{ gap: 6, marginTop: -6, marginBottom: 12, flexWrap: 'wrap' }}>
          {target.folder && <span className="chip"><Folder size={11} /> {target.folder.name}</span>}
          {ins?.category && <span className="chip" style={{ color: CATEGORY_COLORS[ins.category] }}>{ins.category}</span>}
          {target.labels?.map((lid) => { const l = labels.find((x) => x.id === lid); return l && <span key={lid} className="chip" style={{ background: l.color, color: '#fff' }}>{l.name}</span>; })}
          {(target.myCategories || []).map((cid) => { const c = (folders.custom || []).find((x) => x.id === cid); return c && <a key={`c${cid}`} className="chip" style={{ color: c.color || 'var(--accent)' }} href={`#/mail/my~${c.id}`}><Tag size={11} /> {c.name}</a>; })}
          {(folders.custom || []).length > 0 && <button className="chip" style={{ border: 0, cursor: 'pointer' }} title="Add to one of your categories, or take it out"
            onClick={(e) => openMenu(e, [{ section: 'My categories' }, ...folders.custom.map((c) => {
              const inIt = (target.myCategories || []).includes(c.id);
              return { label: `${inIt ? '✓ ' : ''}${c.name}`, hint: inIt ? 'take out' : 'add', onClick: async () => {
                try { await api.post(`/api/custom-categories/${c.id}/tag`, { ids: [target.id], value: !inIt }); toast(inIt ? `Taken out of “${c.name}”` : `Added to “${c.name}”`); load(); loadFolders(); } catch (err) { toastError(err); }
              } };
            })])}><Tag size={11} /> ▾</button>}
        </div>

        {msgs.some((m) => m.notOnServer) && (
          <div className="banner warn">
            <CloudOff size={15} /><span className="grow">Sent, but the copy is not saved on the mail server yet — other mail apps will not show it in Sent.</span>
            <button className="btn sm" onClick={() => api.post('/api/messages/save-to-server', { ids: msgs.filter((m) => m.notOnServer).map((m) => m.id) }).then((r) => toast(r.queued ? 'Saving on the server…' : 'Nothing to save')).catch(toastError)}>Save on server</button>
          </div>
        )}
        {/* Tasks and events made from this mail: inside the AI card next to the suggestions; here only without it. */}
        {!(settings.ai.enabled && !isDraftMsg(latest)) && <RelatedBar related={{ ...thread.related, drafts: [] }} onTask={toggleTask} onDraft={openDraft} onDeleteDraft={deleteDraft} />}

        {ins?.isPhishing && <div className="notice danger" style={{ margin: '0 0 12px' }}><AlertTriangle size={16} /> This message looks suspicious. Don't click links or share credentials unless you're sure it's genuine.</div>}

        {settings.ai.enabled && !isDraftMsg(latest) && <AiCard ins={ins} summary={thread.summary} count={msgs.length} latest={latest} aiWorking={aiWorking}
          onReply={aiReply} onEvent={addEvent} onTasks={createTasks} onFeedback={feedback} onNeedsReply={setNeedsReply} related={thread.related} onTask={toggleTask}
          onDone={async (resolution = 'done', undo = false) => {
            try {
              await api.post(`/api/messages/${latest.id}/dismiss`, undo ? { dismissed: false } : { resolution });
              toast(undo ? 'Back in Action needed' : resolution === 'skipped' ? 'Noted: not doing it — removed from Action needed' : resolution === 'wrong' ? 'Noted: not an action — the AI will learn from this' : 'Marked as done');
              load();
            } catch (e) { toastError(e); }
          }} onForward={forwardTo} requester={latest.from} onAnalyze={async () => {
            setAiWorking(true);
            try { const i = await api.get(`/api/messages/${latest.id}/insight?wait=1`); setThread((t) => ({ ...t, messages: t.messages.map((m) => (m.id === latest.id ? { ...m, insight: i } : m)) })); if (msgs.length >= 2 && !thread.summary) { const s = await api.post('/api/ai/thread-summary', { threadId: latest.threadId }); setThread((t) => ({ ...t, summary: s.summary })); } } catch (e) { toastError(e); } finally { setAiWorking(false); }
          }} />}

        {msgs.map((m, i) => {
          if (isDraftMsg(m)) return adopted.has(`<${m.messageId}>`) ? null : <ServerDraft key={m.id} m={m} onDone={() => load()} />;
          // Long conversations: collapsed messages between the first and the last two fold into one row.
          const foldable = !showAll && msgs.length > 4 && i > 0 && i < msgs.length - 2 && !expanded.has(m.id);
          if (foldable) {
            const prev = i > 1 && !expanded.has(msgs[i - 1].id);
            if (prev) return null;
            let n = 0; while (i + n < msgs.length - 2 && !expanded.has(msgs[i + n].id)) n++;
            return <button key={`fold${m.id}`} className="thread-fold" onClick={() => setShowAll(true)}>{n} earlier message{n > 1 ? 's' : ''}</button>;
          }
          return <MessageCard key={m.id} m={m} expanded={expanded.has(m.id) || msgs.length === 1} toggle={() => setExpanded((s) => { const x = new Set(s); x.has(m.id) ? x.delete(m.id) : x.add(m.id); return x; })}
            onReply={(mode) => reply(mode, m)} onShowImages={() => { setAllowImages(true); load(true); }} translation={thread.translations?.[m.id]} onInviteChanged={load}
            onExtractEvent={async () => { try { setEventDraft(await api.post('/api/ai/extract-event', { messageId: m.id })); } catch (e) { toastError(e); } }} />;
        })}

        {drafts.map((d) => <Composer key={`d${d.id}`} id={`inline-${d.id}`} inline init={{ ...d, draftId: d.id }} onDone={() => load()} />)}

        {!isDraftMsg(latest) && <QuickReply latest={latest} onSent={() => load()} hasDraft={!!ins?.draftReply} />}
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

function AiCard({ ins, summary, count, latest, onReply, onEvent, onTasks, onAnalyze, aiWorking, onFeedback, onForward, requester, onNeedsReply, onDone, related, onTask }) {
  const [openMenu, menuNode] = useMenu();
  const [suggesting, setSuggesting] = useState(false);
  // The AI's guess at the reason, put into the box for the user to edit (nothing is saved until they do).
  const suggest = async () => {
    setSuggesting(true);
    try { const r = await api.post(`/api/messages/${latest.id}/suggest-reason`, { kind: why.kind, value: why.value }); setWhy((w) => w && { ...w, text: r.reason }); } catch (e) { toastError(e); } finally { setSuggesting(false); }
  };
  // After a correction: an optional reason ("only the fake conferences — they …") makes it a rule for similar mail.
  const [why, setWhy] = useState(null);
  const correct = (kind, value) => { onFeedback(kind, value); setWhy({ kind, value, text: '' }); };
  useEffect(() => setWhy(null), [latest.id]);
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
            onClick={(e) => openMenu(e, [{ label: `Show all ${ins.category} mail`, onClick: () => jump(`#/mail/${categoryView(ins.category)}`) }, 'sep', { section: 'Change category' }, ...CATEGORIES.map((c) => ({ label: c === ins.category ? `${c} ✓` : c, onClick: () => correct('category', c) }))])}>{ins.category} ▾</button>}
          {ins?.priority != null && <span className="chip" style={{ background: ins.priority >= 70 ? '#fee2e2' : undefined, color: ins.priority >= 70 ? '#991b1b' : undefined }}>Priority {ins.priority}{ins.priorityReason ? ` · ${ins.priorityReason}` : ''}</span>}
          {ins && <button className={`chip ${ins.needsReply ? 'ai' : ''}`} style={{ border: 0, cursor: 'pointer' }} title={ins.needsReply ? 'Remove “needs reply”' : 'Mark as needs reply'} onClick={() => onNeedsReply(!ins.needsReply)}>
            <CornerUpLeft size={11} /> {ins.needsReply ? 'Needs reply ✕' : 'Needs reply?'}</button>}
          {ins && <button className="icon-btn" style={{ width: 26, height: 26 }} title="Important — the AI learns from this" onClick={() => correct('important')}><ThumbsUp size={14} /></button>}
          {ins && <button className="icon-btn" style={{ width: 26, height: 26 }} title="Not important — the AI learns from this" onClick={() => correct('unimportant')}><ThumbsDown size={14} /></button>}
        </span>
      </div>
      {menuNode}
      {why && <div className="why-box">
        <span className="small"><b>{{ important: 'Important', unimportant: 'Not important', category: `Category “${why.value}”` }[why.kind]}</b> — why? <span className="faint">Optional. With a reason the AI applies it to similar mail from anyone, instead of to everything from this sender — e.g. “only fake conferences: generic greeting, unknown organiser, fee to publish”. “Suggest” lets the AI guess it.</span></span>
        <textarea className="input" rows={why.text.length > 60 ? 3 : 2} style={{ resize: 'vertical', minHeight: 30, paddingTop: 5 }} autoFocus maxLength={500} value={why.text} placeholder="Your reason…" onChange={(e) => setWhy({ ...why, text: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && why.text.trim()) { e.preventDefault(); onFeedback(why.kind, why.value, why.text.trim()); setWhy(null); } if (e.key === 'Escape') setWhy(null); }} />
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <button className="btn sm ai" disabled={suggesting} title="Let the AI guess why — you can edit it before saving" onClick={suggest}>{suggesting ? <Spinner size={13} /> : <Sparkles size={13} />} Suggest</button>
          <button className="btn sm primary" disabled={!why.text.trim()} onClick={() => { onFeedback(why.kind, why.value, why.text.trim()); setWhy(null); }}>Save reason</button>
          <button className="btn sm ghost" onClick={() => setWhy(null)}>Skip</button>
        </div>
      </div>}
      {summary ? <Markdown text={summary} /> : <div>{ins?.summary}</div>}
      {/* Who the sender is and how the user writes with them (contact profile; editable). */}
      {requester?.address && <PersonProfile email={requester.address} name={requester.name} compact />}
      {ins?.resolution === 'replied' && !ins.needsAction && <div className="notice action-needed done" style={{ margin: '8px 0 0' }}>
        <CornerUpLeft size={15} /><span className="grow"><b>Answered</b>{ins.resolvedBy ? <> by <a href={`#/mail/unified/${ins.resolvedBy}`}>your email</a></> : ''}{ins.resolvedAt ? ` of ${new Date(ins.resolvedAt).toLocaleDateString([], { day: 'numeric', month: 'short' })}` : ''}</span>
        <button className="btn sm ghost" title="Your email did not answer it: put it back in Needs reply" onClick={() => onNeedsReply(true)}>Still needs a reply</button>
      </div>}
      {ins?.needsAction && !ins.expired && <div className={`notice action-needed ${ins.dismissed ? 'done' : ''}`} style={{ margin: '8px 0 0' }}>
        <ClipboardCheck size={15} />
        <span className="grow"><b>{ins.dismissed ? ({ skipped: 'Not doing it', wrong: 'Not an action', replied: 'Answered' }[ins.resolution] || 'Done') : `Action needed${ins.needsReply ? '' : ' (no reply needed)'}`}:</b> {ins.actionSummary || 'see the email'}
          {ins.dismissed && ins.resolvedAt && <span className="faint"> · {ins.resolvedBy ? <a href={`#/mail/unified/${ins.resolvedBy}`}>by your email</a> : ins.resolution === 'skipped' ? 'decided' : 'marked'} {new Date(ins.resolvedAt).toLocaleDateString([], { day: 'numeric', month: 'short' })}</span>}</span>
        {ins.dismissed ? <button className="btn sm ghost" title="Put it back in Action needed" onClick={() => onDone(null, true)}>{ins.resolvedBy ? 'Still open' : 'Undo'}</button> : <>
          <button className="btn sm" title="You did it — it leaves Action needed and the brief" onClick={() => onDone('done')}>✓ Done</button>
          <button className="btn sm ghost" title="You decided not to act on it — it leaves Action needed and the brief, and stays recorded as not done" onClick={() => onDone('skipped')}>Not doing it</button>
          <button className="link-btn small" title="The AI was wrong: this is not something for you to do (it learns this for the sender)" onClick={() => onDone('wrong')}>Not an action</button>
        </>}
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
      <FollowUp ins={ins} related={related} onTask={onTask} onTasks={onTasks} onEvent={onEvent} />
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

const when = (t, allDay) => new Date(t).toLocaleString([], allDay ? { weekday: 'short', day: 'numeric', month: 'short' } : { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * Follow-up in one place: what was already made from this mail (tasks, events) first, then the AI's suggestions —
 * so a task that exists is seen right next to "Add to tasks", and suggested events already in the calendar show so.
 */
function FollowUp({ ins, related, onTask, onTasks, onEvent }) {
  const tasks = related?.tasks || [], events = related?.events || [];
  const items = ins?.actionItems || [];
  const added = (e) => events.some((x) => Math.abs(x.start - Date.parse(e.start)) < 60e3 || (x.title || '').toLowerCase() === String(e.title || '').toLowerCase());
  const suggested = (ins?.events || []).filter((e) => !added(e));
  if (!tasks.length && !events.length && !items.length && !suggested.length) return null;
  return (
    <div className="follow-up">
      {tasks.map((t) => (
        <div key={`t${t.id}`} className={`related-item ${t.done ? 'done' : ''}`}>
          <input type="checkbox" checked={t.done} onChange={() => onTask(t)} title={t.done ? 'Mark as not done' : 'Mark as done'} />
          <CheckSquare size={14} /><span className="grow truncate"><b>Task{t.done ? ' (done)' : ''}:</b> {t.title}{t.due ? <span className="faint"> · due {when(t.due)}</span> : ''}</span>
          <a href="#/tasks" className="small">Tasks</a>
        </div>))}
      {events.map((e) => (
        <div key={`e${e.id}`} className="related-item">
          <CalendarPlus size={14} /><span className="grow truncate"><b>In calendar:</b> {e.title} <span className="faint">· {when(e.start, e.allDay)}{e.location ? ` · ${e.location}` : ''}</span></span>
          <a href="#/calendar" className="small">Calendar</a>
        </div>))}
      {items.length > 0 && (
        <div style={{ marginTop: tasks.length || events.length ? 6 : 0 }}>
          <div className="small muted" style={{ fontWeight: 600 }}>{tasks.length ? 'Action items (a task already exists)' : 'Action items'}</div>
          <ul>{items.map((a, i) => <li key={i}>{a.text}{a.due && <span className="faint"> · due {a.due}</span>}</li>)}</ul>
          {tasks.length ? <button className="link-btn small" onClick={() => onTasks(items)}>Add another task</button>
            : <button className="btn sm" onClick={() => onTasks(items)}><CheckSquare size={13} /> Add to tasks</button>}
        </div>
      )}
      {suggested.length > 0 && (
        <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
          {suggested.map((e, i) => <button key={i} className="btn sm" onClick={() => onEvent(e)} title={e.read ? `Read from the email as ${e.read.date}${e.read.time ? ` ${e.read.time}` : ''} (${e.read.tz})` : undefined}><CalendarPlus size={13} /> {e.title} · {new Date(e.start).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</button>)}
        </div>
      )}
    </div>
  );
}

/** Tasks, events and draft replies created from this message / conversation. */
function RelatedBar({ related, onTask, onDraft, onDeleteDraft }) {
  if (!related || (!related.tasks.length && !related.events.length && !related.drafts.length)) return null;
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

// Editable drafts are the ones in a Drafts folder. A message flagged \Draft elsewhere is a discarded version that
// another mail app moved (usually to Trash) — not shown in the conversation (see Reader) and never editable.
const isDraftMsg = (m) => /Drafts$/.test(m.folder?.specialUse || '');
const isLeftoverDraft = (m) => m.isDraft && !isDraftMsg(m);

/** A draft from the Drafts folder (possibly written in another mail app), editable in place. */
function ServerDraft({ m, onDone }) {
  const [init, setInit] = useState(null);
  useEffect(() => { api.get(`/api/messages/${m.id}/draft`).then(setInit).catch(() => setInit(false)); }, [m.id]);
  if (init === null) return <div className="card small faint" style={{ marginBottom: 12 }}><Spinner size={13} /> Opening draft…</div>;
  if (!init) return <div className="card small faint" style={{ marginBottom: 12 }}>This draft could not be opened here — it is in the Drafts folder.</div>;
  return <Composer id={`inline-m${m.id}`} inline init={init} onDone={onDone} />;
}

function MessageCard({ m, expanded, toggle, onReply, onShowImages, translation, onInviteChanged, onExtractEvent }) {
  const realAtts = (m.attachments || []).filter((a) => !a.inline);
  return (
    <div className={`card msg-card ${expanded ? '' : 'collapsed'}`} data-msg={m.id}>
      <div className="msg-card-head" onClick={toggle}>
        <Avatar name={m.from.name} email={m.from.address} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row">{m.onBehalfOf
            ? <span className="who truncate" title={`${addrFull(m.onBehalfOf)} sent this on behalf of ${addrFull(m.from)}`}>{m.onBehalfOf.name || m.onBehalfOf.address} <span className="behalf">on behalf of</span> {m.from.name || m.from.address}</span>
            : <span className="who truncate">{m.from.name || m.from.address}</span>}
            {expanded && m.from.name && <span className="small faint truncate">&lt;{m.from.address}&gt;</span>}<span className="grow" /><span className="small muted" style={{ flex: 'none' }}>{fmtFull(m.date)}</span></div>
          {expanded ? <div className="addr-lines" onClick={(e) => e.stopPropagation()}>
            {m.onBehalfOf && <div className="small addr-line"><span className="addr-label">Sent by</span><span><b>{addrFull(m.onBehalfOf)}</b> on behalf of {addrFull(m.from)} — replies go to {addrFull((m.replyTo?.length ? m.replyTo : [m.from])[0])}</span></div>}
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
        {m.hasInvite && <Invitation messageId={m.id} onChanged={onInviteChanged} onExtract={onExtractEvent} />}
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

function Invitation({ messageId, onChanged, onExtract }) {
  const [inv, setInv] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null); // { response, text } while a note to the organiser is being written
  const [calId, setCalId] = useState(null); // calendar chosen on the card (default: the receiving account's)
  const [openMenu, menuNode] = useMenu();
  useEffect(() => { api.get(`/api/messages/${messageId}/invitation`).then((r) => setInv(r || { error: 'The calendar data in this email could not be found' })).catch((e) => setInv({ error: e.message })); }, [messageId]);
  if (!inv) return null;
  // Not readable: say so, and offer to read the time from the text or to open the calendar file elsewhere.
  if (!inv.event) return (
    <div className="invite-card">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <CalendarPlus size={20} color="var(--warning)" />
        <div className="grow"><div style={{ fontWeight: 650 }}>Calendar invitation</div><div className="small muted">{inv.error}</div></div>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        {onExtract && <button className="btn sm" onClick={onExtract}><Sparkles size={13} /> Add to calendar (read from the text)</button>}
        <a className="btn sm" href={api.url(`/api/messages/${messageId}/invitation.ics`)}><Download size={13} /> Calendar file (.ics)</a>
      </div>
    </div>
  );
  const e = inv.event;
  const LABEL = { accept: 'Accepted', tentative: 'Tentatively accepted', decline: 'Declined' };
  // sendReply false: only your calendar changes, the organiser is not told.
  const respond = async (response, { sendReply = true, comment } = {}) => {
    setBusy(true);
    try {
      const chosen = calId && calId !== (inv.existingCalendarId || inv.defaultCalendarId) ? calId : undefined;
      const r = await api.post(`/api/messages/${messageId}/invitation/respond`, { response, sendReply, comment: comment || undefined, calendarId: chosen });
      const sent = sendReply && e.organizer?.email ? ` — response sent to ${e.organizer.name || e.organizer.email}` : ' — no response sent';
      const where = r.calendar ? ` · in “${r.calendar.name}”${r.calendar.space ? ` (${r.calendar.space})` : ''} on ${new Date(r.start).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}` : '';
      // "Show" opens the calendar on that day, in a space where that calendar is visible.
      const show = () => {
        const cur = store.get().space;
        if (cur && r.calendar?.space !== cur) setSpace(r.calendar?.space || '');
        showCalendarDate(r.start); navigate('#/calendar');
      };
      toast(`${LABEL[response]}${sent}${response !== 'decline' ? where : ''}`, response !== 'decline' && r.calendar ? { duration: 10000, action: { label: 'Show', onClick: show } } : {});
      setNote(null);
      setInv(await api.get(`/api/messages/${messageId}/invitation`));
      onChanged?.();
    } catch (err) { toastError(err); } finally { setBusy(false); }
  };
  const choose = (ev, response) => openMenu(ev, [
    { label: 'Send the response now', icon: Send, onClick: () => respond(response) },
    { label: 'Add a note, then send…', icon: Pencil, onClick: () => setNote({ response, text: '' }) },
    { label: "Don't send a response", icon: BellOff, hint: 'only your calendar', onClick: () => respond(response, { sendReply: false }) },
  ]);
  const status = inv.existingStatus || inv.myStatus;
  const style = (r) => ({ accept: status === 'accepted' || status === 'confirmed', tentative: status === 'tentative', decline: status === 'declined' || status === 'cancelled' }[r]
    ? { borderColor: `var(--${r === 'accept' ? 'success' : r === 'tentative' ? 'warning' : 'danger'})`, color: `var(--${r === 'accept' ? 'success' : r === 'tentative' ? 'warning' : 'danger'})` } : {});
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
        <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          <button className="btn sm" disabled={busy} onClick={(ev) => choose(ev, 'accept')} style={style('accept')}><Check size={14} /> Accept <ChevronDown size={12} /></button>
          <button className="btn sm" disabled={busy} onClick={(ev) => choose(ev, 'tentative')} style={style('tentative')}><HelpCircle size={14} /> Maybe <ChevronDown size={12} /></button>
          <button className="btn sm" disabled={busy} onClick={(ev) => choose(ev, 'decline')} style={style('decline')}><XIcon size={14} /> Decline <ChevronDown size={12} /></button>
          {inv.calendars?.length > 1 && (
            <label className="row small muted" style={{ gap: 4 }} title="The calendar the event goes into (default: the calendar of the account that received this invitation)">
              {inv.existingCalendarId ? 'In' : 'Add to'}
              <select className="input" style={{ height: 28, width: 'auto', maxWidth: 220 }} value={calId || inv.existingCalendarId || inv.defaultCalendarId || ''} onChange={(ev) => setCalId(Number(ev.target.value))}>
                {inv.calendars.map((c) => <option key={c.id} value={c.id}>{c.name}{c.space ? ` · ${c.space}` : ''}</option>)}
              </select>
            </label>
          )}
          {status && status !== 'needs-action' && <span className="small faint">Your answer: {{ confirmed: 'accepted', accepted: 'accepted', tentative: 'maybe', declined: 'declined', cancelled: 'declined' }[status] || status}</span>}
        </div>
      )}
      {note && (
        <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
          <textarea className="input" rows={3} autoFocus placeholder={`Note to ${e.organizer?.name || e.organizer?.email || 'the organiser'} (sent with “${LABEL[note.response]}”)`} value={note.text} onChange={(ev) => setNote({ ...note, text: ev.target.value })} />
          <div className="row"><span className="grow" /><button className="btn sm" onClick={() => setNote(null)}>Cancel</button>
            <button className="btn sm primary" disabled={busy} onClick={() => respond(note.response, { comment: note.text.trim() })}><Send size={13} /> {LABEL[note.response]} and send</button></div>
        </div>
      )}
      {menuNode}
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
  const sending = useRef(false);
  const sendKey = useRef(null);
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
    // A double click or Ctrl+Enter pressed twice sends once (also checked by the server via sendKey).
    if (sending.current) return;
    sending.current = true; setBusy(true);
    sendKey.current ||= `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    try {
      const p = payloadFor(mode);
      const r = await api.post('/api/send', { ...p, html: textToHtml(text) + (p.quoteHtml || ''), draftId: draftId || undefined, sendKey: sendKey.current });
      sendKey.current = null;
      setText(''); setDraftId(null); typed.current = false;
      afterSend(r);
      if (settings.mail.undoSendSeconds > 0) {
        toast('Sending…', { duration: settings.mail.undoSendSeconds * 1000, action: { label: 'Undo', onClick: async () => {
          try { const c = await api.post(`/api/outbox/${r.id}/cancel`); openComposer({ ...c.payload, draftId: null }); } catch { toast('Too late — message already sent', { kind: 'error' }); }
        } } });
      } else toast('Sent');
      onSent?.();
    } catch (e) { toastError(e); } finally { setBusy(false); sending.current = false; }
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
