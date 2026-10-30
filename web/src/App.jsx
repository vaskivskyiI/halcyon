import { useEffect, useState, useRef } from 'react';
import { Mail, Calendar, Users, CheckSquare, Sparkles, Settings, RefreshCw, Moon, Sun, SunMoon, Layers, Command, NotebookPen } from 'lucide-react';
import { api, connectEvents, onEvent, onOtherEvent, setApiActing, offlineState } from './api.js';
import './back.js';
import { pushIsOn } from './push.js';
import { loadQuickSteps } from './mail/extras.js';
import { store } from './store.js';
import { useRoute } from './router.js';
import { loadMe, loadFolders, loadAccounts, loadLabels, loadProviders, loadInkwell, saveSettings, loadSpaces, setSpace, loadShared, enterShared, setShowShared, applyMergedSpaces } from './data.js';
import { Toasts, useMenu, Spinner } from './components/common.jsx';
import { toast, notifyDesktop, navigate, textToHtml } from './util.js';
import Login from './Login.jsx';
import MailView from './mail/MailView.jsx';
import ComposerDock from './mail/Composer.jsx';
import CalendarView from './calendar/CalendarView.jsx';
import ContactsView from './contacts/ContactsView.jsx';
import TasksView from './tasks/TasksView.jsx';
import TaskDialog from './tasks/TaskDialog.jsx';
import Problems from './components/Problems.jsx';
import CommandPalette from './components/CommandPalette.jsx';
import { openComposer } from './mail/Composer.jsx';
import AssistantView from './assistant/AssistantView.jsx';
import SettingsView from './settings/SettingsView.jsx';

export default function App() {
  const [status, setStatus] = useState(null);
  const user = store.use((s) => s.user);

  const boot = async () => {
    try {
      const st = await api.get('/api/auth/status');
      setStatus(st);
      store.set({ readOnly: !!st.readOnly, acting: st.acting || null });
      setApiActing(st.acting?.id || null);
      if (st.user) {
        await loadMe();
        await loadSpaces().catch(() => {});
        await loadShared();
        applyMergedSpaces();
        loadQuickSteps();
        await Promise.all([loadFolders(), loadAccounts(), loadLabels(), loadProviders()]);
        loadInkwell();
        connectEvents();
      }
    } catch (e) { setStatus({ error: e.message }); }
  };
  useEffect(() => {
    boot();
    const unauth = () => store.set({ user: null });
    window.addEventListener('halcyon:unauthorized', unauth);
    return () => window.removeEventListener('halcyon:unauthorized', unauth);
  }, []);

  if (!status) return <div className="empty" style={{ height: '100%', justifyContent: 'center' }}>Loading…</div>;
  if (status.error) return <div className="empty" style={{ height: '100%', justifyContent: 'center' }}>Cannot reach the Halcyon server: {status.error}<button className="btn" onClick={boot}>Retry</button></div>;
  if (!user) return <Login needsSetup={status.needsSetup} allowSignup={status.allowSignup} onDone={boot} />;
  return <Shell />;
}

