import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  Inbox, Star, Clock, Send, FileText, Archive, Trash2, AlertOctagon, Folder, Tag, Search, PenSquare, Sparkles, Reply, MailOpen, Mail as MailIcon,
  ChevronDown, ChevronRight, Paperclip, CalendarPlus, Menu as MenuIcon, X, Plus, CornerUpLeft, Flame, CheckSquare, Square, RefreshCw, AlertTriangle, Send as SendIcon, Hash, Hourglass, Reply as ReplyIcon, Forward as ForwardIcon, ArrowUpDown, Check,
  ClipboardCheck, SlidersHorizontal, Pencil, Pin, PenLine, StickyNote, MoreHorizontal,
} from 'lucide-react';
import { api, onEvent } from '../api.js';
import { store } from '../store.js';
import { BackButton } from '../back.js';
import { extraMenuItems, archives } from './extras.js';
import { navigate, fmtListDate, toast, toastError } from '../util.js';
import { Avatar, useMenu, Spinner, Modal } from '../components/common.jsx';
import { loadFolders, loadLabels, saveSettings } from '../data.js';
import { openComposer } from './Composer.jsx';
import Reader from './Reader.jsx';
import AnalyzeOld from '../components/AnalyzeOld.jsx';
import { mailAction, snoozeOptions, confirmDelete } from './mailActions.js';

// The views used every day; the others are one click away under "More" (and shown while open).
const SMART = [
  ['unified', Inbox, 'All inboxes', 'unified'],
  ['needsreply', CornerUpLeft, 'Needs reply', 'needsreply'],
  ['needsaction', ClipboardCheck, 'Action needed', 'needsaction'],
  ['flagged', Star, 'Flagged'],
  ['snoozed', Clock, 'Snoozed', 'snoozed'],
  ['scheduled', SendIcon, 'Outbox & drafts', 'scheduled'],
];
const MORE_VIEWS = [
  ['important', Flame, 'Important'],
  ['waiting', Hourglass, 'Waiting for reply', 'waiting'],
];
const SORTS = [['date', 'Date', 'desc'], ['from', 'From', 'asc'], ['subject', 'Subject', 'asc'], ['size', 'Size', 'desc'], ['unread', 'Unread first', 'asc'], ['flagged', 'Flagged first', 'desc']];
const sortDirLabel = (key, dir) => ({ date: ['Oldest first', 'Newest first'], size: ['Smallest first', 'Largest first'], from: ['A → Z', 'Z → A'], subject: ['A → Z', 'Z → A'] }[key] || ['Ascending', 'Descending'])[dir === 'asc' ? 0 : 1];
// Per page load: last list per view/tab/sort (shown instantly when coming back) and the tab chosen per view.
const listCache = new Map();
const tabByView = new Map();
const TabCount = ({ n }) => (n > 0 ? <span className="tab-count">{n > 999 ? '999+' : n}</span> : null);

const COUNT_TITLES = { unified: 'Unread conversations', needsreply: 'Conversations waiting for your reply', needsaction: 'Open action items', snoozed: 'Snoozed conversations', scheduled: 'Messages waiting to be sent', waiting: 'Your emails that asked something and have no answer yet' };
const FOLDER_ICONS = { '\\Inbox': Inbox, '\\Sent': Send, '\\Drafts': FileText, '\\Archive': Archive, '\\Trash': Trash2, '\\Junk': AlertOctagon, '\\Flagged': Star };
const SPECIAL_ORDER = ['\\Inbox', '\\Drafts', '\\Sent', '\\Archive', '\\Junk', '\\Trash'];

// Dynamic AI views: "tp~<topic>" (ongoing project/case) and "ct~<category>".
export const topicView = (name) => `tp~${encodeURIComponent(name)}`;
export const categoryView = (name) => `ct~${encodeURIComponent(name)}`;

