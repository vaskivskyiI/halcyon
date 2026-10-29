import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search, Inbox, CornerUpLeft, ClipboardCheck, Star, Clock, Send, Flame, Hourglass, Calendar, CheckSquare, Users, Sparkles, Settings, PenSquare,
  Folder, Layers, RefreshCw, Mail, CalendarPlus, User, ArrowRight,
} from 'lucide-react';
import { api } from '../api.js';
import { store } from '../store.js';
import { navigate } from '../util.js';
import { setSpace } from '../data.js';
import { openComposer } from '../mail/Composer.jsx';

// Ctrl+K (⌘K): one box to go anywhere and do anything — views, folders, settings, spaces, new message / event / task,
// mail found by what is typed, people to write to, a question for the assistant. Arrow keys + Enter, or click.
const SETTINGS = [['accounts', 'Accounts'], ['spaces', 'Spaces'], ['calendars', 'Calendars & tasks'], ['ai', 'AI & assistant'], ['mail', 'Mail'], ['notifications', 'Notifications'],
  ['calendar', 'Calendar'], ['rules', 'Rules'], ['archives', 'Archives'], ['appearance', 'Appearance'], ['security', 'Security'], ['diagnostics', 'Diagnostics']];
const VIEWS = [['unified', Inbox, 'All inboxes'], ['needsreply', CornerUpLeft, 'Needs reply'], ['needsaction', ClipboardCheck, 'Action needed'], ['flagged', Star, 'Flagged'],
  ['snoozed', Clock, 'Snoozed'], ['scheduled', Send, 'Outbox & drafts'], ['important', Flame, 'Important'], ['waiting', Hourglass, 'Waiting for reply']];

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
/** All words typed appear in the text (in any order). */
const matches = (text, q) => { const t = norm(text); return norm(q).split(/\s+/).filter(Boolean).every((w) => t.includes(w)); };

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [found, setFound] = useState({ mail: [], people: [] });
  const input = useRef();
  const listRef = useRef();

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); }
      else if (e.key === 'Escape') setOpen(false);
    };
    const show = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('halcyon:palette', show);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('halcyon:palette', show); };
  }, []);
  useEffect(() => { if (open) { setQ(''); setSel(0); setFound({ mail: [], people: [] }); setTimeout(() => input.current?.focus(), 0); } }, [open]);

  // Mail and people for what is typed (after a short pause; keyword search only — instant).
  useEffect(() => {
    const text = q.trim();
    if (!open || text.length < 2) { setFound({ mail: [], people: [] }); return undefined; }
    const t = setTimeout(async () => {
      const [mail, people] = await Promise.all([
        api.get(`/api/messages?q=${encodeURIComponent(text)}&semantic=0&limit=6`).then((r) => r.items.slice(0, 6)).catch(() => []),
        api.get(`/api/contacts/autocomplete?q=${encodeURIComponent(text)}`).then((r) => r.slice(0, 3)).catch(() => []),
      ]);
      setFound({ mail, people });
    }, 180);
    return () => clearTimeout(t);
  }, [q, open]);

  const close = () => setOpen(false);
  const go = (hash) => { navigate(hash); close(); };
  const items = useMemo(() => {
    if (!open) return [];
    const st = store.get();
    const text = q.trim();
    const cmds = [
      { group: 'Do', icon: PenSquare, label: 'New message', run: () => { openComposer({}); close(); } },
      { group: 'Do', icon: CalendarPlus, label: 'New event', run: () => { go('#/calendar'); setTimeout(() => window.dispatchEvent(new Event('halcyon:new-event')), 300); } },
      { group: 'Do', icon: CheckSquare, label: 'New task', run: () => go('#/tasks') },
      { group: 'Do', icon: RefreshCw, label: 'Check for new mail now', run: () => { window.dispatchEvent(new Event('halcyon:refresh')); close(); } },
      ...VIEWS.map(([v, icon, label]) => ({ group: 'Go to', icon, label, run: () => go(`#/mail/${v}`) })),
      { group: 'Go to', icon: Calendar, label: 'Calendar', run: () => go('#/calendar') },
      { group: 'Go to', icon: CheckSquare, label: 'Tasks', run: () => go('#/tasks') },
      { group: 'Go to', icon: Users, label: 'Contacts', run: () => go('#/contacts') },
      { group: 'Go to', icon: Sparkles, label: 'Assistant · daily brief', run: () => go('#/assistant') },
      ...(st.folders?.accounts || []).flatMap((a) => a.folders.map((f) => ({ group: 'Folders', icon: Folder, label: f.name, hint: a.kind === 'archive' ? a.name : a.email, run: () => go(`#/mail/f${f.id}`) }))),
      ...['', ...(st.spaces || []).map((s) => (typeof s === 'string' ? s : s.name))].filter((s, i, all) => all.indexOf(s) === i).map((s) => ({
        group: 'Spaces', icon: Layers, label: s ? `Switch to space “${s}”` : 'All spaces', hint: st.space === s ? 'current' : '', run: () => { setSpace(s); close(); } })),
      ...SETTINGS.map(([id, label]) => ({ group: 'Settings', icon: Settings, label: `Settings · ${label}`, run: () => go(`#/settings/${id}`) })),
    ];
    const list = text ? cmds.filter((c) => matches(`${c.label} ${c.hint || ''}`, text)).slice(0, 12) : cmds.filter((c) => c.group === 'Do' || c.group === 'Go to');
    if (text) {
      list.push(...found.people.map((p) => ({ group: 'People', icon: User, label: `Write to ${p.name || p.address}`, hint: p.name ? p.address : '', run: () => { openComposer({ to: [{ name: p.name || '', address: p.address }] }); close(); } })));
      list.push(...found.mail.map((m) => ({ group: 'Mail', icon: Mail, label: m.subject || '(no subject)', hint: `${m.from.name || m.from.address} · ${new Date(m.date).toLocaleDateString()}`, run: () => go(`#/mail/unified/${m.id}`) })));
      list.push({ group: 'Search', icon: Search, label: `Search mail for “${text}”`, run: () => { go('#/mail/unified'); setTimeout(() => window.dispatchEvent(new CustomEvent('halcyon:search', { detail: { q: text } })), 150); } });
      if (st.settings?.ai?.enabled) list.push({ group: 'Search', icon: Sparkles, label: `Ask the assistant: “${text}”`, run: () => { try { sessionStorage.setItem('halcyon.ask', text); } catch { /* private mode */ } go('#/assistant/chat'); } });
    }
    return list;
  }, [open, q, found]);
  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => { listRef.current?.querySelector('.palette-item.sel')?.scrollIntoView({ block: 'nearest' }); }, [sel]);

  if (!open) return null;
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); items[sel]?.run(); }
  };
  let last = null;
  return (
    <div className="palette-backdrop" onMouseDown={close}>
      <div className="palette" role="dialog" aria-label="Go to or do" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input"><Search size={16} />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown} placeholder="Go to, do, find mail or people, ask…" aria-label="Command" />
          <kbd>Esc</kbd></div>
        <div className="palette-list" ref={listRef}>
          {items.map((it, i) => {
            const head = it.group !== last ? <div key={`g${i}`} className="palette-group">{it.group}</div> : null;
            last = it.group;
            return [head, (
              <div key={i} className={`palette-item ${i === sel ? 'sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => it.run()}>
                <it.icon size={15} /><span className="grow truncate">{it.label}</span>{it.hint && <span className="faint small truncate" style={{ maxWidth: '45%' }}>{it.hint}</span>}
                {i === sel && <ArrowRight size={13} className="faint" />}
              </div>)];
          })}
          {!items.length && <div className="faint small" style={{ padding: 12 }}>Nothing found.</div>}
        </div>
      </div>
    </div>);
}
