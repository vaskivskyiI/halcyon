// Home of the suite: what today holds, and every app one click away. Works without AI: the lists come straight from the data.
import { useEffect, useRef, useState } from 'react';
import { Mail, Calendar, Users, CheckSquare, Sparkles, NotebookPen, Columns2 } from 'lucide-react';
import { api, onEvent } from '../api.js';
import { store } from '../store.js';
import { navigate, fmtListDate } from '../util.js';
import { Avatar, Spinner } from '../components/common.jsx';
import { embedUrl, openBeside } from '../components/SidePane.jsx';

const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const greeting = () => { const h = new Date().getHours(); return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

let lastLive = null; // shown at once when coming back, then refreshed

function Panel({ title, to, children }) {
  return <section className="home-panel"><div className="home-panel-head"><h2>{title}</h2><a href={to}>Open</a></div>{children}</section>;
}

export default function HomeView() {
  const user = store.use((s) => s.user);
  const unread = store.use((s) => s.folders.counts?.unified || 0);
  const reply = store.use((s) => s.folders.counts?.needsreply || 0);
  const action = store.use((s) => s.folders.counts?.needsaction || 0);
  const inkwell = store.use((s) => s.inkwell);
  const [live, setLive] = useState(lastLive);
  const timer = useRef();
  useEffect(() => {
    const load = () => api.get('/api/ai/today').then((r) => { lastLive = r; setLive(r); }).catch(() => setLive((c) => c || {}));
    load();
    // Mail events come in bursts while syncing: one refresh after them.
    const off = onEvent((e) => { if (['tasks:changed', 'calendar:changed', 'mail:changed', 'mail:new'].includes(e.type)) { clearTimeout(timer.current); timer.current = setTimeout(load, 3000); } });
    return () => { off(); clearTimeout(timer.current); };
  }, []);
  const events = [...(live?.events || [])].sort((a, b) => !!b.allDay - !!a.allDay || a.start - b.start);
  const tasks = live?.tasks || [];
  const mail = (live?.attention || []).slice(0, 6);
  const apps = [
    ['mail', 'Mail', Mail, '#/mail/unified', unread],
    ['calendar', 'Calendar', Calendar, '#/calendar', events.length],
    ['contacts', 'Contacts', Users, '#/contacts', 0],
    ['tasks', 'Tasks', CheckSquare, '#/tasks', tasks.length],
    ...(inkwell ? [['notes', 'Notes', NotebookPen, `${inkwell}/`, 0]] : []),
    ['assistant', 'Assistant', Sparkles, '#/assistant', 0],
  ];
  const go = (href) => (href.startsWith('#') ? navigate(href) : location.assign(href));
  const beside = (label, href) => openBeside(label, href.startsWith('#') ? embedUrl(location.origin, href) : embedUrl(href.replace(/\/$/, '')));
  const status = [reply && `${plural(reply, 'email')} to answer`, action && plural(action, 'action'), live && (events.length ? `${plural(events.length, 'event')} today` : 'a free calendar')].filter(Boolean).join(' · ');
  return (
    <div className="home"><div className="home-inner">
      <header className="home-head">
        <div className="home-date">{new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</div>
        <h1>{greeting()}{user?.name ? `, ${user.name.split(' ')[0]}` : ''}</h1>
        {status && <p>{status}</p>}
      </header>
      <nav className="home-apps" aria-label="Apps">
        {apps.map(([id, label, Icon, href, n]) => (
          <div key={id} className={`home-app app-${id}`} role="link" tabIndex={0} onClick={() => go(href)} onKeyDown={(e) => e.key === 'Enter' && go(href)}>
            <span className="home-app-icon"><Icon size={18} /></span><span className="grow truncate">{label}</span>
            {n > 0 && <span className="home-app-n">{n > 999 ? '999+' : n}</span>}
            <button className="desk-only" title={`Open ${label} beside this`} aria-label={`Open ${label} beside this`} onClick={(e) => { e.stopPropagation(); beside(label, href); }}><Columns2 size={14} /></button>
          </div>))}
      </nav>
      {!live ? <div className="empty"><Spinner size={22} /></div> : <div className="home-grid">
        <div className="home-col">
          <Panel title="Today" to="#/calendar">
            {events.map((e, i) => (
              <a key={i} className="home-event" href="#/calendar"><span className="bar" style={{ background: e.color || 'var(--accent)' }} />
                <span className="when">{e.allDay ? 'All day' : clock(e.start)}</span><span className="grow truncate">{e.title}{e.location && <span className="faint"> · {e.location}</span>}</span></a>))}
            {!events.length && <div className="home-none">Nothing in the calendar.</div>}
          </Panel>
          <Panel title="Tasks" to="#/tasks">
            {tasks.slice(0, 6).map((t) => (
              <a key={`${t.owner || 0}:${t.id}`} className="home-task" href="#/tasks"><span className={`dot ${t.overdue ? 'late' : ''}`} /><span className="grow truncate">{t.title}</span>
                {t.due && <span className={`small ${t.overdue ? 'late' : 'faint'}`}>{fmtListDate(t.due)}</span>}</a>))}
            {!tasks.length && <div className="home-none">No tasks due.</div>}
          </Panel>
        </div>
        <Panel title="Important mail" to="#/mail/unified">
          {mail.map((m) => (
            <a key={m.id} className={`home-mail ${m.isRead ? '' : 'unread'}`} href={`#/mail/unified/${m.id}`}><Avatar name={m.from} />
              <span className="grow home-mail-text"><span className="row"><b className="grow truncate">{m.from}</b><span className="small faint">{fmtListDate(m.date)}</span></span>
                <span className="truncate">{m.subject}</span>{m.summary && <span className="small muted truncate">{m.summary}</span>}</span></a>))}
          {!mail.length && <div className="home-none">Nothing important is waiting.</div>}
        </Panel>
      </div>}
    </div></div>
  );
}