function viewQuery(view) {
  if (view.startsWith('tp~')) return { view: 'topic', topic: decodeURIComponent(view.slice(3)) };
  if (view.startsWith('my~')) return { view: 'mycat', customId: view.slice(3) };
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

/** Unread conversations: the important ones stand out, the rest is shown faded next to them. */
function UnreadCount({ n, important = 0, title = 'Unread conversations' }) {
  const kind = store.get().folders.counts?.emphasis || 'important';
  if (!n) return null;
  const rest = n - important;
  return (
    <span className="count-pair" title={important ? `${important} ${kind} unread · ${rest} other unread` : title}>
      {important > 0 && <span className="count imp">{important}</span>}
      {rest > 0 && <span className="count rest">{rest}</span>}
    </span>);
}

function FolderNav({ view, open, onNavigate }) {
  const folders = store.use((s) => s.folders);
  const labels = store.use((s) => s.labels);
  // Collapsed sidebar blocks (topics, categories, labels, each account) — remembered on this device.
  const [collapsed, setCollapsedState] = useState(() => { try { return JSON.parse(localStorage.getItem('halcyon.sidebar.collapsed') || 'null') || { categories: true, more: true }; } catch { return { categories: true, more: true }; } });
  const setCollapsed = (c) => { setCollapsedState(c); try { localStorage.setItem('halcyon.sidebar.collapsed', JSON.stringify(c)); } catch { /* private mode */ } };
  const toggle = (k) => setCollapsed({ ...collapsed, [k]: !collapsed[k] });
  const [editCat, setEditCat] = useState(null);
  const Chevron = ({ k }) => (collapsed[k] ? <ChevronRight size={13} /> : <ChevronDown size={13} />);
  const [dropTarget, setDropTarget] = useState(null);
  const [openMenu, menuNode] = useMenu();
  const [newFolder, setNewFolder] = useState(null);
  const [archiveDlg, setArchiveDlg] = useState(null);
  const archiveOlder = (acc, f) => setArchiveDlg({ acc, f });
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

  const [analyze, setAnalyze] = useState(null);
  const accountMenu = (e, acc) => openMenu(e, [
    { label: 'New folder', icon: Plus, onClick: () => setNewFolder({ accountId: acc.accountId }) },
    store.get().settings?.ai?.enabled && { label: 'Analyse older mail with AI…', icon: Sparkles, onClick: () => setAnalyze({ accountId: acc.accountId, name: acc.kind === 'archive' ? acc.name : acc.email }) },
    { label: acc.kind === 'archive' ? 'Archive settings' : 'Account settings', icon: SlidersHorizontal, onClick: () => navigate(acc.kind === 'archive' ? '#/settings/archives' : '#/settings/accounts') },
  ]);
  const folderMenu = (e, acc, f) => openMenu(e, [
    { label: 'Mark all as read', icon: MailOpen, onClick: () => api.post(`/api/folders/${f.id}/read-all`).then(loadFolders) },
    store.get().settings?.ai?.enabled && { label: 'Analyse older mail with AI…', icon: Sparkles, onClick: () => setAnalyze({ folderId: f.id, name: f.name }) },
    { label: 'Export as .mbox (backup)', icon: Archive, onClick: () => window.open(api.url(`/api/folders/${f.id}/export.mbox`)) },
    { label: 'Export as .eml files (ZIP)', icon: Archive, hint: 'for Outlook & co.', onClick: () => window.open(api.url(`/api/archives/export?folderId=${f.id}`)) },
    acc.kind !== 'archive' && { label: 'Move older mail to an archive…', icon: Archive, onClick: () => archiveOlder(acc, f) },
    { label: 'New subfolder', icon: Plus, onClick: () => setNewFolder({ accountId: acc.accountId, parentPath: f.path }) },
    !f.specialUse && { label: 'Rename', icon: PenSquare, onClick: () => { const n = prompt('New name', f.name); if (n) api.patch(`/api/folders/${f.id}`, { name: n }).then(() => toast('Renaming…')); } },
    { label: f.syncEnabled ? 'Stop syncing this folder' : 'Sync this folder', icon: RefreshCw, onClick: () => api.patch(`/api/folders/${f.id}`, { syncEnabled: !f.syncEnabled }).then(loadFolders) },
    ['\\Trash', '\\Junk'].includes(f.specialUse) && { label: 'Empty folder', icon: Trash2, danger: true, onClick: () => confirm(`Permanently delete all messages in ${f.name}?`) && api.post(`/api/folders/${f.id}/empty`).then(loadFolders) },
    !f.specialUse && { label: 'Delete folder', icon: Trash2, danger: true, onClick: () => confirm(`Delete folder ${f.name} and its messages?`) && api.del(`/api/folders/${f.id}`).then(() => toast('Deleting…')) },
  ]);

  return (
    <aside className={`sidebar ${open ? 'open' : ''}`}>
      {analyze && <AnalyzeOld {...analyze} onClose={() => setAnalyze(null)} />}
      <div className="sidebar-head">
        <button className="btn primary grow" style={{ justifyContent: 'center', height: 38 }} onClick={() => openComposer({})}><PenSquare size={16} /> New message</button>
      </div>
      <div className="sidebar-scroll">
        {(store.get().accounts || []).filter((x) => x.autoReplyOn).map((x) => (
          <div key={`ar${x.id}`} className="notice small" style={{ margin: '0 4px 8px', cursor: 'pointer' }} title="Change or turn off in Settings → Accounts" onClick={() => navigate('#/settings/accounts')}>
            Automatic replies are on · {x.email}</div>))}
        {[...SMART, ...MORE_VIEWS.filter(([key]) => view === key || !collapsed.more)].map(([key, Icon, label, countKey]) => (
          <div key={key} className={`nav-item ${view === key ? 'active' : ''}`} onClick={() => go(key)}>
            <Icon size={16} /><span className="truncate">{label}</span>{countKey === 'unified' ? <UnreadCount n={folders.counts?.unified} important={folders.counts?.unifiedImportant} /> : countKey && folders.counts?.[countKey] > 0 && (countKey === 'scheduled' && folders.counts.outboxFailed > 0
              ? <span className="count failed" title={`${folders.counts.outboxFailed} could not be sent — open to retry, edit or keep as draft`}>{folders.counts[countKey]}</span>
              : <span className="count" title={COUNT_TITLES[countKey]}>{folders.counts[countKey]}</span>)}
          </div>
        ))}
        <div className="nav-item faint small more-toggle" onClick={() => toggle('more')}>{collapsed.more ? <ChevronRight size={14} /> : <ChevronDown size={14} />} {collapsed.more ? 'More' : 'Less'}</div>
        {!collapsed.more && <>
          {!(folders.custom || []).length && <div className="nav-item faint small" onClick={() => setEditCat({})}><Plus size={14} /> New category</div>}
          {!labels.length && <div className="nav-item faint small" onClick={async () => { const n = prompt('Label name'); if (n) { await api.post('/api/labels', { name: n, color: `hsl(${Math.random() * 360 | 0} 60% 50%)` }); loadLabels(); } }}><Plus size={14} /> New label</div>}
        </>}
        {folders.topics?.length > 0 && <>
          <div className="nav-section" onClick={() => toggle('topics')} title="Ongoing projects, events and cases recognised by the AI — most recent and most urgent first"><Chevron k="topics" /> Topics</div>
          {!collapsed.topics && folders.topics.map((t) => (
            <div key={t.name} className={`nav-item ${view === topicView(t.name) ? 'active' : ''}`} onClick={() => go(topicView(t.name))} title={`${t.count} messages in the last 60 days${t.next ? ` · next: ${new Date(t.next).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}` : ''}${t.actions ? ` · ${t.actions} open action${t.actions > 1 ? 's' : ''}` : ''}`}>
              <Hash size={15} /><span className="truncate">{t.name}</span>
              {t.next && t.next < Date.now() + 14 * 864e5 && <span className="small faint" style={{ marginLeft: 'auto', flex: 'none' }}>{new Date(t.next).toLocaleDateString([], { day: 'numeric', month: 'short' })}</span>}
              {t.unread > 0 && <span className="count" style={t.next && t.next < Date.now() + 14 * 864e5 ? { marginLeft: 6 } : undefined}>{t.unread}</span>}
            </div>))}
        </>}
        {(folders.custom || []).length > 0 && <div className="nav-section" onClick={() => toggle('custom')} title="Your own categories — described in words (the AI sorts mail into them) or a saved search">
          <Chevron k="custom" /><span className="grow">My categories</span>
          <button className="icon-btn" style={{ width: 22, height: 22 }} title="New category" onClick={(e) => { e.stopPropagation(); setEditCat({}); }}><Plus size={13} /></button></div>}
        {!collapsed.custom && (folders.custom || []).map((c) => (
          <div key={c.id} className={`nav-item ${view === `my~${c.id}` ? 'active' : ''}`} onClick={() => go(`my~${c.id}`)} title={c.description || c.query}
            onContextMenu={(e) => openMenu(e, [
              { label: 'Edit…', icon: Pencil, onClick: () => setEditCat(c) },
              c.description && { label: 'Look through past mail again', icon: RefreshCw, onClick: () => api.post(`/api/custom-categories/${c.id}/rescan`).then(() => toast('Looking through past mail in the background…')).catch(toastError) },
              { label: 'Delete category', icon: Trash2, danger: true, onClick: () => confirm(`Delete the category “${c.name}”? (The mail stays.)`) && api.del(`/api/custom-categories/${c.id}`).then(loadFolders) },
            ])}>
            <Tag size={15} color={c.color || 'var(--accent)'} /><span className="truncate">{c.name}</span>{c.unread > 0 ? <span className="count">{c.unread}</span> : <span className="count faint">{c.count || ''}</span>}
          </div>))}
        {folders.categories?.length > 0 && <>
          <div className="nav-section" onClick={() => toggle('categories')}><Chevron k="categories" /> AI categories</div>
          {!collapsed.categories && folders.categories.map((c) => (
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
              <div className="nav-section account-head" onClick={() => setCollapsed({ ...collapsed, [acc.accountId]: !(collapsed[acc.accountId] ?? acc.kind === 'archive') })} onContextMenu={(e) => accountMenu(e, acc)}>
                {(collapsed[acc.accountId] ?? acc.kind === 'archive') ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                <span className="dot" style={{ background: acc.color }} />
                {acc.kind === 'archive' && <span title="Archive — kept by Halcyon, on no mail server"><Archive size={13} /></span>}
                <span className="truncate grow" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12.5 }}>{acc.kind === 'archive' ? acc.name : acc.email}{acc.ownerName ? <span className="faint"> · {acc.ownerName}</span> : ''}</span>
                {acc.syncState === 'syncing' && <Spinner size={12} />}
                {acc.syncState === 'error' && <span title={acc.syncError}><AlertTriangle size={13} color="var(--danger)" /></span>}
                <button className="icon-btn head-more" title="New folder, analyse, settings" onClick={(e) => { e.stopPropagation(); accountMenu(e, acc); }}><MoreHorizontal size={14} /></button>
              </div>
              {!(collapsed[acc.accountId] ?? acc.kind === 'archive') && sorted.map((f) => {
                const Icon = FOLDER_ICONS[f.specialUse] || Folder;
                const depth = f.parentPath ? f.path.split(f.delimiter || '/').length - 1 : 0;
                const key = `f${f.id}`;
                return (
                  <div key={f.id} className={`nav-item ${view === key ? 'active' : ''} ${dropTarget === key ? 'drop' : ''}`} style={{ paddingLeft: 10 + depth * 14, opacity: f.syncEnabled ? 1 : 0.55 }}
                    onClick={() => go(key)} onContextMenu={(e) => folderMenu(e, acc, f)} {...dropProps(key, f.id)}>
                    <Icon size={16} /><span className="truncate">{f.name}</span>
                    {f.unread > 0 && !['\\Sent', '\\Trash', '\\Junk', '\\Drafts'].includes(f.specialUse) && <UnreadCount n={f.unread} important={f.important} />}
                    {f.specialUse === '\\Drafts' && f.total > 0 && <span className="count faint">{f.total}</span>}
                  </div>
                );
              })}
            </div>
          );
        })}
        {labels.length > 0 && <div className="nav-section" onClick={() => toggle('labels')}><Chevron k="labels" /><span className="grow">Labels</span><button className="icon-btn" style={{ width: 22, height: 22 }} title="New label" onClick={async (e) => { e.stopPropagation(); const n = prompt('Label name'); if (n) { await api.post('/api/labels', { name: n, color: `hsl(${Math.random() * 360 | 0} 60% 50%)` }); loadLabels(); } }}><Plus size={13} /></button></div>}
        {!collapsed.labels && labels.map((l) => (
          <div key={l.id} className={`nav-item ${view === `l${l.id}` ? 'active' : ''}`} onClick={() => go(`l${l.id}`)}
            onContextMenu={(e) => openMenu(e, [{ label: 'Delete label', icon: Trash2, danger: true, onClick: () => api.del(`/api/labels/${l.id}`).then(loadLabels) }])}>
            <Tag size={15} color={l.color} /><span className="truncate">{l.name}</span>
          </div>
        ))}
      </div>
      {menuNode}
      {newFolder && <NewFolderModal {...newFolder} onClose={() => setNewFolder(null)} />}
      {editCat && <CategoryEditor cat={editCat} onClose={() => setEditCat(null)} />}
      {archiveDlg && <ArchiveOlder {...archiveDlg} onClose={() => setArchiveDlg(null)} />}
    </aside>
  );
}

