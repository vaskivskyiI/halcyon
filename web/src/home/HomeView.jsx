// Home of the suite: every app at a glance, and what today asks for. Works without AI: the lists come straight from the data.
import { useEffect, useState } from 'react';
import { Mail, Calendar, Users, CheckSquare, Sparkles, NotebookPen, Columns2 } from 'lucide-react';
import { api, onEvent } from '../api.js';
import { store } from '../store.js';
import { navigate } from '../util.js';
import { Spinner } from '../components/common.jsx';
import { embedUrl, openBeside } from '../components/SidePane.jsx';

const time = (e) => (e.allDay ? 'All day' : new Date(e.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };

export default function HomeView() {
  const user = store.use((s) => s.user);
  const unread = store.use((s) => s.folders.counts?.unified || 0);
  const reply = store.use((s) => s.folders.counts?.needsreply || 0);
  const action = store.use((s) => s.folders.counts?.needsaction || 0);
  const inkwell = store.use((s) => s.inkwell);
  const [live, setLive] = useState(null);
  useEffect(() => {
    const load = () => api.get('/api/ai/brief').then((r) => setLive(r.live || {})).catch(() => setLive({}));
    load();
    return onEvent((e) => { if (['tasks:changed', 'calendar:changed', 'mail:changed', 'mail:new'].includes(e.type)) load(); });
  }, []);
  const tiles = [
    ['Mail', Mail, '#/mail/unified', [unread && `${unread} unread`, reply && `${reply} to answer`, action && `${action} to do`].filter(Boolean).join(' · ') || 'Nothing waiting'],
    ['Calendar', Calendar, '#/calendar', live?.events ? `${live.events.length} today` : ''],
    ['Contacts', Users, '#/contacts', 'People and companies'],
    ['Tasks', CheckSquare, '#/tasks', live?.tasks ? `${live.tasks.length} open now` : ''],
    ...(inkwell ? [['Notes', NotebookPen, `${inkwell}/`, 'Inkwell']] : []),
    ['Assistant', Sparkles, '#/assistant', 'Ask about anything here'],
  ];
  const go = (href) => (href.startsWith('#') ? navigate(href) : location.assign(href));
  const beside = (label, href) => openBeside(label, href.startsWith('#') ? embedUrl(location.origin, href) : embedUrl(href.replace(/\/$/, '')));
  const mail = [...(live?.attention || []), ...(live?.awaiting || []), ...(live?.actions || [])].slice(0, 6);
  return (
    <div className="home">
      <h1>{greeting()}{user?.name ? `, ${user.name.split(' ')[0]}` : ''}</h1>
      <div className="home-tiles">
        {tiles.map(([label, Icon, href, note]) => (
          <div key={label} className="card home-tile" role="link" tabIndex={0} onClick={() => go(href)} onKeyDown={(e) => e.key === 'Enter' && go(href)}>
            <Icon size={22} /><b>{label}</b><span className="small muted">{note}</span>
            <button className="icon-btn desk-only" title={`Open ${label} beside this`} aria-label={`Open ${label} beside this`} onClick={(e) => { e.stopPropagation(); beside(label, href); }}><Columns2 size={15} /></button>
          </div>))}
      </div>
      {!live ? <div className="empty"><Spinner size={22} /></div> : <div className="home-lists">
        <section className="card"><h3>Today</h3>
          {(live.events || []).map((e, i) => <a key={i} className="home-row" href="#/calendar"><span className="faint">{time(e)}</span><span className="truncate">{e.title}</span></a>)}
          {!live.events?.length && <div className="small faint">Nothing in the calendar.</div>}</section>
        <section className="card"><h3>Mail that waits</h3>
          {mail.map((m) => <a key={m.id} className="home-row" href={`#/mail/unified/${m.id}`}><span className="truncate"><b>{m.from}</b> · {m.subject}</span></a>)}
          {!mail.length && <div className="small faint">All clear.</div>}</section>
        <section className="card"><h3>Tasks</h3>
          {(live.tasks || []).slice(0, 6).map((t) => <a key={`${t.owner || 0}:${t.id}`} className="home-row" href="#/tasks"><span className={`truncate ${t.overdue ? 'danger-text' : ''}`}>{t.title}</span></a>)}
          {!live.tasks?.length && <div className="small faint">No tasks due.</div>}</section>
      </div>}
    </div>
  );
}
