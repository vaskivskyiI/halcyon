import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  Inbox, Star, Clock, Send, FileText, Archive, Trash2, AlertOctagon, Folder, Tag, Search, PenSquare, Sparkles, Reply, MailOpen, Mail as MailIcon,
  ChevronDown, ChevronRight, Paperclip, CalendarPlus, Menu as MenuIcon, X, Plus, CornerUpLeft, Flame, CheckSquare, Square, RefreshCw, AlertTriangle, Send as SendIcon, Hash, Hourglass, Reply as ReplyIcon, Forward as ForwardIcon, ArrowUpDown, Check,
  ClipboardCheck, SlidersHorizontal,
} from 'lucide-react';
import { api, onEvent } from '../api.js';
import { store } from '../store.js';
import { navigate, fmtListDate, toast, toastError } from '../util.js';
import { Avatar, useMenu, Spinner, Modal } from '../components/common.jsx';
import { loadFolders, loadLabels, saveSettings } from '../data.js';
import { openComposer } from './Composer.jsx';
import Reader from './Reader.jsx';
import { mailAction, snoozeOptions, confirmDelete } from './mailActions.js';

const SMART = [
  ['unified', Inbox, 'All inboxes', 'unified'],
  ['important', Flame, 'Important'],
  ['needsreply', CornerUpLeft, 'Needs reply', 'needsreply'],
  ['needsaction', ClipboardCheck, 'Action needed', 'needsaction'],
  ['flagged', Star, 'Flagged'],
  ['snoozed', Clock, 'Snoozed', 'snoozed'],
  ['scheduled', SendIcon, 'Outbox & drafts', 'scheduled'],
];
const SORTS = [['date', 'Date', 'desc'], ['from', 'From', 'asc'], ['subject', 'Subject', 'asc'], ['size', 'Size', 'desc'], ['unread', 'Unread first', 'asc'], ['flagged', 'Flagged first', 'desc']];
const sortDirLabel = (key, dir) => ({ date: ['Oldest first', 'Newest first'], size: ['Smallest first', 'Largest first'], from: ['A → Z', 'Z → A'], subject: ['A → Z', 'Z → A'] }[key] || ['Ascending', 'Descending'])[dir === 'asc' ? 0 : 1];
// Per page load: last list per view/tab/sort (shown instantly when coming back) and the tab chosen per view.
const listCache = new Map();
const tabByView = new Map();
const TabCount = ({ n }) => (n > 0 ? <span className="tab-count">{n > 999 ? '999+' : n}</span> : null);

const COUNT_TITLES = { unified: 'Unread conversations', needsreply: 'Conversations waiting for your reply', needsaction: 'Open action items', snoozed: 'Snoozed conversations', scheduled: 'Messages waiting to be sent' };
const FOLDER_ICONS = { '\\Inbox': Inbox, '\\Sent': Send, '\\Drafts': FileText, '\\Archive': Archive, '\\Trash': Trash2, '\\Junk': AlertOctagon, '\\Flagged': Star };
const SPECIAL_ORDER = ['\\Inbox', '\\Drafts', '\\Sent', '\\Archive', '\\Junk', '\\Trash'];

// Dynamic AI views: "tp~<topic>" (ongoing project/case) and "ct~<category>".
export const topicView = (name) => `tp~${encodeURIComponent(name)}`;
export const categoryView = (name) => `ct~${encodeURIComponent(name)}`;

function viewQuery(view) {
  if (view.startsWith('tp~')) return { view: 'topic', topic: decodeURIComponent(view.slice(3)) };
  if (view.startsWith('ct~')) return { view: 'category', category: decodeURIComponent(view.slice(3)) };
  if (view.startsWith('f')) return { view: 'folder', folderId: view.slice(1) };
  if (view.startsWith('l')) return { view: 'label', labelId: view.slice(1) };
  return { view };
}

export default function MailView({ route }) {
  const view = route[1] || 'unified';
  const openId = route[2] ? Number(route[2]) : null;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  return (
    <div className={`main ${openId ? 'mail-reading' : 'mail-list-only'}`}>
      <FolderNav view={view} open={sidebarOpen} onNavigate={() => setSidebarOpen(false)} />
      {view === 'scheduled' ? <OutboxList onMenu={() => setSidebarOpen(true)} /> : <MessageList key={view} view={view} openId={openId} onMenu={() => setSidebarOpen(true)} />}
      {view !== 'scheduled' && <Reader id={openId} view={view} />}
    </div>
  );
}