/** A category of the user's own: described in words (the AI sorts mail into it) and/or a saved search. */
function CategoryEditor({ cat, onClose }) {
  const accounts = store.use((s) => s.accounts);
  const [f, setF] = useState({ name: cat.name || '', description: cat.description || '', query: cat.query || '', accountId: cat.accountId || '', color: cat.color || '#7c3aed' });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      if (cat.id) await api.patch(`/api/custom-categories/${cat.id}`, f); else await api.post('/api/custom-categories', f);
      toast(f.description && (!cat.id || f.description !== cat.description) ? `Saved — the AI is sorting past mail into “${f.name}” in the background` : 'Saved');
      loadFolders(); onClose();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  return <Modal title={cat.id ? `Edit “${cat.name}”` : 'New category'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !f.name.trim() || (!f.description.trim() && !f.query.trim())} onClick={save}>Save</button></>}>
    <label className="field">Name<input className="input" autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Gift vouchers, Newborn shoots" /></label>
    <label className="field">What belongs here <span className="faint">— in your words; the AI sorts new mail (and, once, past mail) into it</span>
      <textarea className="input" rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="e.g. Buying, redeeming or asking about gift vouchers (darilni boni)" /></label>
    <label className="field">And/or a search <span className="faint">— optional, e.g. <code>voucher OR bon</code>, <code>from:pixieset.com</code></span>
      <input className="input" value={f.query} onChange={(e) => setF({ ...f, query: e.target.value })} /></label>
    <div className="row" style={{ gap: 12 }}>
      <label className="field" style={{ flex: 1 }}>Only mail of<select className="input" value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })}>
        <option value="">All accounts</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.email}</option>)}</select></label>
      <label className="field">Colour<input className="input" type="color" style={{ width: 60, padding: 2 }} value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} /></label>
    </div>
    <div className="small faint">Right-click an email to add it to the category or take it out — the AI keeps to what you decide.</div>
  </Modal>;
}