function Shell() {
  const route = useRoute();
  const section = route[0] || 'mail';
  const unread = store.use((s) => s.folders.counts?.unified || 0);
  const settings = store.use((s) => s.settings);
  const accounts = store.use((s) => s.accounts);
  const accountsLoaded = store.use((s) => s.accountsLoaded);
  const readOnly = store.use((s) => s.readOnly);
  const acting = store.use((s) => s.acting);
  const [offline, setOffline] = useState(offlineState);
  useEffect(() => { const h = (e) => setOffline(e.detail); window.addEventListener('halcyon:offline', h); return () => window.removeEventListener('halcyon:offline', h); }, []);
  const reloadTimer = useRef();
  const insightTimer = useRef();

  useEffect(() => {
    const reload = () => { clearTimeout(reloadTimer.current); reloadTimer.current = setTimeout(() => { loadFolders(); }, 300); };
    // Our own changes: refresh now, and once more after the server has applied follow-up work (sent copy, recounts).
    const mutated = () => { reload(); setTimeout(reload, 2500); };
    window.addEventListener('halcyon:mutated', mutated);
    const off = onEvent((e) => {
      const s = store.get().settings;
      switch (e.type) {
        case 'connected': store.set({ connected: true }); reload(); break;
        case 'disconnected': store.set({ connected: false }); break;
        case 'mail:new': reload(); break;
        // What notifies is decided on the server (Settings → Notifications); with push on this device the service
        // worker shows it, otherwise the open app does.
        case 'notify:show':
          pushIsOn().then((on) => { if (!on) notifyDesktop(e.payload.title, e.payload.body, () => (e.payload.as && e.payload.as !== store.get().acting?.id && !store.get().settings?.ui?.showShared ? enterShared(e.payload.as) : navigate(e.payload.url)), { silent: e.payload.silent, tag: e.payload.tag }); });
          break;
        case 'reminder':
          toast(`Reminder: ${e.payload.title} at ${new Date(e.payload.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, { duration: 15000, action: e.payload.onlineMeeting ? { label: 'Join', onClick: () => window.open(e.payload.onlineMeeting, '_blank') } : undefined });
          break;
        case 'mail:sendError': toast(`Sending failed: ${e.payload.error}`, { kind: 'error', duration: 10000 }); reload(); break;
        case 'outbox:changed': case 'folders:changed': case 'folder:synced': case 'mail:changed': case 'mail:unsnoozed': case 'mail:sent': reload(); break;
        // Background analysis can produce many of these: refresh the AI counts at most every few seconds.
        case 'ai:insight': if (!insightTimer.current) insightTimer.current = setTimeout(() => { insightTimer.current = null; reload(); }, 4000); break;
        case 'sync:state': if (['idle', 'error'].includes(e.payload.state)) { loadAccounts(); reload(); } break;
        case 'spaces:changed': loadSpaces().catch(() => {}); loadAccounts(); reload(); break;
        default: break;
      }
    });
    // The other mail (a shared space, or one's own while in a shared space): keep its unread count in the space
    // switcher current (its notifications come from the server, see notifications.js).
    let sharedTimer = null;
    const offOther = onOtherEvent((e) => {
      if (['mail:new', 'mail:changed', 'folder:synced'].includes(e.type) && !sharedTimer) sharedTimer = setTimeout(() => { sharedTimer = null; loadShared(); }, 3000);
    });
    const offShared = onEvent((e) => { if (e.type === 'shared:changed') loadShared(); });
    return () => { off(); offOther(); offShared(); clearTimeout(sharedTimer); window.removeEventListener('halcyon:mutated', mutated); };
  }, []);

  // Unread count in the title and (desktop) taskbar badge.
  useEffect(() => {
    document.title = unread ? `(${unread}) Halcyon` : 'Halcyon';
    if (window.halcyonDesktop?.setBadge) window.halcyonDesktop.setBadge(unread, unread ? badgeImage(unread) : null);
  }, [unread]);

  // #/compose?to=…&subject=…&body=…  or  #/compose?url=mailto:…  (mailto: handler for browser and desktop)
  useEffect(() => {
    if (!section.startsWith('compose')) return;
    const q = new URLSearchParams(location.hash.split('?')[1] || '');
    openComposer(q.get('url') ? parseMailto(q.get('url')) : { to: q.get('to') ? q.get('to').split(',') : [], subject: q.get('subject') || '', html: q.get('body') ? textToHtml(q.get('body')) : undefined });
    navigate('#/mail/unified');
  }, [section]);

  useEffect(() => {
    // No mail account yet: set one up — unless there is a shared space to work in.
    if (accountsLoaded && !accounts.length && section === 'mail' && !(store.get().shared || []).length) navigate('#/settings/accounts');
  }, [accountsLoaded, accounts.length]);

  const nav = [
    ['mail', Mail, 'Mail', unread], ['calendar', Calendar, 'Calendar'], ['contacts', Users, 'Contacts'],
    ['tasks', CheckSquare, 'Tasks'], ['assistant', Sparkles, 'Assistant'],
  ];
  const dark = document.documentElement.dataset.theme === 'dark';
  const theme = ['light', 'dark', 'system'].includes(settings?.ui?.theme) ? settings.ui.theme : 'system';
  const space = store.use((s) => s.space);
  const connected = store.use((s) => s.connected);
  const inkwell = store.use((s) => s.inkwell);
  const taskDialog = store.use((s) => s.taskDialog);
  const [syncing, setSyncing] = useState(false);

  // Without the live connection (e.g. a reverse proxy that does not pass WebSockets) the app would never hear about
  // new mail or finished AI analysis: refresh periodically instead.
  useEffect(() => {
    if (connected) return undefined;
    const t = setInterval(() => { loadFolders(); window.dispatchEvent(new Event('halcyon:poll')); }, 30e3);
    return () => clearInterval(t);
  }, [connected]);

  // Fresh data after showing the saved copy (service worker / desktop), back online, or back to the app after a while
  // (Android app, a tab that slept): everything shown is asked for again — at most once a second.
  useEffect(() => {
    let timer = null, hiddenAt = 0;
    const refresh = () => { clearTimeout(timer); timer = setTimeout(() => { loadFolders(); window.dispatchEvent(new Event('halcyon:poll')); window.dispatchEvent(new Event('halcyon:reload-open')); }, 300); };
    const vis = () => { if (document.hidden) hiddenAt = Date.now(); else if (hiddenAt && Date.now() - hiddenAt > 30e3) refresh(); };
    window.addEventListener('halcyon:refresh', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', vis);
    return () => { clearTimeout(timer); window.removeEventListener('halcyon:refresh', refresh); window.removeEventListener('online', refresh); document.removeEventListener('visibilitychange', vis); };
  }, []);

  // "Sync now": start a full sync of every account, wait until it has finished, then refresh and report.
  const syncNow = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      await api.post('/api/sync');
      const t0 = Date.now();
      let st = [];
      do {
        await new Promise((r) => setTimeout(r, 1500));
        st = await api.get('/api/accounts/status');
      } while (st.some((a) => a.syncEnabled && !['idle', 'error'].includes(a.state)) && Date.now() - t0 < 120e3);
      loadFolders(); loadAccounts();
      window.dispatchEvent(new Event('halcyon:poll'));
      const errs = st.filter((a) => a.syncEnabled && a.state === 'error');
      if (errs.length) toast(`Sync problem — ${errs.map((a) => `${a.email}: ${a.error}`).join('; ')}`, { kind: 'error', duration: 12000, action: { label: 'Details', onClick: () => navigate('#/settings/accounts') } });
      else toast('Mailboxes are up to date');
    } catch (e) { toast(e.message, { kind: 'error' }); } finally { setSyncing(false); }
  };
  useEffect(() => {
    const h = () => syncNow();
    window.addEventListener('halcyon:sync', h);
    return () => window.removeEventListener('halcyon:sync', h);
  });

  // Drag a message from the list onto Calendar (create an event from it) or Tasks (create tasks from it).
  const [dropNav, setDropNav] = useState(null);
  const dropProps = (id) => ({
    onDragOver: (e) => { if (e.dataTransfer.types.includes('application/x-halcyon')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDropNav(id); } },
    onDragLeave: () => setDropNav(null),
    onDrop: (e) => {
      e.preventDefault(); setDropNav(null);
      const data = JSON.parse(e.dataTransfer.getData('application/x-halcyon') || '{}');
      if (data.ids?.length) (id === 'calendar' ? eventFromMessage(data.ids[0]) : tasksFromMessages(data.ids));
    },
  });
  return (
    <div className="app">
      {(readOnly || acting || offline !== null) && <div className={`readonly-pill ${acting && !readOnly && offline === null ? 'shared' : ''}`} title={offline !== null ? 'Halcyon cannot reach your server: you see the copy saved on this device. Changes (sending, moving, marking) need the connection.' : readOnly ? 'This browser session cannot change anything: no sending, deleting, moving, marking or settings. Sign out and sign in normally to make changes.' : `You are working in the shared space “${acting.name}” — its mail, calendar, contacts and tasks are shared with its members.`}>
        {[offline !== null && 'Offline — saved copy', acting && `Shared: ${acting.name}`, readOnly && 'Read-only session'].filter(Boolean).join(' · ')}</div>}
      <CommandPalette />
      <nav className="rail">
        <img className="logo" src="./icon.svg" alt="Halcyon" />
        {nav.map(([id, Icon, label, badge]) => (
          <button key={id} className={`${section === id ? 'active' : ''} ${dropNav === id ? 'drop' : ''}`} title={DROP_HINT[id] ? `${label} — ${DROP_HINT[id]}` : label} aria-label={label} onClick={() => navigate(section === id ? `#/${id}` : lastRoute.get(id) || `#/${id}`)}
            {...(DROP_HINT[id] ? dropProps(id) : {})}>
            <Icon size={21} />{badge > 0 && <span className="badge">{badge > 99 ? '99+' : badge}</span>}
          </button>
        ))}
        {/* Inkwell, the notes app (Settings → Integrations): same tab, Ctrl/middle click a new one; the desktop app opens it in the browser. */}
        {inkwell && <button title="Notes (Inkwell)" aria-label="Notes (Inkwell)"
          onClick={(e) => (e.ctrlKey || e.metaKey ? window.open(`${inkwell}/`, '_blank', 'noopener') : location.assign(`${inkwell}/`))}
          onAuxClick={(e) => { if (e.button === 1) window.open(`${inkwell}/`, '_blank', 'noopener'); }}><NotebookPen size={20} /></button>}
        <button title="Go to, do, find — Ctrl+K" aria-label="Go to or do (Ctrl+K)" onClick={() => window.dispatchEvent(new Event('halcyon:palette'))}><Command size={19} /></button>
        <div className="spacer" />
        <Problems />
        <SpaceSwitcher />
        <button title={connected ? 'Sync now' : 'Sync now — live updates are not connected (refreshing every 30 s). If this persists, the reverse proxy probably does not pass WebSockets for /api/ws.'}
          aria-label="Sync now" onClick={syncNow} className={connected ? '' : 'offline'}>{syncing ? <Spinner size={18} /> : <RefreshCw size={19} />}{!connected && <span className="offline-dot" />}</button>
        {/* Light → dark → automatic (follows the device) → light … */}
        <button className="desk-only" title={`Theme: ${{ light: 'light', dark: 'dark', system: 'automatic (as the device)' }[theme]} — click for ${{ light: 'dark', dark: 'automatic', system: 'light' }[theme]}`} aria-label="Change theme"
          onClick={() => saveSettings({ ui: { theme: { light: 'dark', dark: 'system', system: 'light' }[theme] } })}>{theme === 'system' ? <SunMoon size={19} /> : dark ? <Moon size={19} /> : <Sun size={19} />}</button>
        <button className={section === 'settings' ? 'active' : ''} title="Settings" aria-label="Settings" onClick={() => navigate('#/settings')}><Settings size={21} /></button>
      </nav>
      {/* Remount views when the space changes so every list reloads in the new scope. */}
      <main className="main" key={space}>
        {section === 'mail' && <MailView route={route} />}
        {section === 'calendar' && <CalendarView route={route} />}
        {section === 'contacts' && <ContactsView route={route} />}
        {section === 'tasks' && <TasksView />}
        {section === 'assistant' && <AssistantView route={route} />}
        {section === 'settings' && <SettingsView route={route} />}
      </main>
      <ComposerDock />
      <Toasts />
      {taskDialog && <TaskDialog messageId={taskDialog} onClose={() => store.set({ taskDialog: null })} />}
    </div>
  );
}

/** Rail button for choosing the active space (only shown once spaces are defined). */
function SpaceSwitcher() {
  const spaces = store.use((s) => s.spaces);
  const space = store.use((s) => s.space);
  const shared = store.use((s) => s.shared) || [];
  const acting = store.use((s) => s.acting);
  const showShared = store.use((s) => s.settings?.ui?.showShared);
  const [openMenu, menuNode] = useMenu();
  if (!spaces.length && !shared.length) return null;
  // Unread shared mail not visible right now (when it is shown in My mail, it is counted there).
  const unread = shared.filter((s) => s.id !== acting?.id && !(showShared && !acting)).reduce((n, s) => n + (s.unread || 0), 0);
  const items = [
    ...(shared.length ? [{ section: 'Mail' }, { label: `My mail${!acting ? ' ✓' : ''}`, onClick: () => acting && enterShared(null) },
      ...shared.map((s) => ({ label: `${s.name} (shared)${acting?.id === s.id ? ' ✓' : ''}`, hint: s.unread && acting?.id !== s.id && !showShared ? `${s.unread} unread` : '', onClick: () => acting?.id !== s.id && enterShared(s.id) })),
      !acting && { label: `${showShared ? '✓ ' : ''}Show shared mail in My mail`, onClick: () => setShowShared(!showShared) }, 'sep'] : []),
    ...(spaces.length ? [{ section: 'Show' }, { label: `All spaces${!space ? ' ✓' : ''}`, onClick: () => setSpace('') },
      ...spaces.map((s) => ({ label: `${s}${space === s ? ' ✓' : ''}`, onClick: () => setSpace(s) })), 'sep'] : []),
    { label: 'Manage spaces…', icon: Settings, onClick: () => navigate('#/settings/spaces') },
    ...(shared.length || !acting ? [{ label: 'Sharing…', icon: Users, onClick: () => navigate('#/settings/sharing') }] : []),
  ];
  const label = acting ? acting.name : space;
  return <>
    <button className={`space-btn ${label ? 'active' : ''} ${acting ? 'shared' : ''}`} title={acting ? `Shared space: ${acting.name}` : space ? `Space: ${space}` : 'All spaces'} aria-label="Switch space" onClick={(e) => openMenu(e, items)}>
      {label ? <span className="space-initial">{label.slice(0, 2)}</span> : <Layers size={19} />}
      {unread > 0 && <span className="badge">{unread > 99 ? '99+' : unread}</span>}
    </button>
    {menuNode}
  </>;
}

// Where the user was in each section (open message, calendar view, settings page): going back restores it.
const lastRoute = new Map();
const remember = () => { const sec = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0]; if (sec && !sec.startsWith('compose')) lastRoute.set(sec, location.hash); };
window.addEventListener('hashchange', remember);
remember();

const DROP_HINT = { calendar: 'drop an email here to create an event', tasks: 'drop emails here to create tasks' };

async function eventFromMessage(messageId) {
  toast('Reading the date and time from the email…');
  let draft;
  try { draft = await api.post('/api/ai/extract-event', { messageId }); } catch { draft = null; }
  if (!draft?.start) {
    // No AI (or no date found): prefill from the message and let the user pick the time.
    const m = await api.get(`/api/messages/${messageId}`).catch(() => null);
    const start = new Date(); start.setMinutes(0, 0, 0); start.setHours(start.getHours() + 1);
    draft = { title: m?.subject || 'New event', start: start.getTime(), end: start.getTime() + 3600e3, allDay: false, description: m ? `From email: ${m.subject}` : '', sourceMessageId: messageId, attendees: [] };
  }
  store.set({ pendingEvent: draft });
  navigate('#/calendar');
}

async function tasksFromMessages(ids) {
  try {
    // One message: review the proposed tasks first; several: add them as proposed.
    if (ids.length === 1) { store.set({ taskDialog: ids[0] }); return; }
    let n = 0;
    for (const id of ids) n += (await api.post(`/api/tasks/from-message/${id}`, {})).length;
    toast(`${n} task${n === 1 ? '' : 's'} added`, { action: { label: 'View', onClick: () => navigate('#/tasks') } });
  } catch (e) { toast(e.message, { kind: 'error' }); }
}

export function parseMailto(url) {
  const u = String(url).replace(/^mailto:/i, '');
  const [addr, query = ''] = u.split('?');
  const q = new URLSearchParams(query);
  const list = (s) => (s ? decodeURIComponent(s).split(',').map((x) => x.trim()).filter(Boolean) : []);
  const body = q.get('body');
  return { to: [...list(addr), ...list(q.get('to'))], cc: list(q.get('cc')), bcc: list(q.get('bcc')), subject: q.get('subject') || '', html: body ? textToHtml(body) : undefined };
}

function badgeImage(n) {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#dc2626'; g.beginPath(); g.arc(16, 16, 16, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fff'; g.font = `bold ${n > 99 ? 13 : n > 9 ? 17 : 20}px Segoe UI, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(n > 99 ? '99+' : String(n), 16, 17);
  return c.toDataURL();
}