function FolderNav({ view, open, onNavigate }) {
  const folders = store.use((s) => s.folders);
  const labels = store.use((s) => s.labels);
  const [collapsed, setCollapsed] = useState({});
  const [dropTarget, setDropTarget] = useState(null);
  const [openMenu, menuNode] = useMenu();
  const [newFolder, setNewFolder] = useState(null);
  const go = (v) => { navigate(`#/mail/${v}`); onNavigate(); };

  const onDrop = (e, folderId) => {
    e.preventDefault(); setDropTarget(null);
    const data = JSON.parse(e.dataTransfer.getData('application/x-halcyon') || '{}');
    if (data.ids?.length) mailAction('move', data.ids, { folderId }, { threads: data.threads });
  };
  const dropProps = (key, folderId) => ({
    onDragOver: (e) => { if (e.dataTransfer.types.includes('application/x-halcyon')) { e.preventDefault(); setDropTarget(key); } },
    onDragLeave: () => setDropTarget(null), onDrop: (e) => onDrop(e, folderId),
  });

  const folderMenu = (e, acc, f) => openMenu(e, [
    { label: 'Mark all as read', icon: MailOpen, onClick: () => api.post(`/api/folders/${f.id}/read-all`).then(loadFolders) },
    { label: 'New subfolder', icon: Plus, onClick: () => setNewFolder({ accountId: acc.accountId, parentPath: f.path }) },
    !f.specialUse && { label: 'Rename', icon: PenSquare, onClick: () => { const n = prompt('New name', f.name); if (n) api.patch(`/api/folders/${f.id}`, { name: n }).then(() => toast('Renaming…')); } },
    { label: f.syncEnabled ? 'Stop syncing this folder' : 'Sync this folder', icon: RefreshCw, onClick: () => api.patch(`/api/folders/${f.id}`, { syncEnabled: !f.syncEnabled }).then(loadFolders) },
    ['\\Trash', '\\Junk'].includes(f.specialUse) && { label: 'Empty folder', icon: Trash2, danger: true, onClick: () => confirm(`Permanently delete all messages in ${f.name}?`) && api.post(`/api/folders/${f.id}/empty`).then(loadFolders) },
    !f.specialUse && { label: 'Delete folder', icon: Trash2, danger: true, onClick: () => confirm(`Delete folder ${f.name} and its messages?`) && api.del(`/api/folders/${f.id}`).then(() => toast('Deleting…')) },
  ]);

  return (
    <aside className={`sidebar ${open ? 'open' : ''}`}>
      <div className="sidebar-head">
        <button className="btn primary grow" style={{ justifyContent: 'center', height: 38 }} onClick={() => openComposer({})}><PenSquare size={16} /> New message</button>
      </div>
      <div className="sidebar-scroll">
        {SMART.map(([key, Icon, label, countKey]) => (
          <div key={key} className={`nav-item ${view === key ? 'active' : ''}`} onClick={() => go(key)}>
            <Icon size={16} /><span className="truncate">{label}</span>{countKey && folders.counts?.[countKey] > 0 && <span className="count" title={COUNT_TITLES[countKey]}>{folders.counts[countKey]}</span>}
          </div>
        ))}
        {folders.topics?.length > 0 && <>
          <div className="nav-section" style={{ cursor: 'default' }} title="Ongoing projects, events and cases recognised by the AI">Topics</div>
          {folders.topics.map((t) => (
            <div key={t.name} className={`nav-item ${view === topicView(t.name) ? 'active' : ''}`} onClick={() => go(topicView(t.name))} title={`${t.count} messages in the last 60 days`}>
              <Hash size={15} /><span className="truncate">{t.name}</span>{t.unread > 0 && <span className="count">{t.unread}</span>}
            </div>))}
        </>}
        {folders.categories?.length > 0 && <>
          <div className="nav-section" style={{ cursor: 'default' }}>AI categories</div>
          {folders.categories.map((c) => (
            <div key={c.name} className={`nav-item ${view === categoryView(c.name) ? 'active' : ''}`} onClick={() => go(categoryView(c.name))}>
              <Tag size={15} /><span className="truncate" style={{ textTransform: 'capitalize' }}>{c.name}</span>{c.unread > 0 && <span className="count">{c.unread}</span>}
            </div>))}
        </>}
        {folders.accounts.map((acc) => {
          const sorted = [...acc.folders].sort((a, b) => {
            const ia = SPECIAL_ORDER.indexOf(a.specialUse), ib = SPECIAL_ORDER.indexOf(b.specialUse);
            return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.path.localeCompare(b.path);
          });
          return (
            <div key={acc.accountId}>
              <div className="nav-section" onClick={() => setCollapsed({ ...collapsed, [acc.accountId]: !collapsed[acc.accountId] })}>
                {collapsed[acc.accountId] ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                <span className="dot" style={{ background: acc.color }} />
                <span className="truncate grow" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12.5 }}>{acc.email}</span>
                {acc.syncState === 'syncing' && <Spinner size={12} />}
                {acc.syncState === 'error' && <span title={acc.syncError}><AlertTriangle size={13} color="var(--danger)" /></span>}
              </div>
              {!collapsed[acc.accountId] && sorted.map((f) => {
                const Icon = FOLDER_ICONS[f.specialUse] || Folder;
                const depth = f.parentPath ? f.path.split(f.delimiter || '/').length - 1 : 0;
                const key = `f${f.id}`;
                return (
                  <div key={f.id} className={`nav-item ${view === key ? 'active' : ''} ${dropTarget === key ? 'drop' : ''}`} style={{ paddingLeft: 10 + depth * 14, opacity: f.syncEnabled ? 1 : 0.55 }}
                    onClick={() => go(key)} onContextMenu={(e) => folderMenu(e, acc, f)} {...dropProps(key, f.id)}>
                    <Icon size={16} /><span className="truncate">{f.name}</span>
                    {f.unread > 0 && !['\\Sent', '\\Trash', '\\Junk', '\\Drafts'].includes(f.specialUse) && <span className="count" title="Unread conversations">{f.unread}</span>}
                    {f.specialUse === '\\Drafts' && f.total > 0 && <span className="count faint">{f.total}</span>}
                  </div>
                );
              })}
              {!collapsed[acc.accountId] && <div className="nav-item faint small" onClick={() => setNewFolder({ accountId: acc.accountId })}><Plus size={14} /> New folder</div>}
            </div>
          );
        })}
        <div className="nav-section" style={{ cursor: 'default' }}><span className="grow">Labels</span><button className="icon-btn" style={{ width: 22, height: 22 }} title="New label" onClick={async () => { const n = prompt('Label name'); if (n) { await api.post('/api/labels', { name: n, color: `hsl(${Math.random() * 360 | 0} 60% 50%)` }); loadLabels(); } }}><Plus size={13} /></button></div>
        {labels.map((l) => (
          <div key={l.id} className={`nav-item ${view === `l${l.id}` ? 'active' : ''}`} onClick={() => go(`l${l.id}`)}
            onContextMenu={(e) => openMenu(e, [{ label: 'Delete label', icon: Trash2, danger: true, onClick: () => api.del(`/api/labels/${l.id}`).then(loadLabels) }])}>
            <Tag size={15} color={l.color} /><span className="truncate">{l.name}</span>
          </div>
        ))}
      </div>
      {menuNode}
      {newFolder && <NewFolderModal {...newFolder} onClose={() => setNewFolder(null)} />}
    </aside>
  );
}

function NewFolderModal({ accountId, parentPath, onClose }) {
  const [name, setName] = useState('');
  const create = async () => { await api.post('/api/folders', { accountId, name, parentPath }); toast('Creating folder…'); onClose(); };
  return <Modal title={parentPath ? `New folder in ${parentPath}` : 'New folder'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!name} onClick={create}>Create</button></>}>
    <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name && create()} placeholder="Folder name" />
  </Modal>;
}

