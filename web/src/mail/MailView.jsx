import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  Inbox, Star, Clock, Send, FileText, Archive, Trash2, AlertOctagon, Folder, Tag, Search, PenSquare, Sparkles, Reply, MailOpen, Mail as MailIcon,
  ChevronDown, ChevronRight, Paperclip, CalendarPlus, Menu as MenuIcon, X, Plus, CornerUpLeft, Flame, CheckSquare, Square, RefreshCw, AlertTriangle, Send as SendIcon,
} from 'lucide-react';
import { api, onEvent } from '../api.js';
import { store } from '../store.js';
import { navigate, fmtListDate, CATEGORY_COLORS, toast, toastError } from '../util.js';
import { Avatar, useMenu, Spinner, Modal } from '../components/common.jsx';
import { loadFolders, loadLabels, saveSettings } from '../data.js';
import { openComposer } from './Composer.jsx';
import Reader from './Reader.jsx';
import { mailAction, snoozeOptions } from './mailActions.js';

const SMART = [
  ['unified', Inbox, 'All inboxes', 'unified'],
  ['important', Flame, 'Important'],
  ['needsreply', CornerUpLeft, 'Needs reply', 'needsreply'],
  ['flagged', Star, 'Flagged'],
  ['snoozed', Clock, 'Snoozed', 'snoozed'],
  ['scheduled', SendIcon, 'Outbox & scheduled', 'scheduled'],
];
const FOLDER_ICONS = { '\\Inbox': Inbox, '\\Sent': Send, '\\Drafts': FileText, '\\Archive': Archive, '\\Trash': Trash2, '\\Junk': AlertOctagon, '\\Flagged': Star };
const SPECIAL_ORDER = ['\\Inbox', '\\Drafts', '\\Sent', '\\Archive', '\\Junk', '\\Trash'];