/** A folder's mail older than a date, into an archive (like Outlook's AutoArchive) — in the background. */
function ArchiveOlder({ acc, f, onClose }) {
  const list = archives(acc.owner ?? null);
  const [archiveId, setArchiveId] = useState(list[0]?.accountId || 'new');
  const [name, setName] = useState(`Archive ${new Date().getFullYear()}`);
  const [years, setYears] = useState('1');
  const [keep, setKeep] = useState(false);
  const [busy, setBusy] = useState(false);
  const before = () => { const d = new Date(); d.setFullYear(d.getFullYear() - Number(years)); return d.getTime(); };
  const go = async () => {
    setBusy(true);
    try {
      // (accountId: sent as the folder's owner — a shared space's archive for its mail.)
      const id = archiveId === 'new' ? (await api.post('/api/archives', { name, accountId: acc.accountId })).id : archiveId;
      await api.post(`/api/archives/${id}/move`, { folderId: f.id, before: before(), keep, accountId: acc.accountId });
      toast('Archiving in the background…', { action: { label: 'Progress', onClick: () => navigate('#/settings/archives') } });
      loadFolders(); onClose();
    } catch (e) { toastError(e); setBusy(false); }
  };
  return <Modal title={`Move older mail from “${f.name}” to an archive`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || (archiveId === 'new' && !name.trim())} onClick={go}>Move to archive</button></>}>
    <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
      <label className="field">Mail older than<select className="input" value={years} onChange={(e) => setYears(e.target.value)}>
        {[['1', '1 year'], ['2', '2 years'], ['3', '3 years'], ['5', '5 years'], ['0', 'everything in this folder']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      <label className="field">Archive<select className="input" value={archiveId} onChange={(e) => setArchiveId(e.target.value === 'new' ? 'new' : Number(e.target.value))}>
        {list.map((a) => <option key={a.accountId} value={a.accountId}>{a.name}</option>)}<option value="new">New archive…</option></select></label>
      {archiveId === 'new' && <label className="field">Name<input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>}
      <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> Copy only — keep the mail on the server too</label>
    </div>
    <p className="small muted">Each email is copied into the archive (kept by Halcyon, folder “{f.name}”), checked, and then {keep ? 'left where it is' : 'moved to Trash on the mail server — it is removed there when Trash is emptied'}. Only mail Halcyon has downloaded is moved: for older mail, set the account to download all mail first (Settings → Accounts → History).</p>
  </Modal>;
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
  const [pull, setPull] = useState(0);
  const pullStart = useRef(null);
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
  // Each conversation (or message) once — pages and refreshes can bring another message of a conversation already shown.
  const dedupe = (list) => { const seen = new Set(); return list.filter((m) => { const k = `${m.owner || ''}|${threaded && m.threadId ? m.threadId : `#${m.id}`}`; if (seen.has(k)) return false; seen.add(k); return true; }); };
  // Sort order is a per-device choice; newest first pages by date, other orders by offset.
  const [sort, setSortState] = useState(() => { try { return JSON.parse(localStorage.getItem('halcyon.sort')) || { key: 'date', dir: 'desc' }; } catch { return { key: 'date', dir: 'desc' }; } });
  // A new order puts the open message where it belongs in it (not kept on top): it is looked up and scrolled to.
  const seekOpen = useRef(0), seekLive = useRef(false);
  const setSort = (s) => { seekOpen.current = 6; seekLive.current = false; setSortState(s); try { localStorage.setItem('halcyon.sort', JSON.stringify(s)); } catch { /* private mode */ } };
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

  // Pinned conversations stand above the list in the inbox views (newest-first order, no search), in every tab.
  const pinsOn = isInboxView && !activeQuery && byDate;
  const [pinned, setPinned] = useState([]);
  const loadPinned = () => {
    if (!pinsOn) { setPinned([]); return; }
    const p = new URLSearchParams({ ...viewQuery(view), limit: 50, pinned: '1' });
    if (!threaded) p.set('threads', '0');
    api.get(`/api/messages?${p}`).then((r) => setPinned(r.items)).catch(() => {});
  };
  const params = useCallback((before, offset) => {
    const p = new URLSearchParams({ ...viewQuery(view), limit: 50 });
    if (pinsOn) p.set('pinned', '0');
    if (!byDate) { p.set('sort', sort.key); p.set('dir', sort.dir); if (offset) p.set('offset', offset); }
    if (activeQuery) { p.set('q', activeQuery); p.set('semantic', '0'); }
    if (effectiveTab !== 'all') p.set('filter', effectiveTab);
    if (before) p.set('before', before);
    if (!threaded) p.set('threads', '0');
    return p;
  }, [view, effectiveTab, activeQuery, threaded, sort, pinsOn]);

  // The open message stays in the list (e.g. in "Unread" after it was read) until the user moves to another one —
  // not in the AI views: an action done or a reply sent takes it off Action needed / Needs reply at once. A
  // conversation already in the new list (with another of its messages) is not added a second time.
  const openRef = useRef(openId);
  const keepOpen = (next, cur) => {
    const id = openRef.current;
    if (!id || next.some((m) => m.id === id) || ['needsaction', 'needsreply', 'waiting', 'important', 'snoozed'].includes(view)) return next;
    const i = cur.findIndex((m) => m.id === id);
    if (i < 0 || (threaded && cur[i].threadId && next.some((m) => m.threadId === cur[i].threadId))) return next;
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
        const next = append ? dedupe([...cur, ...r.items]) : seekOpen.current ? r.items : keepOpen(r.items, cur);
        if (!append && seekOpen.current) seekLive.current = true;
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
    loadPinned();
  }, [params]);

  // After a new order: the open message is found (more pages loaded, a few at most) and scrolled into view.
  useEffect(() => {
    if (!seekOpen.current || !seekLive.current || loading || !openId) return;
    if (items.some((m) => m.id === openId)) {
      seekOpen.current = 0;
      requestAnimationFrame(() => listRef.current?.querySelector(`.msg-row[data-id="${openId}"]`)?.scrollIntoView({ block: 'center' }));
    } else if (hasMore && --seekOpen.current > 0) load(true);
    else seekOpen.current = 0;
  }, [items, loading]);

  // A search started from the command palette (Ctrl+K).
  useEffect(() => {
    const h = (e) => { setQuery(e.detail.q); setActiveQuery(e.detail.q); };
    window.addEventListener('halcyon:search', h);
    return () => window.removeEventListener('halcyon:search', h);
  }, []);

  // The tab counts (Focused / Other / All) follow every change to mail — reading a conversation opened in Focused
  // also reads its messages counted under Other — and every refresh of the list.
  useEffect(() => {
    let t = null;
    const later = () => { clearTimeout(t); t = setTimeout(loadTabCounts, 400); };
    const kinds = ['halcyon:mutated', 'halcyon:poll', 'halcyon:tabcounts'];
    kinds.forEach((k) => window.addEventListener(k, later));
    return () => { clearTimeout(t); kinds.forEach((k) => window.removeEventListener(k, later)); };
  }, [view, activeQuery]);

  // Live updates: the first page is asked again and merged with what is shown (rows further down stay).
  const reloadTimer = useRef();
  const refresh = (ms = 300) => {
    clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(async () => {
      loadPinned();
      const r = await api.get(`/api/messages?${params(null)}`).catch(() => null);
      if (r) setItems((cur) => keepOpen(dedupe([...r.items, ...cur.slice(r.items.length).filter((x) => !r.items.some((y) => y.id === x.id))].slice(0, Math.max(cur.length, r.items.length))), cur));
    }, ms);
  };
  // Our own changes (read, moved, flagged, an action done, a reply marked…): the list follows at once, and once more
  // when the server has applied follow-up work.
  useEffect(() => {
    let later = null;
    const h = () => { refresh(150); clearTimeout(later); later = setTimeout(() => refresh(0), 2500); };
    window.addEventListener('halcyon:mutated', h);
    return () => { clearTimeout(later); window.removeEventListener('halcyon:mutated', h); };
  }, [params]);
  // Periodic refresh when the live connection is down (see App), and after "Sync now".
  useEffect(() => {
    const h = () => { clearTimeout(reloadTimer.current); reloadTimer.current = setTimeout(() => load(false), 200); };
    window.addEventListener('halcyon:poll', h);
    return () => window.removeEventListener('halcyon:poll', h);
  }, [params]);

  useEffect(() => onEvent((e) => {
    // A finished analysis can move a message between Focused and Other: re-query those tabs.
    // A finished analysis can move a message between Focused and Other, or in / out of the AI views: re-query those.
    if (e.type === 'ai:insight' && (effectiveTab === 'focused' || effectiveTab === 'other' || ['needsaction', 'needsreply', 'important', 'waiting'].includes(view))) refresh(800);
    if (['mail:changed', 'folder:synced', 'mail:unsnoozed', 'mail:new'].includes(e.type)) {
      if (e.type === 'folder:synced' && !e.payload.newCount) return;
      window.dispatchEvent(new Event('halcyon:tabcounts'));
      refresh(400);
    }
    if (e.type === 'ai:insight') {
      const i = e.payload.insight;
      // Merged into what the row already has (action, open-item state, etc. are kept).
      setItems((cur) => cur.map((m) => (m.id === e.payload.messageId ? { ...m, ai: { ...(m.ai || {}), summary: i.summary, category: i.category, priority: i.priority, needsReply: i.needsReply && !i.dismissed,
        needsAction: i.needsAction && !i.dismissed, actionSummary: i.actionSummary, isPhishing: i.isPhishing, hasDraft: !!i.draftReply, topic: i.topic, expired: i.expired } } : m)));
    }
    if (e.type === 'ai:draft') setItems((cur) => cur.map((m) => (m.id === e.payload.messageId && m.ai ? { ...m, ai: { ...m.ai, hasDraft: true } } : m)));
  }), [params]);

  // Marking as read happens in the reader (it knows every message shown, also in a conversation); the list follows.
  const open = (m) => navigate(`#/mail/${view}/${m.id}`);
  useEffect(() => {
    const h = (e) => setItems((cur) => cur.map((x) => (e.detail.ids.includes(x.id) || e.detail.threadId === x.threadId ? { ...x, isRead: true, threadUnread: 0 } : x)));
    window.addEventListener('halcyon:read', h);
    return () => window.removeEventListener('halcyon:read', h);
  }, []);

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
      for (const id of ids) await api.post(`/api/messages/${id}/dismiss`, { resolution, thread: threaded });
      setItems((cur) => (view === 'needsaction' ? cur.filter((x) => !ids.includes(x.id)) : cur.map((x) => (ids.includes(x.id) && x.ai ? { ...x, ai: { ...x.ai, needsAction: false } } : x))));
      setSelected(new Set());
      toast(resolution === 'skipped' ? `Not doing it — ${ids.length} removed from Action needed` : resolution === 'wrong' ? `Not an action — the AI will learn from this` : `Done — ${ids.length} removed from Action needed`);
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

  const togglePin = (m) => api.post(`/api/messages/${m.id}/pin`, { pinned: !m.pinned })
    .then(() => { toast(m.pinned ? 'Unpinned' : 'Pinned to the top of the inbox'); loadPinned(); load(false); }).catch(toastError);
  const rowMenu = (e, m) => {
    const ids = selected.has(m.id) ? [...selected] : [m.id];
    // Right-click selects what it acts on, so it is visible which messages a menu choice applies to.
    if (!selected.has(m.id) && selected.size) setSelected(new Set());
    openMenu(e, [
      { label: 'Reply', icon: Reply, onClick: () => { open(m); setTimeout(() => window.dispatchEvent(new CustomEvent('halcyon:reply', { detail: { mode: 'reply' } })), 300); } },
      { label: m.isRead ? 'Mark as unread' : 'Mark as read', icon: m.isRead ? MailIcon : MailOpen, onClick: () => act(m.isRead ? 'unread' : 'read', {}, ids) },
      { label: m.isFlagged ? 'Unflag' : 'Flag', icon: Star, onClick: () => act(m.isFlagged ? 'unflag' : 'flag', {}, ids) },
      { label: m.pinned ? 'Unpin' : 'Pin to top', icon: Pin, onClick: () => togglePin(m) },
      { label: 'Create task…', icon: ClipboardCheck, onClick: () => store.set({ taskDialog: m.id }) },
      m.ai?.needsAction && { label: 'Action: done', icon: ClipboardCheck, onClick: () => settleMany(ids, 'done') },
      m.ai?.needsAction && { label: 'Action: not doing it', icon: X, onClick: () => settleMany(ids, 'skipped') },
      m.ai?.needsAction && { label: 'Action: not an action (AI was wrong)', icon: X, hint: 'AI learns', onClick: () => settleMany(ids, 'wrong') },
      { label: 'Mark as needs reply', icon: CornerUpLeft, onClick: () => needsReplyMany(ids, true) },
      { label: 'Remove “needs reply”', icon: CornerUpLeft, onClick: () => needsReplyMany(ids, false) },
      settings.ai.enabled && { label: 'Mark as important', icon: Flame, hint: 'AI learns', onClick: () => feedbackMany(ids, 'important') },
      settings.ai.enabled && { label: 'Mark as not important', icon: MailOpen, hint: 'AI learns', onClick: () => feedbackMany(ids, 'unimportant') },
      ...((folders.custom || []).length ? ['sep', { section: 'My categories' }, ...folders.custom.map((c) => {
        const inIt = (m.myCategories || []).includes(c.id);
        return { label: `${inIt ? '✓ ' : ''}${c.name}`, icon: Tag, hint: inIt ? 'take out' : 'add', onClick: () => api.post(`/api/custom-categories/${c.id}/tag`, { ids, value: !inIt }).then(() => { toast(inIt ? `Taken out of “${c.name}”` : `Added to “${c.name}”`); load(false); loadFolders(); }).catch(toastError) };
      }), 'sep'] : []),
      { label: 'Archive', icon: Archive, onClick: () => act('archive', {}, ids) },
      { label: 'Delete', icon: Trash2, onClick: () => act('trash', {}, ids) },
      { label: 'Spam', icon: AlertOctagon, onClick: () => act('spam', {}, ids) },
      ...extraMenuItems({ msg: m, ids, onDone: () => load(false) }),
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
    const smart = [...SMART, ...MORE_VIEWS].find((s) => s[0] === view);
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
          <BackButton className="icon-btn" compact />
          <h3 style={{ margin: 0, fontSize: 17 }} className="grow truncate">{activeQuery ? 'Search results' : title}</h3>
          <button className="icon-btn" title="Check for new mail" onClick={() => { window.dispatchEvent(new Event('halcyon:sync')); load(false); }}>{loading ? <Spinner /> : <RefreshCw size={16} />}</button>
          <button className="icon-btn" title={threaded ? 'Conversation view: on' : 'Conversation view: off'} onClick={() => saveSettings({ ui: { conversationView: !threaded } })}><MailIcon size={16} /></button>
        </div>
        <form className="search" onSubmit={(e) => { e.preventDefault(); setActiveQuery(query.trim()); }}>
          <Search size={15} />
          <input ref={searchRef} className="input" placeholder='Search mail — words, or from:anna received:"last week" hasattachments:yes' value={query} onChange={(e) => { setQuery(e.target.value); if (!e.target.value) setActiveQuery(''); }} />
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
      {pull > 0 && <div className="pull-hint" style={{ height: pull }}>{pull > 70 ? 'Release to refresh' : 'Pull to refresh'}</div>}
      <div className={`list ${bulk ? 'selecting' : ''}`} ref={listRef} onScroll={onScroll}
        onTouchStart={(e) => { pullStart.current = listRef.current?.scrollTop === 0 ? e.touches[0].clientY : null; }}
        onTouchMove={(e) => { if (pullStart.current != null) setPull(Math.max(0, Math.min(110, (e.touches[0].clientY - pullStart.current) / 2))); }}
        onTouchEnd={() => { if (pull > 70) { window.dispatchEvent(new Event('halcyon:sync')); load(false); } pullStart.current = null; setPull(0); }}>
        {pinned.length > 0 && <div className="list-group"><Pin size={12} /> Pinned · {pinned.length}</div>}
        {pinned.map((m) => <Row key={`p${m.id}`} m={m} selected={m.id === openId} checked={false} threaded={threaded}
          onClick={(e) => clickRow(e, m)} onContextMenu={(e) => rowMenu(e, m)} onCheck={() => {}} onAct={(a, extra) => (a === 'pin' ? togglePin(m) : act(a, extra, [m.id]))} dragIds={[m.id]} showAi={settings.ai.enabled} />)}
        {pinned.length > 0 && items.length > 0 && <div className="list-group">Everything else</div>}
        {items.map((m) => <Row key={m.id} m={m} selected={selected.has(m.id) || m.id === openId} checked={selected.has(m.id)} threaded={threaded}
          onClick={(e) => clickRow(e, m)} onContextMenu={(e) => rowMenu(e, m)} onCheck={() => toggleSel(m.id)} onAct={(a, extra) => (a === 'pin' ? togglePin(m) : act(a, extra, [m.id]))}
          dragIds={selected.has(m.id) ? [...selected] : [m.id]} showAi={settings.ai.enabled} />)}
        {activeQuery && aiResults && <div className="ai-results">
          <div className="nav-section" style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Sparkles size={13} /> Related by meaning (AI)
            {aiResults.status === 'loading' && <><Spinner size={12} /><span className="faint">searching…</span></>}</div>
          {aiResults.items.map((m) => <Row key={`ai${m.id}`} m={m} selected={m.id === openId} checked={false} threaded={false}
            onClick={(e) => clickRow(e, m)} onContextMenu={(e) => rowMenu(e, m)} onCheck={() => {}} onAct={(a, extra) => (a === 'pin' ? togglePin(m) : act(a, extra, [m.id]))} dragIds={[m.id]} showAi={settings.ai.enabled} />)}
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

// Swipe on touch screens (Settings → Mail): what a swipe to the right / left does.
const SWIPES = { archive: 'Archive', trash: 'Delete', read: 'Read / unread', flag: 'Flag', snooze: 'Snooze', none: 'Nothing' };
function swipeAct(kind, m, unread, onAct) {
  if (kind === 'archive' || kind === 'trash') onAct(kind);
  else if (kind === 'read') onAct(unread ? 'read' : 'unread');
  else if (kind === 'flag') onAct(m.isFlagged ? 'unflag' : 'flag');
  else if (kind === 'snooze') onAct('snooze', { until: snoozeOptions().find(([l]) => /Tomorrow morning/.test(l))?.[1] || Date.now() + 864e5 });
}

function Row({ m, selected, checked, threaded, onClick, onContextMenu, onCheck, onAct, dragIds, showAi }) {
  const unread = threaded ? m.threadUnread > 0 || !m.isRead : !m.isRead;
  const ai = m.ai;
  const expired = !!ai?.expired;
  const important = !expired && ai?.priority >= 70;
  const ui = store.get().settings?.ui || {};
  const right = ui.swipeRight || 'read', left = ui.swipeLeft || 'archive';
  const [dx, setDx] = useState(0);
  const touch = useRef(null);
  const swipe = {
    onTouchStart: (e) => { const t = e.touches[0]; touch.current = { x: t.clientX, y: t.clientY, h: null }; },
    onTouchMove: (e) => {
      const s = touch.current; if (!s) return;
      const t = e.touches[0], ddx = t.clientX - s.x, ddy = t.clientY - s.y;
      if (s.h === null && Math.abs(ddx) + Math.abs(ddy) > 10) s.h = Math.abs(ddx) > Math.abs(ddy) * 1.5;
      if (s.h && ((ddx > 0 && right !== 'none') || (ddx < 0 && left !== 'none'))) setDx(Math.max(-160, Math.min(160, ddx)));
    },
    onTouchEnd: () => {
      const d = dx; touch.current = null; setDx(0);
      if (d > 90) swipeAct(right, m, unread, onAct); else if (d < -90) swipeAct(left, m, unread, onAct);
    },
  };
  return (
    <div className={`swipe-wrap ${dx > 0 ? `go-right ${dx > 90 ? 'armed' : ''}` : dx < 0 ? `go-left ${dx < -90 ? 'armed' : ''}` : ''}`} data-right={SWIPES[right]} data-left={SWIPES[left]}>
    <div data-id={m.id} className={`msg-row ${unread ? 'unread' : 'read'} ${important ? 'important' : ''} ${expired ? 'expired' : ''} ${selected ? 'selected' : ''}`} onClick={(e) => { if (Math.abs(dx) > 5) return; onClick(e); }} onContextMenu={onContextMenu} draggable
      {...swipe} style={dx ? { transform: `translateX(${dx}px)`, transition: 'none' } : undefined}
      onDragStart={(e) => { e.dataTransfer.setData('application/x-halcyon', JSON.stringify({ ids: dragIds, threads: threaded })); e.dataTransfer.effectAllowed = 'copyMove'; }}>
      <div onClick={(e) => { e.stopPropagation(); onCheck(); }} style={{ cursor: 'pointer' }}>
        {checked ? <div className="avatar" style={{ background: 'var(--accent)' }}><CheckSquare size={18} /></div> : <Avatar name={m.from.name} email={m.from.address} />}
      </div>
      <div className="body">
        <div className="from">
          {important && <Flame size={13} className="imp-icon" title={`Important (priority ${ai.priority})`} />}
          {m.pinned && <Pin size={12} className="state-icon" title="Pinned" />}
          <span className="truncate">{m.folder?.specialUse === '\\Sent' ? `To: ${m.to.map((a) => a.name || a.address).join(', ')}` : m.from.name || m.from.address}
            {m.onBehalfOf && m.folder?.specialUse !== '\\Sent' && <span className="faint behalf-note"> · sent by {m.onBehalfOf.name || m.onBehalfOf.address}</span>}</span>
          {threaded && m.threadCount > 1 && <span className="faint small">{m.threadCount}</span>}
          <span className="row-states">
            {ai?.needsReply && !m.isAnswered && !expired && <CornerUpLeft size={13} className="st reply" title="Reply needed" />}
            {ai?.needsAction && !expired && <ClipboardCheck size={13} className="st action" title={ai.actionSummary ? `Action: ${ai.actionSummary}` : 'Action needed'} />}
            {m.hasDraft && <PenLine size={13} className="st draft" title="You have an unsent reply in this conversation" />}
            {m.hasNote && <StickyNote size={12} className="st" title="Your note" />}
            {m.hasInvite && <CalendarPlus size={13} className="st" title="Invitation" />}
            {m.hasAttachments && <Paperclip size={12} className="st" title="Attachment" />}
            {m.isFlagged && <Star size={12} className="flag-icon" fill="#f59e0b" />}
          </span>
          <span className="date">{m.snoozedUntil ? <span title="Snoozed until"><Clock size={11} /> {fmtListDate(m.snoozedUntil)}</span> : fmtListDate(m.date)}</span>
        </div>
        {/* Subject and a one-line preview (the AI summary when there is one) on one line. */}
        <div className="subject-line truncate">
          {m.isAnswered && <ReplyIcon size={13} className="state-icon" title="You replied" />}
          {m.isForwarded && <ForwardIcon size={13} className="state-icon" title="You forwarded this" />}
          <span className="subject">{m.subject || '(no subject)'}</span>
          <span className="preview" title={showAi && ai?.summary ? ai.summary : undefined}> — {showAi && ai?.summary ? ai.summary : m.snippet}</span></div>
        {(m.ownerName || ai?.isPhishing || expired || ai?.topic || m.myCategories?.length > 0 || m.notOnServer || m.labels?.length > 0) && <div className="meta">
          {m.ownerName && <span className="chip shared-chip" title={`Shared space “${m.ownerName}”`}>{m.ownerName}</span>}
          {ai?.isPhishing && <span className="chip" style={{ background: '#fee2e2', color: '#991b1b' }}><AlertTriangle size={11} /> Suspicious</span>}
          {expired && <span className="chip faint" title="Time-sensitive content that is no longer valid"><Hourglass size={11} /> expired</span>}
          {ai?.topic && <span className="chip topic clickable" title={`Show all mail about “${ai.topic}”`} onClick={(e) => { e.stopPropagation(); navigate(`#/mail/${topicView(ai.topic)}`); }}><Hash size={10} />{ai.topic}</span>}
          {(m.myCategories || []).map((id) => { const c = (store.get().folders.custom || []).find((x) => x.id === id); return c && <span key={id} className="chip clickable" style={{ color: c.color || 'var(--accent)' }} title={`Show “${c.name}”`} onClick={(e) => { e.stopPropagation(); navigate(`#/mail/my~${c.id}`); }}><Tag size={10} />{c.name}</span>; })}
          {m.notOnServer && <span className="chip unsaved" title="Sent, but the copy is not saved on the mail server yet (other mail apps do not show it)">Not on server</span>}
          {m.labels?.map((id) => { const l = store.get().labels.find((x) => x.id === id); return l && <span key={id} className="chip" style={{ background: l.color, color: '#fff' }}>{l.name}</span>; })}
        </div>}
      </div>
      <div className="hover-actions" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn" title="Archive (e)" onClick={() => onAct('archive')}><Archive size={15} /></button>
        <button className="icon-btn" title="Delete (#)" onClick={() => onAct('trash')}><Trash2 size={15} /></button>
        <button className="icon-btn" title={unread ? 'Mark read' : 'Mark unread'} onClick={() => onAct(unread ? 'read' : 'unread')}>{unread ? <MailOpen size={15} /> : <MailIcon size={15} />}</button>
        <button className="icon-btn" title="Flag (s)" onClick={() => onAct(m.isFlagged ? 'unflag' : 'flag')}><Star size={15} fill={m.isFlagged ? '#f59e0b' : 'none'} color={m.isFlagged ? '#f59e0b' : 'currentColor'} /></button>
        <button className="icon-btn" title="Snooze until tomorrow" onClick={() => onAct('snooze', { until: snoozeOptions().find((o) => o[0] === 'Tomorrow morning')[1] })}><Clock size={15} /></button>
        <button className="icon-btn" title={m.pinned ? 'Unpin' : 'Pin to top'} onClick={() => onAct('pin')}><Pin size={15} fill={m.pinned ? 'currentColor' : 'none'} /></button>
      </div>
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

const ACTION_LABELS = { trash: 'Delete', spam: 'Mark as spam', forward: 'Forward', move: 'Move', archive: 'Archive', markRead: 'Mark as read', flag: 'Flag', label: 'Label' };

/** Actions that AI-driven rules or connected assistants (MCP) proposed but may not run on their own. */
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
  const folderName = (id) => store.get().folders.accounts?.flatMap((x) => x.folders).find((f) => f.id === Number(id))?.name;
  const describe = (a) => `${ACTION_LABELS[a.action.type] || a.action.type}${a.action.type === 'forward' ? ` to ${a.action.to}` : ''}${a.action.type === 'move' ? ` to ${folderName(a.action.folderId) || 'another folder'}` : ''}`;
  const source = (a) => (a.ruleId ? `rule “${a.ruleName || 'Untitled'}”` : `assistant ${a.ruleName || ''}`);
  return <>
    <div className="notice warn"><Sparkles size={15} /><span className="grow">{items.length} action{items.length > 1 ? 's' : ''} from AI rules or assistants need{items.length > 1 ? '' : 's'} your approval</span>
      <button className="btn sm" onClick={() => setOpen(true)}>Review</button></div>
    {open && <Modal title="Approve actions proposed by AI" wide onClose={() => setOpen(false)}
      footer={<><button className="btn" onClick={() => decide(items.map((a) => a.id), false)}>Dismiss all</button><span className="grow" /><button className="btn" onClick={() => setOpen(false)}>Close</button></>}>
      <div className="small muted">AI rules and connected assistants never delete, move, mark as spam or forward mail by themselves — a crafted email could steer their judgement. Nothing below happens until you approve it.</div>
      {items.map((a) => (
        <div key={a.id} className="card item-card" style={{ alignItems: 'flex-start' }}>
          <div className="grow" style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600 }} className={a.action.type === 'forward' ? 'error-text' : ''}>{describe(a)}</div>
            <a href={`#/mail/unified/${a.messageId}`} onClick={() => setOpen(false)} className="truncate" style={{ display: 'block' }}>{a.message.subject || '(no subject)'}</a>
            <div className="small muted truncate">{a.message.from} · {source(a)}{a.message.category ? ` · AI: ${a.message.category}, priority ${a.message.priority}` : ''}</div>
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
const SEARCH_HELP = [['from:anna', 'sender'], ['to:', 'recipient'], ['cc:', ''], ['participants:', 'anyone on it'], ['subject:(budget plan)', ''], ['body:', 'text'],
  ['hasattachments:yes', ''], ['attachments:report.pdf', 'file name'], ['isread:no', ''], ['isflagged:yes', ''], ['received:today', '/ yesterday / "this week" / "last month" / 2026-01-15 / >=1.3.2026 / 2026-01-01..2026-02-01'],
  ['sent:', 'same as received'], ['importance:high', ''], ['folder:Projects', ''], ['category:', 'AI category'], ['is:needsreply', ''], ['is:action', '']];

function SearchFilters({ query, onChange }) {
  const folders = store.use((s) => s.folders);
  const tokens = query.match(/-?\w+:(\([^)]*\)|"[^"]*"|\S+)|"[^"]*"|\S+/g) || [];
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
      <details className="search-help small">
        <summary className="faint">Search keywords</summary>
        <div className="muted">As in Outlook: {SEARCH_HELP.map(([k, d]) => <span key={k}><code>{k}</code> {d}; </span>)}
          words in quotes match as a phrase, <code>NOT</code> or <code>-</code> excludes, <code>OR</code> finds either word.</div>
      </details>
    </div>
  );
}