function MessageList({ view, openId, onMenu }) {
  const settings = store.use((s) => s.settings);
  const folders = store.use((s) => s.folders);
  const [items, setItems] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [tab, setTabState] = useState(() => tabByView.get(view) || null);
  const setTab = (t) => { tabByView.set(view, t); setTabState(t); };
  const [query, setQuery] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  // AI part of search: { status: 'loading' | 'done' | 'unavailable', items }
  const [aiResults, setAiResults] = useState(null);
  const aiQuery = useRef('');
  const [selected, setSelected] = useState(new Set());
  const [openMenu, menuNode] = useMenu();
  const listRef = useRef();
  const searchRef = useRef();
  const anchor = useRef(null);
  const threaded = settings.ui.conversationView;
  // Sort order is a per-device choice; newest first pages by date, other orders by offset.
  const [sort, setSortState] = useState(() => { try { return JSON.parse(localStorage.getItem('halcyon.sort')) || { key: 'date', dir: 'desc' }; } catch { return { key: 'date', dir: 'desc' }; } });
  const setSort = (s) => { setSortState(s); try { localStorage.setItem('halcyon.sort', JSON.stringify(s)); } catch { /* private mode */ } };
  const byDate = sort.key === 'date' && sort.dir === 'desc';

  // A folder of one account puts that account in focus (new mail defaults to it).
  useEffect(() => {
    const acc = folders.accounts.find((a) => a.folders.some((f) => `f${f.id}` === view));
    if (acc) store.set({ focusAccountId: acc.accountId });
  }, [view, folders]);
  const isInboxView = view === 'unified' || (view.startsWith('f') && folders.accounts.some((a) => a.folders.some((f) => `f${f.id}` === view && f.specialUse === '\\Inbox')));
  // The list is mounted per view (key): the tab chosen last time in this view is kept; until folders are known, wait.
  const effectiveTab = tab || (isInboxView && settings.mail.focusedInbox ? 'focused' : 'all');
  const cacheKey = `${view}|${effectiveTab}|${threaded}|${sort.key}|${sort.dir}|${store.get().space || ''}`;
  const [tabCounts, setTabCounts] = useState(null);
  const loadTabCounts = () => { if (!activeQuery) api.get(`/api/messages/tab-counts?${new URLSearchParams(viewQuery(view))}`).then(setTabCounts).catch(() => {}); };

  const params = useCallback((before, offset) => {
    const p = new URLSearchParams({ ...viewQuery(view), limit: 50 });
    if (!byDate) { p.set('sort', sort.key); p.set('dir', sort.dir); if (offset) p.set('offset', offset); }
    if (activeQuery) { p.set('q', activeQuery); p.set('semantic', '0'); }
    if (effectiveTab !== 'all') p.set('filter', effectiveTab);
    if (before) p.set('before', before);
    if (!threaded) p.set('threads', '0');
    return p;
  }, [view, effectiveTab, activeQuery, threaded, sort]);

  // The open message stays in the list (e.g. in "Unread" after it was read) until the user moves to another one.
  const openRef = useRef(openId);
  const keepOpen = (next, cur) => {
    const id = openRef.current;
    if (!id || next.some((m) => m.id === id)) return next;
    const i = cur.findIndex((m) => m.id === id);
    if (i < 0) return next;
    const out = [...next];
    out.splice(Math.min(i, out.length), 0, cur[i]);
    return out;
  };
  useEffect(() => {
    const prev = openRef.current;
    openRef.current = openId;
    // Leaving a message: let filtered views drop it now if it no longer matches.
    if (prev && prev !== openId && ['unread', 'focused', 'other'].includes(effectiveTab)) {
      api.get(`/api/messages?${params(null)}`).then((r) => setItems((cur) => keepOpen(r.items, cur))).catch(() => {});
    }
  }, [openId]);

  const load = useCallback(async (append = false) => {
    setLoading(true);
    try {
      const before = append && items.length && byDate ? items[items.length - 1].date : null;
      const r = await api.get(`/api/messages?${params(before, append ? items.length : 0)}`);
      setItems((cur) => {
        const next = append ? [...cur, ...r.items] : keepOpen(r.items, cur);
        if (!activeQuery) listCache.set(cacheKey, { items: next, hasMore: r.hasMore, scroll: listCache.get(cacheKey)?.scroll || 0 });
        return next;
      });
      setHasMore(r.hasMore);
      if (!append) loadTabCounts();
      // Keyword results are shown at once; matches by meaning follow when the AI answers.
      if (activeQuery && !append && settings.ai.enabled && settings.ai.embeddings) {
        const q = activeQuery;
        aiQuery.current = q;
        setAiResults({ status: 'loading', items: [] });
        api.get(`/api/search/semantic?q=${encodeURIComponent(q)}&exclude=${r.items.map((m) => m.id).join(',')}`)
          .then((s) => { if (aiQuery.current === q) setAiResults({ status: s.unavailable ? 'unavailable' : 'done', items: s.items }); })
          .catch(() => { if (aiQuery.current === q) setAiResults({ status: 'unavailable', items: [] }); });
      } else if (!activeQuery) { aiQuery.current = ''; setAiResults(null); }
    } catch (e) { toastError(e); } finally { setLoading(false); }
  }, [params, items]);

  useEffect(() => {
    // Last loaded state of this list is shown at once (and its scroll position), then refreshed.
    const c = !activeQuery && listCache.get(cacheKey);
    if (c) {
      setItems(c.items); setHasMore(c.hasMore);
      requestAnimationFrame(() => { if (listRef.current) listRef.current.scrollTop = c.scroll || 0; });
    }
    load(false);
    loadTabCounts();
  }, [params]);

  // Live updates.
  const reloadTimer = useRef();
  // Periodic refresh when the live connection is down (see App), and after "Sync now".
  useEffect(() => {
    const h = () => { clearTimeout(reloadTimer.current); reloadTimer.current = setTimeout(() => load(false), 200); };
    window.addEventListener('halcyon:poll', h);
    return () => window.removeEventListener('halcyon:poll', h);
  }, [params]);

  useEffect(() => onEvent((e) => {
    // A finished analysis can move a message between Focused and Other: re-query those tabs.
    if (e.type === 'ai:insight' && (effectiveTab === 'focused' || effectiveTab === 'other')) {
      clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(async () => { const r = await api.get(`/api/messages?${params(null)}`).catch(() => null); if (r) setItems((cur) => keepOpen(r.items, cur)); }, 800);
    }
    if (['mail:changed', 'folder:synced', 'mail:unsnoozed', 'mail:new'].includes(e.type)) {
      if (e.type === 'folder:synced' && !e.payload.newCount) return;
      clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(async () => {
        const r = await api.get(`/api/messages?${params(null)}`).catch(() => null);
        if (r) setItems((cur) => keepOpen([...r.items, ...cur.slice(r.items.length).filter((x) => !r.items.some((y) => y.id === x.id))].slice(0, Math.max(cur.length, r.items.length)), cur));
      }, 400);
    }
    if (e.type === 'ai:insight') {
      const i = e.payload.insight;
      setItems((cur) => cur.map((m) => (m.id === e.payload.messageId ? { ...m, ai: { summary: i.summary, category: i.category, priority: i.priority, needsReply: i.needsReply, isPhishing: i.isPhishing, hasDraft: !!i.draftReply, topic: i.topic, expired: i.expired } } : m)));
    }
    if (e.type === 'ai:draft') setItems((cur) => cur.map((m) => (m.id === e.payload.messageId && m.ai ? { ...m, ai: { ...m.ai, hasDraft: true } } : m)));
  }), [params]);

  const open = (m) => {
    navigate(`#/mail/${view}/${m.id}`);
    if (!m.isRead && settings.mail.markReadAfterMs >= 0) {
      setTimeout(() => {
        if (location.hash.endsWith(`/${m.id}`)) {
          api.post('/api/messages/actions', { ids: [m.id], action: 'read', threads: threaded }).then(() => loadFolders());
          setItems((cur) => cur.map((x) => (x.id === m.id ? { ...x, isRead: true, threadUnread: 0 } : x)));
        }
      }, settings.mail.markReadAfterMs);
    }
  };

  const selIds = selected.size ? [...selected] : openId ? [openId] : [];
  const act = (requested, extra = {}, ids = selIds) => {
    const action = confirmDelete(requested, items.find((m) => ids.includes(m.id))?.folder?.specialUse, ids.length);
    if (!action) return;
    const removing = ['archive', 'trash', 'spam', 'move', 'snooze', 'delete', 'notspam'].includes(action) || (action === 'unsnooze' && view === 'snoozed');
    if (removing) {
      const idx = items.findIndex((m) => ids.includes(m.id));
      const next = items.filter((m) => !ids.includes(m.id))[idx];
      setItems((cur) => cur.filter((m) => !ids.includes(m.id)));
      if (ids.includes(openId)) navigate(next ? `#/mail/${view}/${next.id}` : `#/mail/${view}`);
    } else if (['read', 'unread', 'flag', 'unflag'].includes(action)) {
      setItems((cur) => cur.map((m) => (ids.includes(m.id) ? { ...m, isRead: action === 'read' ? true : action === 'unread' ? false : m.isRead, isFlagged: action === 'flag' ? true : action === 'unflag' ? false : m.isFlagged, threadUnread: action === 'read' ? 0 : m.threadUnread } : m)));
    }
    setSelected(new Set());
    mailAction(action, ids, extra, { threads: threaded });
  };

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest('input, textarea, [contenteditable=true], select') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (store.get().composers.some((c) => !c.minimized)) return;
      const idx = items.findIndex((m) => m.id === openId);
      const cur = items[idx];
      const k = e.key;
      if (k === 'j' || k === 'ArrowDown') { const n = items[Math.min(items.length - 1, idx + 1)]; if (n) open(n); e.preventDefault(); }
      else if (k === 'k' || k === 'ArrowUp') { const n = items[Math.max(0, idx - 1)]; if (n) open(n); e.preventDefault(); }
      else if (k === '/') { e.preventDefault(); searchRef.current?.focus(); }
      else if (k === 'c') { e.preventDefault(); openComposer({}); }
      else if (k === 'e' && selIds.length) act('archive');
      else if ((k === '#' || k === 'Delete') && selIds.length) act('trash');
      else if (k === '!' && selIds.length) act('spam');
      else if (k === 's' && cur) act(cur.isFlagged ? 'unflag' : 'flag', {}, [cur.id]);
      else if (k === 'u' && cur) act(cur.isRead ? 'unread' : 'read', {}, [cur.id]);
      else if (k === 'x' && cur) toggleSel(cur.id);
      else if (k === 'Escape') { setSelected(new Set()); if (openId) navigate(`#/mail/${view}`); }
      else if (['r', 'a', 'f'].includes(k) && cur) { e.preventDefault(); window.dispatchEvent(new CustomEvent('halcyon:reply', { detail: { mode: { r: 'reply', a: 'replyAll', f: 'forward' }[k] } })); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const toggleSel = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const clickRow = (e, m) => {
    if (e.shiftKey && anchor.current != null) {
      const a = items.findIndex((x) => x.id === anchor.current), b = items.findIndex((x) => x.id === m.id);
      setSelected(new Set(items.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.id)));
    } else if (e.metaKey || e.ctrlKey) {
      // As in Outlook: Ctrl+click extends the current selection, which includes the open message.
      setSelected((s) => { const n = new Set(s.size || !openId || openId === m.id ? s : [openId]); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n; });
      anchor.current = m.id;
    }
    else { setSelected(new Set()); anchor.current = m.id; open(m); }
  };

  // Corrections teach the AI per sender; the list updates from the returned insight.
  const feedbackMany = async (ids, kind) => {
    try {
      for (const id of ids) {
        const r = await api.post(`/api/messages/${id}/feedback`, { kind });
        setItems((cur) => cur.map((x) => (x.id === id && x.ai ? { ...x, ai: { ...x.ai, priority: r.insight.priority, needsReply: r.insight.needsReply } } : x)));
      }
      toast(`Noted — the AI will treat similar mail from ${ids.length > 1 ? 'these senders' : 'this sender'} the same way`);
    } catch (e) { toastError(e); }
  };

  // Requested actions settled from the list: done, or deliberately not acted on.
  const settleMany = async (ids, resolution) => {
    try {
      for (const id of ids) await api.post(`/api/messages/${id}/dismiss`, { resolution });
      setItems((cur) => (view === 'needsaction' ? cur.filter((x) => !ids.includes(x.id)) : cur.map((x) => (ids.includes(x.id) && x.ai ? { ...x, ai: { ...x.ai, needsAction: false } } : x))));
      setSelected(new Set());
      toast(resolution === 'skipped' ? `Not doing it — ${ids.length} removed from Action needed` : `Done — ${ids.length} removed from Action needed`);
      loadFolders();
    } catch (e) { toastError(e); }
  };

  const needsReplyMany = async (ids, value) => {
    try {
      await api.post('/api/messages/needs-reply', { ids, value, threads: threaded });
      setItems((cur) => (view === 'needsreply' && !value ? cur.filter((x) => !ids.includes(x.id))
        : cur.map((x) => (ids.includes(x.id) ? { ...x, ai: { ...(x.ai || {}), needsReply: value } } : x))));
      setSelected(new Set());
      toast(`${value ? 'Marked' : 'Unmarked'} ${ids.length} message${ids.length > 1 ? 's' : ''} as “needs reply”`);
      loadFolders();
    } catch (e) { toastError(e); }
  };

  const rowMenu = (e, m) => {
    const ids = selected.has(m.id) ? [...selected] : [m.id];
    // Right-click selects what it acts on, so it is visible which messages a menu choice applies to.
    if (!selected.has(m.id) && selected.size) setSelected(new Set());
    openMenu(e, [
      { label: 'Reply', icon: Reply, onClick: () => { open(m); setTimeout(() => window.dispatchEvent(new CustomEvent('halcyon:reply', { detail: { mode: 'reply' } })), 300); } },
      { label: m.isRead ? 'Mark as unread' : 'Mark as read', icon: m.isRead ? MailIcon : MailOpen, onClick: () => act(m.isRead ? 'unread' : 'read', {}, ids) },
      { label: m.isFlagged ? 'Unflag' : 'Flag', icon: Star, onClick: () => act(m.isFlagged ? 'unflag' : 'flag', {}, ids) },
      { label: 'Create task…', icon: ClipboardCheck, onClick: () => store.set({ taskDialog: m.id }) },
      m.ai?.needsAction && { label: 'Action: done', icon: ClipboardCheck, onClick: () => settleMany(ids, 'done') },
      m.ai?.needsAction && { label: 'Action: not doing it', icon: X, onClick: () => settleMany(ids, 'skipped') },
      { label: 'Mark as needs reply', icon: CornerUpLeft, onClick: () => needsReplyMany(ids, true) },
      { label: 'Remove “needs reply”', icon: CornerUpLeft, onClick: () => needsReplyMany(ids, false) },
      settings.ai.enabled && { label: 'Mark as important', icon: Flame, hint: 'AI learns', onClick: () => feedbackMany(ids, 'important') },
      settings.ai.enabled && { label: 'Mark as not important', icon: MailOpen, hint: 'AI learns', onClick: () => feedbackMany(ids, 'unimportant') },
      { label: 'Archive', icon: Archive, onClick: () => act('archive', {}, ids) },
      { label: 'Delete', icon: Trash2, onClick: () => act('trash', {}, ids) },
      { label: 'Spam', icon: AlertOctagon, onClick: () => act('spam', {}, ids) },
      'sep', { section: 'Snooze' },
      ...snoozeOptions().map(([label, until]) => ({ label, icon: Clock, onClick: () => act('snooze', { until }, ids) })),
      'sep', { section: 'Move to' },
      ...folders.accounts.flatMap((a) => a.folders.filter((f) => a.accountId === m.accountId || folders.accounts.length > 1).slice(0, 40).map((f) => ({ label: folders.accounts.length > 1 ? `${f.name} · ${a.email}` : f.name, icon: Folder, onClick: () => act('move', { folderId: f.id }, ids) }))),
    ]);
  };

  const onScroll = (e) => {
    const el = e.currentTarget;
    const c = listCache.get(cacheKey);
    if (c) c.scroll = el.scrollTop;
    if (hasMore && !loading && el.scrollTop + el.clientHeight > el.scrollHeight - 300) load(true);
  };

  const title = useMemo(() => {
    const smart = SMART.find((s) => s[0] === view);
    if (smart) return smart[2];
    if (view.startsWith('tp~')) return `Topic: ${decodeURIComponent(view.slice(3))}`;
    if (view.startsWith('ct~')) { const c = decodeURIComponent(view.slice(3)); return c[0].toUpperCase() + c.slice(1); }
    if (view.startsWith('l')) return store.get().labels.find((l) => `l${l.id}` === view)?.name || 'Label';
    for (const a of folders.accounts) { const f = a.folders.find((x) => `f${x.id}` === view); if (f) return f.name; }
    return 'Mail';
  }, [view, folders]);

  const bulk = selected.size > 0;
  return (
    <section className="list-pane">
      <div className="list-head">
        <div className="row">
          <button className="icon-btn mobile-only" onClick={onMenu} aria-label="Folders"><MenuIcon size={18} /></button>
          <h3 style={{ margin: 0, fontSize: 17 }} className="grow truncate">{activeQuery ? 'Search results' : title}</h3>
          <button className="icon-btn" title="Check for new mail" onClick={() => { window.dispatchEvent(new Event('halcyon:sync')); load(false); }}>{loading ? <Spinner /> : <RefreshCw size={16} />}</button>
          <button className="icon-btn" title={threaded ? 'Conversation view: on' : 'Conversation view: off'} onClick={() => saveSettings({ ui: { conversationView: !threaded } })}><MailIcon size={16} /></button>
        </div>
        <form className="search" onSubmit={(e) => { e.preventDefault(); setActiveQuery(query.trim()); }}>
          <Search size={15} />
          <input ref={searchRef} className="input" placeholder="Search mail — try from:anna has:attachment or plain words" value={query} onChange={(e) => { setQuery(e.target.value); if (!e.target.value) setActiveQuery(''); }} />
          <button type="button" className={`icon-btn ${filtersOpen ? 'active' : ''}`} style={{ position: 'absolute', right: query ? 28 : 2, top: 1 }} title="Filters" onClick={() => setFiltersOpen(!filtersOpen)}><SlidersHorizontal size={15} /></button>
          {query && <button type="button" className="icon-btn" style={{ position: 'absolute', right: 2, top: 1 }} onClick={() => { setQuery(''); setActiveQuery(''); }}><X size={15} /></button>}
        </form>
        {(filtersOpen || activeQuery) && <SearchFilters query={query} onChange={(q) => { setQuery(q); setActiveQuery(q.trim()); }} />}
        {!activeQuery && <div className="tabs">
          {isInboxView && settings.mail.focusedInbox && <><button className={`tab ${effectiveTab === 'focused' ? 'active' : ''}`} onClick={() => setTab('focused')}>Focused<TabCount n={tabCounts?.focused} /></button><button className={`tab ${effectiveTab === 'other' ? 'active' : ''}`} onClick={() => setTab('other')}>Other<TabCount n={tabCounts?.other} /></button></>}
          <button className={`tab ${effectiveTab === 'all' ? 'active' : ''}`} onClick={() => setTab('all')}>All<TabCount n={tabCounts?.all} /></button>
          <button className={`tab ${effectiveTab === 'unread' ? 'active' : ''}`} onClick={() => setTab('unread')}>Unread</button>
          <button className={`tab ${effectiveTab === 'attachments' ? 'active' : ''}`} onClick={() => setTab('attachments')} title="With attachments"><Paperclip size={14} /></button>
          <button className="tab sort-btn" title={`Sort: ${SORTS.find((x) => x[0] === sort.key)?.[1]}, ${sortDirLabel(sort.key, sort.dir).toLowerCase()}`} onClick={(e) => openMenu(e, [
            { section: 'Sort by' },
            ...SORTS.map(([key, label, dir]) => ({ label, icon: sort.key === key ? Check : undefined, onClick: () => setSort({ key, dir }) })),
            'sep',
            { label: sortDirLabel(sort.key, 'asc'), icon: sort.dir === 'asc' ? Check : undefined, onClick: () => setSort({ ...sort, dir: 'asc' }) },
            { label: sortDirLabel(sort.key, 'desc'), icon: sort.dir === 'desc' ? Check : undefined, onClick: () => setSort({ ...sort, dir: 'desc' }) },
          ])}><ArrowUpDown size={13} />{!byDate && ` ${SORTS.find((x) => x[0] === sort.key)?.[1]}`}</button>
        </div>}
      </div>
      <AiApprovals />
      {bulk && (
        <div className="bulk-bar">
          <button className="icon-btn" title="Clear selection" onClick={() => setSelected(new Set())}><X size={16} /></button>
          <span className="small grow">{selected.size} selected</span>
          <button className="icon-btn" title="Select all" onClick={() => setSelected(new Set(items.map((m) => m.id)))}><CheckSquare size={16} /></button>
          <button className="icon-btn" title="Mark read" onClick={() => act('read')}><MailOpen size={16} /></button>
          <button className="icon-btn" title="Mark unread" onClick={() => act('unread')}><MailIcon size={16} /></button>
          <button className="icon-btn" title="Archive" onClick={() => act('archive')}><Archive size={16} /></button>
          <button className="icon-btn" title="Delete" onClick={() => act('trash')}><Trash2 size={16} /></button>
          <button className="icon-btn" title="Mark as needs reply" onClick={() => needsReplyMany([...selected], true)}><CornerUpLeft size={16} /></button>
          <button className="icon-btn" title="More" onClick={(e) => rowMenu(e, items.find((m) => selected.has(m.id)))}><ChevronDown size={16} /></button>
        </div>
      )}
      <div className={`list ${bulk ? 'selecting' : ''}`} ref={listRef} onScroll={onScroll}>
        {items.map((m) => <Row key={m.id} m={m} selected={selected.has(m.id) || m.id === openId} checked={selected.has(m.id)} threaded={threaded}
          onClick={(e) => clickRow(e, m)} onContextMenu={(e) => rowMenu(e, m)} onCheck={() => toggleSel(m.id)} onAct={(a, extra) => act(a, extra, [m.id])}
          dragIds={selected.has(m.id) ? [...selected] : [m.id]} showAi={settings.ai.enabled} />)}
        {activeQuery && aiResults && <div className="ai-results">
          <div className="nav-section" style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Sparkles size={13} /> Related by meaning (AI)
            {aiResults.status === 'loading' && <><Spinner size={12} /><span className="faint">searching…</span></>}</div>
          {aiResults.items.map((m) => <Row key={`ai${m.id}`} m={m} selected={m.id === openId} checked={false} threaded={false}
            onClick={(e) => clickRow(e, m)} onContextMenu={(e) => rowMenu(e, m)} onCheck={() => {}} onAct={(a, extra) => act(a, extra, [m.id])} dragIds={[m.id]} showAi={settings.ai.enabled} />)}
          {aiResults.status === 'done' && !aiResults.items.length && <div className="small faint" style={{ padding: '4px 16px 10px' }}>Nothing else related.</div>}
          {aiResults.status === 'unavailable' && <div className="small faint" style={{ padding: '4px 16px 10px' }}>AI search is not available right now (the AI server is busy or not configured).</div>}
        </div>}
        {!items.length && !loading && !aiResults?.items.length && <div className="empty"><Inbox size={36} />{activeQuery ? 'No messages match your search.' : effectiveTab === 'focused' ? 'Nothing important right now. Check "Other".' : 'No messages here.'}</div>}
        {loading && items.length === 0 && <div className="empty"><Spinner size={22} /></div>}
        {hasMore && <div className="empty" style={{ padding: 16 }}><button className="btn" onClick={() => load(true)}>Load more</button></div>}
      </div>
      {menuNode}
    </section>
  );
}