function viewQuery(view) {
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
      {view === 'scheduled' ? <OutboxList onMenu={() => setSidebarOpen(true)} /> : <MessageList view={view} openId={openId} onMenu={() => setSidebarOpen(true)} />}
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
            <Icon size={16} /><span className="truncate">{label}</span>{countKey && folders.counts?.[countKey] > 0 && <span className="count">{folders.counts[countKey]}</span>}
          </div>
        ))}
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
                    {f.unread > 0 && !['\\Sent', '\\Trash', '\\Junk', '\\Drafts'].includes(f.specialUse) && <span className="count">{f.unread}</span>}
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
  const [tab, setTab] = useState(() => (view === 'unified' && settings.mail.focusedInbox ? 'focused' : 'all'));
  const [query, setQuery] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [openMenu, menuNode] = useMenu();
  const listRef = useRef();
  const searchRef = useRef();
  const anchor = useRef(null);
  const threaded = settings.ui.conversationView;

  const isInboxView = view === 'unified' || (view.startsWith('f') && folders.accounts.some((a) => a.folders.some((f) => `f${f.id}` === view && f.specialUse === '\\Inbox')));
  useEffect(() => { setTab(isInboxView && settings.mail.focusedInbox ? 'focused' : 'all'); setSelected(new Set()); setActiveQuery(''); setQuery(''); }, [view]);

  const params = useCallback((before) => {
    const p = new URLSearchParams({ ...viewQuery(view), limit: 50 });
    if (activeQuery) p.set('q', activeQuery);
    if (tab !== 'all') p.set('filter', tab);
    if (before) p.set('before', before);
    if (!threaded) p.set('threads', '0');
    return p;
  }, [view, tab, activeQuery, threaded]);

  const load = useCallback(async (append = false) => {
    setLoading(true);
    try {
      const before = append && items.length ? items[items.length - 1].date : null;
      const r = await api.get(`/api/messages?${params(before)}`);
      setItems((cur) => (append ? [...cur, ...r.items] : r.items));
      setHasMore(r.hasMore);
    } catch (e) { toastError(e); } finally { setLoading(false); }
  }, [params, items]);

  useEffect(() => { load(false); }, [params]);

  // Live updates.
  const reloadTimer = useRef();
  useEffect(() => onEvent((e) => {
    if (['mail:changed', 'folder:synced', 'mail:unsnoozed', 'mail:new'].includes(e.type)) {
      if (e.type === 'folder:synced' && !e.payload.newCount) return;
      clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(async () => {
        const r = await api.get(`/api/messages?${params(null)}`).catch(() => null);
        if (r) setItems((cur) => [...r.items, ...cur.slice(r.items.length).filter((x) => !r.items.some((y) => y.id === x.id))].slice(0, Math.max(cur.length, r.items.length)));
      }, 400);
    }
    if (e.type === 'ai:insight') {
      const i = e.payload.insight;
      setItems((cur) => cur.map((m) => (m.id === e.payload.messageId ? { ...m, ai: { summary: i.summary, category: i.category, priority: i.priority, needsReply: i.needsReply, isPhishing: i.isPhishing, hasDraft: !!i.draftReply } } : m)));
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
  const act = (action, extra = {}, ids = selIds) => {
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
    } else if (e.metaKey || e.ctrlKey) { toggleSel(m.id); anchor.current = m.id; }
    else { setSelected(new Set()); anchor.current = m.id; open(m); }
  };

  const rowMenu = (e, m) => {
    const ids = selected.has(m.id) ? [...selected] : [m.id];
    openMenu(e, [
      { label: 'Reply', icon: Reply, onClick: () => { open(m); setTimeout(() => window.dispatchEvent(new CustomEvent('halcyon:reply', { detail: { mode: 'reply' } })), 300); } },
      { label: m.isRead ? 'Mark as unread' : 'Mark as read', icon: m.isRead ? MailIcon : MailOpen, onClick: () => act(m.isRead ? 'unread' : 'read', {}, ids) },
      { label: m.isFlagged ? 'Unflag' : 'Flag', icon: Star, onClick: () => act(m.isFlagged ? 'unflag' : 'flag', {}, ids) },
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
    if (hasMore && !loading && el.scrollTop + el.clientHeight > el.scrollHeight - 300) load(true);
  };

  const title = useMemo(() => {
    const smart = SMART.find((s) => s[0] === view);
    if (smart) return smart[2];
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
          <button className="icon-btn" title="Refresh" onClick={() => { api.post('/api/sync'); load(false); }}>{loading ? <Spinner /> : <RefreshCw size={16} />}</button>
          <button className="icon-btn" title={threaded ? 'Conversation view: on' : 'Conversation view: off'} onClick={() => saveSettings({ ui: { conversationView: !threaded } })}><MailIcon size={16} /></button>
        </div>
        <form className="search" onSubmit={(e) => { e.preventDefault(); setActiveQuery(query.trim()); }}>
          <Search size={15} />
          <input ref={searchRef} className="input" placeholder="Search mail — try from:anna has:attachment or plain words" value={query} onChange={(e) => { setQuery(e.target.value); if (!e.target.value) setActiveQuery(''); }} />
          {query && <button type="button" className="icon-btn" style={{ position: 'absolute', right: 2, top: 1 }} onClick={() => { setQuery(''); setActiveQuery(''); }}><X size={15} /></button>}
        </form>
        {!activeQuery && <div className="tabs">
          {isInboxView && settings.mail.focusedInbox && <><button className={`tab ${tab === 'focused' ? 'active' : ''}`} onClick={() => setTab('focused')}>Focused</button><button className={`tab ${tab === 'other' ? 'active' : ''}`} onClick={() => setTab('other')}>Other</button></>}
          <button className={`tab ${tab === 'all' ? 'active' : ''}`} onClick={() => setTab('all')}>All</button>
          <button className={`tab ${tab === 'unread' ? 'active' : ''}`} onClick={() => setTab('unread')}>Unread</button>
          <button className={`tab ${tab === 'attachments' ? 'active' : ''}`} onClick={() => setTab('attachments')} title="With attachments"><Paperclip size={14} /></button>
        </div>}
      </div>
      {bulk && (
        <div className="bulk-bar">
          <button className="icon-btn" title="Clear selection" onClick={() => setSelected(new Set())}><X size={16} /></button>
          <span className="small grow">{selected.size} selected</span>
          <button className="icon-btn" title="Select all" onClick={() => setSelected(new Set(items.map((m) => m.id)))}><CheckSquare size={16} /></button>
          <button className="icon-btn" title="Mark read" onClick={() => act('read')}><MailOpen size={16} /></button>
          <button className="icon-btn" title="Mark unread" onClick={() => act('unread')}><MailIcon size={16} /></button>
          <button className="icon-btn" title="Archive" onClick={() => act('archive')}><Archive size={16} /></button>
          <button className="icon-btn" title="Delete" onClick={() => act('trash')}><Trash2 size={16} /></button>
          <button className="icon-btn" title="More" onClick={(e) => rowMenu(e, items.find((m) => selected.has(m.id)))}><ChevronDown size={16} /></button>
        </div>
      )}
      <div className={`list ${bulk ? 'selecting' : ''}`} ref={listRef} onScroll={onScroll}>
        {items.map((m) => <Row key={m.id} m={m} selected={selected.has(m.id) || m.id === openId} checked={selected.has(m.id)} threaded={threaded}
          onClick={(e) => clickRow(e, m)} onContextMenu={(e) => rowMenu(e, m)} onCheck={() => toggleSel(m.id)} onAct={(a, extra) => act(a, extra, [m.id])}
          dragIds={selected.has(m.id) ? [...selected] : [m.id]} showAi={settings.ai.enabled} />)}
        {!items.length && !loading && <div className="empty"><Inbox size={36} />{activeQuery ? 'No messages match your search.' : tab === 'focused' ? 'Nothing important right now. Check "Other".' : 'No messages here.'}</div>}
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
  const prioColor = ai?.priority >= 80 ? 'var(--danger)' : ai?.priority >= 60 ? 'var(--warning)' : null;
  return (
    <div className={`msg-row ${unread ? 'unread' : ''} ${selected ? 'selected' : ''}`} onClick={onClick} onContextMenu={onContextMenu} draggable
      onDragStart={(e) => { e.dataTransfer.setData('application/x-halcyon', JSON.stringify({ ids: dragIds, threads: threaded })); e.dataTransfer.effectAllowed = 'move'; }}>
      <div onClick={(e) => { e.stopPropagation(); onCheck(); }} style={{ cursor: 'pointer' }}>
        {checked ? <div className="avatar" style={{ background: 'var(--accent)' }}><CheckSquare size={18} /></div> : <Avatar name={m.from.name} email={m.from.address} />}
      </div>
      <div className="body">
        <div className="from">
          {prioColor && <span className="prio-dot" style={{ background: prioColor }} title={`Priority ${ai.priority}`} />}
          <span className="truncate">{m.folder?.specialUse === '\\Sent' ? `To: ${m.to.map((a) => a.name || a.address).join(', ')}` : m.from.name || m.from.address}</span>
          {threaded && m.threadCount > 1 && <span className="faint small">{m.threadCount}</span>}
          <span className="date">{m.snoozedUntil ? <span title="Snoozed until"><Clock size={11} /> {fmtListDate(m.snoozedUntil)}</span> : fmtListDate(m.date)}</span>
        </div>
        <div className="subject truncate">{m.subject || '(no subject)'}</div>
        {showAi && ai?.summary ? <div className="ai-line"><Sparkles size={12} /><span style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{ai.summary}</span></div>
          : <div className="snippet truncate">{m.snippet}</div>}
        <div className="meta">
          {ai?.isPhishing && <span className="chip" style={{ background: '#fee2e2', color: '#991b1b' }}><AlertTriangle size={11} /> Suspicious</span>}
          {ai?.needsReply && !m.isAnswered && <span className="chip ai"><CornerUpLeft size={11} /> Reply needed</span>}
          {ai?.hasDraft && !m.isAnswered && <span className="chip ai"><Sparkles size={11} /> Draft ready</span>}
          {ai?.category && !['work', 'personal', 'other'].includes(ai.category) && <span className="chip" style={{ color: CATEGORY_COLORS[ai.category] }}>{ai.category}</span>}
          {m.hasInvite && <span className="chip"><CalendarPlus size={11} /> Invitation</span>}
          {m.hasAttachments && <Paperclip size={13} className="faint" />}
          {m.isFlagged && <Star size={13} fill="#f59e0b" color="#f59e0b" />}
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
  const load = () => api.get('/api/outbox').then(setItems).catch(toastError);
  useEffect(() => { load(); return onEvent((e) => ['outbox:changed', 'mail:sent', 'mail:sendError'].includes(e.type) && load()); }, []);
  return (
    <section className="list-pane" style={{ flex: 1, width: 'auto' }}>
      <div className="list-head" style={{ paddingBottom: 10 }}><div className="row"><button className="icon-btn mobile-only" onClick={onMenu}><MenuIcon size={18} /></button><h3 style={{ margin: 0, fontSize: 17 }}>Outbox & scheduled</h3></div></div>
      <div className="list">
        {items.map((o) => (
          <div key={o.id} className="msg-row">
            <div className="body">
              <div className="from"><span className="truncate">To: {(o.to || []).map((a) => (typeof a === 'string' ? a : a.name || a.address)).join(', ')}</span>
                <span className="date">{o.status === 'failed' ? <span className="error-text">Failed</span> : `Sends ${new Date(o.sendAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`}</span></div>
              <div className="subject">{o.subject || '(no subject)'}</div>
              {o.error && <div className="small error-text">{o.error}</div>}
              <div className="row" style={{ marginTop: 6 }}>
                <button className="btn sm" onClick={async () => { const r = await api.post(`/api/outbox/${o.id}/cancel`).catch(toastError); if (r) { openComposer(r.payload); load(); } }}>Edit</button>
                <button className="btn sm danger" onClick={() => api.post(`/api/outbox/${o.id}/cancel`).then(load).catch(toastError)}>Cancel</button>
                {o.status === 'failed' && <button className="btn sm" onClick={() => api.post(`/api/outbox/${o.id}/retry`).then(load)}>Retry</button>}
              </div>
            </div>
          </div>
        ))}
        {!items.length && <div className="empty"><SendIcon size={36} />Nothing waiting to be sent.</div>}
      </div>
    </section>
  );
}
