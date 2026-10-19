import { useEffect, useState, useRef } from 'react';
import { Mail, Calendar, Users, CheckSquare, Sparkles, Settings, RefreshCw, Moon, Sun } from 'lucide-react';
import { api, connectEvents, onEvent } from './api.js';
import { store } from './store.js';
import { useRoute } from './router.js';
import { loadMe, loadFolders, loadAccounts, loadLabels, loadProviders, saveSettings } from './data.js';
import { Toasts } from './components/common.jsx';
import { toast, notifyDesktop, navigate, textToHtml } from './util.js';
import Login from './Login.jsx';
import MailView from './mail/MailView.jsx';
import ComposerDock from './mail/Composer.jsx';
import CalendarView from './calendar/CalendarView.jsx';
import ContactsView from './contacts/ContactsView.jsx';
import TasksView from './tasks/TasksView.jsx';
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
      if (st.user) {
        await loadMe();
        await Promise.all([loadFolders(), loadAccounts(), loadLabels(), loadProviders()]);
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
  const reloadTimer = useRef();

  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
    const reload = () => { clearTimeout(reloadTimer.current); reloadTimer.current = setTimeout(() => { loadFolders(); }, 300); };
    return onEvent((e) => {
      const s = store.get().settings;
      switch (e.type) {
        case 'connected': store.set({ connected: true }); reload(); break;
        case 'disconnected': store.set({ connected: false }); break;
        case 'mail:new':
          reload();
          if (s.notifications.newMail && !s.notifications.onlyImportant) for (const m of e.payload.messages) notifyDesktop(m.from, `${m.subject}\n${m.snippet || ''}`, () => navigate(`#/mail/unified/${m.id}`));
          break;
        case 'mail:important':
          if (s.notifications.newMail && s.notifications.onlyImportant) notifyDesktop(`Important: ${e.payload.from}`, `${e.payload.subject}\n${e.payload.summary || ''}`, () => navigate(`#/mail/unified/${e.payload.id}`));
          break;
        case 'reminder':
          notifyDesktop(e.payload.title, `${new Date(e.payload.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${e.payload.location ? ` · ${e.payload.location}` : ''}`, () => navigate('#/calendar'));
          toast(`Reminder: ${e.payload.title} at ${new Date(e.payload.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, { duration: 15000, action: e.payload.onlineMeeting ? { label: 'Join', onClick: () => window.open(e.payload.onlineMeeting, '_blank') } : undefined });
          break;
        case 'mail:sendError': toast(`Sending failed: ${e.payload.error}`, { kind: 'error', duration: 10000 }); reload(); break;
        case 'outbox:changed': case 'folders:changed': case 'folder:synced': case 'mail:changed': case 'mail:unsnoozed': reload(); break;
        case 'sync:state': if (['idle', 'error'].includes(e.payload.state)) loadAccounts(); reload(); break;
        default: break;
      }
    });
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
    if (accountsLoaded && !accounts.length && section === 'mail') navigate('#/settings/accounts');
  }, [accountsLoaded, accounts.length]);

  const nav = [
    ['mail', Mail, 'Mail', unread], ['calendar', Calendar, 'Calendar'], ['contacts', Users, 'Contacts'],
    ['tasks', CheckSquare, 'Tasks'], ['assistant', Sparkles, 'Assistant'],
  ];
  const dark = document.documentElement.dataset.theme === 'dark';
  return (
    <div className="app">
      <nav className="rail">
        <img className="logo" src="./icon.svg" alt="Halcyon" />
        {nav.map(([id, Icon, label, badge]) => (
          <button key={id} className={section === id ? 'active' : ''} title={label} aria-label={label} onClick={() => navigate(`#/${id}`)}>
            <Icon size={21} />{badge > 0 && <span className="badge">{badge > 99 ? '99+' : badge}</span>}
          </button>
        ))}
        <div className="spacer" />
        <button title="Sync now" aria-label="Sync now" onClick={() => api.post('/api/sync').then(() => toast('Syncing…'))}><RefreshCw size={19} /></button>
        <button title="Toggle theme" aria-label="Toggle theme" onClick={() => saveSettings({ ui: { theme: dark ? 'light' : 'dark' } })}>{dark ? <Sun size={19} /> : <Moon size={19} />}</button>
        <button className={section === 'settings' ? 'active' : ''} title="Settings" aria-label="Settings" onClick={() => navigate('#/settings')}><Settings size={21} /></button>
      </nav>
      <main className="main">
        {section === 'mail' && <MailView route={route} />}
        {section === 'calendar' && <CalendarView route={route} />}
        {section === 'contacts' && <ContactsView route={route} />}
        {section === 'tasks' && <TasksView />}
        {section === 'assistant' && <AssistantView route={route} />}
        {section === 'settings' && <SettingsView route={route} />}
      </main>
      <ComposerDock />
      <Toasts />
    </div>
  );
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