function Row({ m, selected, checked, threaded, onClick, onContextMenu, onCheck, onAct, dragIds, showAi }) {
  const unread = threaded ? m.threadUnread > 0 || !m.isRead : !m.isRead;
  const ai = m.ai;
  const expired = !!ai?.expired;
  const important = !expired && ai?.priority >= 70;
  return (
    <div className={`msg-row ${unread ? 'unread' : 'read'} ${important ? 'important' : ''} ${expired ? 'expired' : ''} ${selected ? 'selected' : ''}`} onClick={onClick} onContextMenu={onContextMenu} draggable
      onDragStart={(e) => { e.dataTransfer.setData('application/x-halcyon', JSON.stringify({ ids: dragIds, threads: threaded })); e.dataTransfer.effectAllowed = 'copyMove'; }}>
      <div onClick={(e) => { e.stopPropagation(); onCheck(); }} style={{ cursor: 'pointer' }}>
        {checked ? <div className="avatar" style={{ background: 'var(--accent)' }}><CheckSquare size={18} /></div> : <Avatar name={m.from.name} email={m.from.address} />}
      </div>
      <div className="body">
        <div className="from">
          {important && <Flame size={13} className="imp-icon" title={`Important (priority ${ai.priority})`} />}
          <span className="truncate">{m.folder?.specialUse === '\\Sent' ? `To: ${m.to.map((a) => a.name || a.address).join(', ')}` : m.from.name || m.from.address}
            {m.onBehalfOf && m.folder?.specialUse !== '\\Sent' && <span className="faint behalf-note"> · sent by {m.onBehalfOf.name || m.onBehalfOf.address}</span>}</span>
          {threaded && m.threadCount > 1 && <span className="faint small">{m.threadCount}</span>}
          <span className="date">{m.snoozedUntil ? <span title="Snoozed until"><Clock size={11} /> {fmtListDate(m.snoozedUntil)}</span> : fmtListDate(m.date)}</span>
        </div>
        <div className="subject truncate">
          {m.isAnswered && <ReplyIcon size={13} className="state-icon" title="You replied" />}
          {m.isForwarded && <ForwardIcon size={13} className="state-icon" title="You forwarded this" />}
          {m.subject || '(no subject)'}</div>
        {showAi && ai?.summary ? <div className="ai-line"><Sparkles size={12} /><span style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{ai.summary}</span></div>
          : <div className="snippet truncate">{m.snippet}</div>}
        <div className="meta">
          {ai?.isPhishing && <span className="chip" style={{ background: '#fee2e2', color: '#991b1b' }}><AlertTriangle size={11} /> Suspicious</span>}
          {expired && <span className="chip faint" title="Time-sensitive content that is no longer valid"><Hourglass size={11} /> expired</span>}
          {ai?.topic && <span className="chip topic clickable" title={`Show all mail about “${ai.topic}”`} onClick={(e) => { e.stopPropagation(); navigate(`#/mail/${topicView(ai.topic)}`); }}><Hash size={10} />{ai.topic}</span>}
          {ai?.needsReply && !m.isAnswered && !expired && <span className="chip ai"><CornerUpLeft size={11} /> Reply needed</span>}
          {ai?.needsAction && !expired && <span className="chip action" title={ai.actionSummary || 'Action needed'}><ClipboardCheck size={11} /> {ai.actionSummary ? (ai.actionSummary.length > 42 ? `${ai.actionSummary.slice(0, 40)}…` : ai.actionSummary) : 'Action needed'}</span>}
          {m.hasInvite && <CalendarPlus size={13} className="faint" title="Invitation" />}
          {m.hasAttachments && <Paperclip size={13} className="faint" />}
          {m.hasDraft && <span className="chip draft" title="You have an unsent reply in this conversation">Draft</span>}
          {m.notOnServer && <span className="chip unsaved" title="Sent, but the copy is not saved on the mail server yet (other mail apps do not show it)">Not on server</span>}
          {m.isFlagged && <Star size={13} className="flag-icon" />}
          {m.labels?.map((id) => { const l = store.get().labels.find((x) => x.id === id); return l && <span key={id} className="chip" style={{ background: l.color, color: '#fff' }}>{l.name}</span>; })}
        </div>
      </div>
      <div className="hover-actions" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn" title="Archive (e)" onClick={() => onAct('archive')}><Archive size={15} /></button>
        <button className="icon-btn" title="Delete (#)" onClick={() => onAct('trash')}><Trash2 size={15} /></button>
        <button className="icon-btn" title={unread ? 'Mark read' : 'Mark unread'} onClick={() => onAct(unread ? 'read' : 'unread')}>{unread ? <MailOpen size={15} /> : <MailIcon size={15} />}</button>
        <button className="icon-btn" title="Flag (s)" onClick={() => onAct(m.isFlagged ? 'unflag' : 'flag')}><Star size={15} fill={m.isFlagged ? '#f59e0b' : 'none'} color={m.isFlagged ? '#f59e0b' : 'currentColor'} /></button>
        <button className="icon-btn" title="Snooze until tomorrow" onClick={() => onAct('snooze', { until: snoozeOptions().find((o) => o[0] === 'Tomorrow morning')[1] })}><Clock size={15} /></button>
      </div>
    </div>
  );
}

function OutboxList({ onMenu }) {
  const [items, setItems] = useState([]);
  const [drafts, setDrafts] = useState([]);
  const load = () => { api.get('/api/outbox').then(setItems).catch(toastError); api.get('/api/drafts').then(setDrafts).catch(() => {}); };
  useEffect(() => { load(); return onEvent((e) => ['outbox:changed', 'mail:sent', 'mail:sendError'].includes(e.type) && load()); }, []);
  const who = (list) => (list || []).map((a) => (typeof a === 'string' ? a : a.name || a.address)).join(', ');
  return (
    <section className="list-pane" style={{ flex: 1, width: 'auto' }}>
      <div className="list-head" style={{ paddingBottom: 10 }}><div className="row"><button className="icon-btn mobile-only" onClick={onMenu}><MenuIcon size={18} /></button><h3 style={{ margin: 0, fontSize: 17 }}>Outbox & drafts</h3></div></div>
      <div className="list">
        <div className="nav-section" style={{ cursor: 'default' }}>Waiting to be sent · {items.length}</div>
        {items.map((o) => (
          <div key={o.id} className="msg-row">
            <div className="body">
              <div className="from"><span className="truncate">To: {who(o.to)}</span>
                <span className="date">{o.status === 'failed' ? <span className="error-text">Failed</span> : `Sends ${new Date(o.sendAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`}</span></div>
              <div className="subject">{o.subject || '(no subject)'}</div>
              {o.error && <div className="small error-text">{o.error}</div>}
              <div className="row" style={{ marginTop: 6 }}>
                <button className="btn sm" onClick={async () => { const r = await api.post(`/api/outbox/${o.id}/cancel`).catch(toastError); if (r) { openComposer(r.payload); load(); } }}>Edit</button>
                <button className="btn sm danger" onClick={() => api.post(`/api/outbox/${o.id}/cancel`).then(load).catch(toastError)}>Cancel</button>
                {(o.status === 'failed' || o.error) && <>
                  <button className="btn sm" onClick={() => api.post(`/api/outbox/${o.id}/retry`).then(load).catch(toastError)}>Send again</button>
                  <button className="btn sm" onClick={() => api.post(`/api/outbox/${o.id}/to-draft`).then(() => { toast('Saved as draft — nothing was sent'); load(); }).catch(toastError)}>Save as draft</button>
                </>}
              </div>
            </div>
          </div>
        ))}
        {!items.length && <div className="empty" style={{ padding: 20 }}>Nothing waiting to be sent.</div>}
        <div className="nav-section" style={{ cursor: 'default' }}>Drafts · {drafts.length}</div>
        {drafts.map((d) => (
          <div key={d.id} className="msg-row" onClick={() => openComposer({ ...d, draftId: d.id })}>
            <div className="body">
              <div className="from"><span className="truncate">{d.to?.length ? `To: ${who(d.to)}` : '(no recipients)'}</span><span className="date">{fmtListDate(d.updatedAt)}</span></div>
              <div className="subject truncate">{d.subject || '(no subject)'}</div>
            </div>
            <button className="icon-btn" title="Delete draft" onClick={async (e) => { e.stopPropagation(); await api.del(`/api/drafts/${d.id}`); load(); }}><Trash2 size={15} /></button>
          </div>
        ))}
        {!drafts.length && <div className="empty" style={{ padding: 20 }}>Drafts are saved automatically while you write.</div>}
      </div>
    </section>
  );
}

const ACTION_LABELS = { trash: 'Delete', spam: 'Mark as spam', forward: 'Forward', move: 'Move to Trash/Junk' };

/** Actions that AI-driven rules proposed but may not run on their own (delete, spam, forward). */
function AiApprovals() {
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const load = () => api.get('/api/ai/approvals').then(setItems).catch(() => {});
  useEffect(() => { load(); }, []);
  useEffect(() => onEvent((e) => { if (e.type === 'ai:approval') load(); }), []);
  const decide = async (ids, approve) => {
    try {
      for (const id of ids) await api.post(`/api/ai/approvals/${id}`, { approve });
      if (approve) toast(`${ids.length} action${ids.length > 1 ? 's' : ''} carried out`);
    } catch (e) { toastError(e); }
    await load();
    loadFolders();
  };
  if (!items.length) return null;
  const describe = (a) => `${ACTION_LABELS[a.action.type] || a.action.type}${a.action.type === 'forward' ? ` to ${a.action.to}` : ''}`;
  return <>
    <div className="notice warn"><Sparkles size={15} /><span className="grow">{items.length} action{items.length > 1 ? 's' : ''} from AI rules need{items.length > 1 ? '' : 's'} your approval</span>
      <button className="btn sm" onClick={() => setOpen(true)}>Review</button></div>
    {open && <Modal title="Approve actions proposed by AI rules" wide onClose={() => setOpen(false)}
      footer={<><button className="btn" onClick={() => decide(items.map((a) => a.id), false)}>Dismiss all</button><span className="grow" /><button className="btn" onClick={() => setOpen(false)}>Close</button></>}>
      <div className="small muted">Rules that depend on the AI's judgement never delete, mark as spam or forward mail by themselves — a crafted email could steer that judgement. Nothing below happens until you approve it.</div>
      {items.map((a) => (
        <div key={a.id} className="card item-card" style={{ alignItems: 'flex-start' }}>
          <div className="grow" style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600 }} className={a.action.type === 'forward' ? 'error-text' : ''}>{describe(a)}</div>
            <a href={`#/mail/unified/${a.messageId}`} onClick={() => setOpen(false)} className="truncate" style={{ display: 'block' }}>{a.message.subject || '(no subject)'}</a>
            <div className="small muted truncate">{a.message.from} · rule “{a.ruleName || 'Untitled'}”{a.message.category ? ` · AI: ${a.message.category}, priority ${a.message.priority}` : ''}</div>
          </div>
          <button className="btn sm" onClick={() => decide([a.id], false)}>Dismiss</button>
          <button className={`btn sm ${a.action.type === 'forward' ? '' : 'primary'}`} onClick={() => decide([a.id], true)}>Approve</button>
        </div>
      ))}
    </Modal>}
  </>;
}

const FILTER_CATS = ['personal', 'work', 'finance', 'shopping', 'travel', 'newsletter', 'promotion', 'social', 'notification', 'security', 'calendar', 'support', 'other'];

/** Filter controls for search: they edit the operators in the query (category:, topic:, is:, has:, newer_than:). */
function SearchFilters({ query, onChange }) {
  const folders = store.use((s) => s.folders);
  const tokens = query.match(/-?\w+:("[^"]*"|\S+)|"[^"]*"|\S+/g) || [];
  const get = (key) => { const t = tokens.find((x) => x.toLowerCase().startsWith(`${key}:`)); return t ? t.slice(key.length + 1).replace(/^"|"$/g, '') : ''; };
  const has = (tok) => tokens.some((x) => x.toLowerCase() === tok);
  const set = (key, value) => {
    const rest = tokens.filter((x) => !x.toLowerCase().startsWith(`${key}:`));
    onChange([...rest, ...(value ? [`${key}:${/\s/.test(value) ? `"${value}"` : value}`] : [])].join(' '));
  };
  const toggle = (tok) => onChange((has(tok) ? tokens.filter((x) => x.toLowerCase() !== tok) : [...tokens, tok]).join(' '));
  const counts = Object.fromEntries((folders.categories || []).map((c) => [c.name, c.count]));
  return (
    <div className="search-filters">
      <select className="input" value={get('category')} onChange={(e) => set('category', e.target.value)} title="AI category">
        <option value="">Any category</option>{FILTER_CATS.map((c) => <option key={c} value={c}>{c}{counts[c] ? ` (${counts[c]})` : ''}</option>)}
      </select>
      <select className="input" value={get('topic')} onChange={(e) => set('topic', e.target.value)} title="AI topic">
        <option value="">Any topic</option>{(folders.topics || []).map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
        {get('topic') && !(folders.topics || []).some((t) => t.name.toLowerCase() === get('topic').toLowerCase()) && <option value={get('topic')}>{get('topic')}</option>}
      </select>
      <select className="input" value={get('newer_than')} onChange={(e) => set('newer_than', e.target.value)} title="Date">
        <option value="">Any time</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option><option value="1y">Last year</option>
      </select>
      {[['is:needsreply', 'Needs reply'], ['is:action', 'Action needed'], ['is:done', 'Done'], ['is:skipped', 'Not doing it'], ['is:unread', 'Unread'], ['has:attachment', 'Attachment']].map(([tok, label]) => (
        <button key={tok} type="button" className={`chip clickable ${has(tok) ? 'on' : ''}`} onClick={() => toggle(tok)}>{label}</button>))}
    </div>
  );
}
