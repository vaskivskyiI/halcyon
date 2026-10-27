import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { ChevronLeft, ChevronRight, Plus, MapPin, Video, Users, Repeat, Bell, Trash2, Download, Upload, RefreshCw, Link2, Clock, Sparkles, Lock, AlertTriangle, Check, Info, CalendarPlus } from 'lucide-react';
import { api, onEvent, stream } from '../api.js';
import { store } from '../store.js';
import { Modal, useMenu, Spinner, Markdown } from '../components/common.jsx';
import { toast, toastError, startOfDay, addDays, startOfWeek, toLocalInput, toDateInput, fmtTime, navigate } from '../util.js';

const HOUR_PX = 48;
// How a calendar's events count (also chosen when a calendar is added).
const SHOW_AS = [
  ['busy', 'Busy', 'blocks time'],
  ['free', 'Free', 'shown, never blocks time'],
  ['info', 'Just for information', 'faint, no reminders'],
];
const VIEWS = [['day', 'Day'], ['workweek', 'Work week'], ['week', 'Week'], ['month', 'Month'], ['agenda', 'Agenda']];

function rangeFor(view, date, weekStart) {
  if (view === 'day') return [startOfDay(date), addDays(startOfDay(date), 1)];
  if (view === 'week') { const s = startOfWeek(date, weekStart); return [s, addDays(s, 7)]; }
  if (view === 'workweek') { const s = startOfWeek(date, 1); return [s, addDays(s, 5)]; }
  if (view === 'agenda') return [startOfDay(date), addDays(startOfDay(date), 30)];
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const s = startOfWeek(first, weekStart);
  return [s, addDays(s, 42)];
}

let shownDate = Date.now();
/** Opens the calendar on a given day next time it is shown (e.g. "Show" after accepting an invitation). */
export const showCalendarDate = (t) => { shownDate = t; };

export default function CalendarView() {
  const settings = store.use((s) => s.settings);
  const weekStart = settings.ui.weekStart ?? 1;
  const [view, setView] = useState(() => localStorage.getItem('cal.view') || (innerWidth < 860 ? 'agenda' : 'week'));
  // The shown date survives switching to Mail and back (module state, per page load).
  const [date, setDateState] = useState(() => new Date(shownDate));
  const setDate = (d) => { shownDate = new Date(typeof d === 'function' ? d(new Date(shownDate)) : d).getTime(); setDateState(new Date(shownDate)); };
  const [events, setEvents] = useState([]);
  const [calendars, setCalendars] = useState([]);
  const [editing, setEditing] = useState(null);
  // An event prepared from an email dropped on the Calendar icon: open it for review (nothing is saved yet).
  const pendingEvent = store.use((s) => s.pendingEvent);
  useEffect(() => { if (pendingEvent) { setEditing(pendingEvent); store.set({ pendingEvent: null }); } }, [pendingEvent]);
  const [scopeAsk, setScopeAsk] = useState(null);
  const [newCal, setNewCal] = useState(false);
  const [from, to] = rangeFor(view, date, weekStart);

  const loadCals = () => api.get('/api/calendars').then(setCalendars).catch(toastError);
  const load = useCallback(() => api.get(`/api/events?from=${from.getTime()}&to=${to.getTime()}`).then(setEvents).catch(toastError), [from.getTime(), to.getTime()]);
  useEffect(() => { loadCals(); }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => onEvent((e) => e.type === 'calendar:changed' && (load(), loadCals())), [load]);
  useEffect(() => localStorage.setItem('cal.view', view), [view]);

  const step = (dir) => {
    const d = new Date(date);
    if (view === 'month') d.setMonth(d.getMonth() + dir);
    else if (view === 'day') d.setDate(d.getDate() + dir);
    else if (view === 'agenda') d.setDate(d.getDate() + dir * 30);
    else d.setDate(d.getDate() + dir * 7);
    setDate(d);
  };

  const title = view === 'month' ? date.toLocaleDateString([], { month: 'long', year: 'numeric' })
    : view === 'day' ? date.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      : `${from.toLocaleDateString([], { day: 'numeric', month: 'short' })} – ${addDays(to, -1).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}`;

  const newEvent = (start, allDay = false) => {
    const s = start || (() => { const d = new Date(); d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0); return d.getTime(); })();
    setEditing({ start: s, end: allDay ? s + 864e5 : s + (settings.calendar.defaultDurationMin || 30) * 60e3, allDay, reminders: [settings.calendar.defaultReminderMin ?? 15] });
  };

  // Time blocked in another space has no details here; everything else opens.
  const openEvent = (ev) => (ev.blocked ? toast(`${ev.title} — the details are only shown in that space`) : setEditing(ev));

  // Right-click on an event: move it to another (writable) calendar — the whole series for a recurring event.
  const [openEvMenu, evMenuNode] = useMenu();
  const eventMenu = (e, ev) => {
    if (ev.readonly || ev.blocked) return;
    e.preventDefault();
    openEvMenu(e, [
      { label: 'Open', icon: Clock, onClick: () => setEditing(ev) },
      { section: 'Move to calendar' },
      ...calendars.filter((c) => !c.readonly && c.id !== ev.calendarId).map((c) => ({
        label: c.name, hint: c.space || undefined,
        onClick: async () => {
          try { await api.patch(`/api/events/${ev.seriesId || ev.id}`, { calendarId: c.id }); toast(`Moved to “${c.name}”${ev.rrule ? ' (the whole series)' : ''}`); load(); } catch (err) { toastError(err); }
        },
      })),
    ]);
  };

  const moveEvent = async (ev, start, end) => {
    const doIt = async (scope) => {
      try {
        await api.patch(`/api/events/${ev.id}`, { start, end, scope, occurrence: ev.occurrence || undefined });
        load();
      } catch (e) { toastError(e); load(); }
    };
    setEvents((cur) => cur.map((x) => (x.instanceId === ev.instanceId ? { ...x, start, end } : x)));
    if (ev.rrule && ev.occurrence) setScopeAsk({ onPick: doIt, onCancel: load }); else doIt();
  };

  // Scrolling moves through time: the wheel in month view; a sideways swipe or Shift+wheel in every view (the wheel
  // itself scrolls the hours in day/week view and the list in agenda view). Throttled so one gesture moves one step.
  const wheel = useRef({ acc: 0, t: 0 });
  const onWheel = (e) => {
    if (e.ctrlKey || e.target.closest('.modal, input, select, textarea')) return;
    const sideways = Math.abs(e.deltaX) > Math.abs(e.deltaY);
    const d = sideways ? e.deltaX : e.shiftKey || view === 'month' ? e.deltaY : 0;
    if (!d) return;
    const w = wheel.current;
    if (Date.now() - w.t < 450) return;
    w.acc += d;
    if (Math.abs(w.acc) < 60) return;
    step(w.acc > 0 ? 1 : -1);
    w.acc = 0; w.t = Date.now();
  };

  const visibleCals = calendars.filter((c) => c.enabled);
  // Calendars shown "just for information" can be hidden with one click (per device) and shown when needed.
  const [hideInfo, setHideInfo] = useState(() => { try { return localStorage.getItem('cal.hideInfo') === '1'; } catch { return false; } });
  const toggleInfo = () => { const v = !hideInfo; setHideInfo(v); try { localStorage.setItem('cal.hideInfo', v ? '1' : '0'); } catch { /* private mode */ } };
  const hasInfo = calendars.some((c) => c.enabled && c.showAs === 'info');
  const shown = hideInfo ? events.filter((e) => e.showAs !== 'info') : events;
  return (
    <div className="main">
      <aside className="sidebar cal-side">
        <div className="sidebar-head"><button className="btn primary grow" style={{ justifyContent: 'center', height: 38 }} onClick={() => newEvent()}><Plus size={16} /> New event</button></div>
        <MiniMonth date={date} onPick={(d) => { setDate(d); if (view === 'month') setView('day'); }} weekStart={weekStart} />
        <div className="sidebar-scroll">
          <div className="nav-section" style={{ cursor: 'default' }}><span className="grow">Calendars</span><button className="icon-btn" style={{ width: 22, height: 22 }} title="Add calendar" onClick={() => setNewCal(true)}><Plus size={13} /></button></div>
          {calendars.map((c) => <CalendarItem key={c.id} c={c} reload={() => { loadCals(); load(); }} />)}
          {hasInfo && <label className="row small muted" style={{ padding: '6px 10px' }} title="Calendars set to “Just for information”">
            <input type="checkbox" checked={!hideInfo} onChange={toggleInfo} /> Show informational events</label>}
        </div>
      </aside>
      <section className="cal" onWheel={onWheel}>
        <div className="cal-head">
          <button className="btn" onClick={() => setDate(new Date())}>Today</button>
          <button className="icon-btn" onClick={() => step(-1)} aria-label="Previous"><ChevronLeft size={18} /></button>
          <button className="icon-btn" onClick={() => step(1)} aria-label="Next"><ChevronRight size={18} /></button>
          <h2 className="truncate">{title}</h2>
          <span className="grow" />
          <button className="icon-btn mobile-only" onClick={() => newEvent()}><Plus size={18} /></button>
          <select className="input" style={{ width: 'auto' }} value={view} onChange={(e) => setView(e.target.value)}>{VIEWS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </div>
        {view === 'month' && <MonthView onMenu={eventMenu} from={from} date={date} events={shown} onNew={(d) => newEvent(d.getTime() + 9 * 3600e3)} onOpen={openEvent} onDay={(d) => { setDate(d); setView('day'); }} />}
        {['week', 'workweek', 'day'].includes(view) && <TimeGrid onMenu={eventMenu} from={from} days={Math.round((to - from) / 864e5)} events={shown} settings={settings} onNew={newEvent} onOpen={openEvent} onMove={moveEvent} />}
        {evMenuNode}
        {view === 'agenda' && <Agenda events={shown} onOpen={openEvent} onMenu={eventMenu} />}
      </section>
      {editing && <EventEditor initial={editing} calendars={calendars} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {scopeAsk && <ScopeModal title="Change recurring event" onClose={() => { scopeAsk.onCancel?.(); setScopeAsk(null); }} onPick={(s) => { scopeAsk.onPick(s); setScopeAsk(null); }} />}
      {newCal && <NewCalendarModal onClose={() => setNewCal(false)} onDone={() => { setNewCal(false); loadCals(); load(); }} />}
    </div>
  );
}

function CalendarItem({ c, reload }) {
  const [openMenu, menuNode] = useMenu();
  const fileRef = useRef();
  return (
    <div className="nav-item" onContextMenu={(e) => openMenu(e, [
      { label: 'Set as default', onClick: () => api.patch(`/api/calendars/${c.id}`, { isDefault: true }).then(reload) },
      { label: 'Change color', onClick: () => { const col = prompt('Color (hex)', c.color); if (col) api.patch(`/api/calendars/${c.id}`, { color: col }).then(reload); } },
      { label: 'Rename', onClick: () => { const n = prompt('Name', c.name); if (n) api.patch(`/api/calendars/${c.id}`, { name: n }).then(reload); } },
      { section: 'Show events as' },
      ...SHOW_AS.map(([v, label, hint]) => ({ label, hint, icon: (c.showAs || 'busy') === v ? Check : undefined, onClick: () => api.patch(`/api/calendars/${c.id}`, { showAs: v }).then(reload) })),
      'sep',
      { label: 'Export .ics', icon: Download, onClick: () => window.open(api.url(`/api/calendars/${c.id}/export.ics`)) },
      !c.readonly && { label: 'Import .ics', icon: Upload, onClick: () => fileRef.current.click() },
      c.source !== 'local' && { label: 'Refresh', icon: RefreshCw, onClick: () => api.post(`/api/calendars/${c.id}/refresh`).then(reload) },
      c.sourceId ? { label: 'Remove this CalDAV server (all its calendars)', icon: Trash2, danger: true, onClick: () => confirm('Remove all calendars from this server from Halcyon? Nothing on that server is changed.') && api.del(`/api/calendar-sources/${c.sourceId}`).then(reload) }
        : !c.isDefault && { label: 'Remove calendar', icon: Trash2, danger: true, onClick: () => confirm(c.readonly ? `Unsubscribe from ${c.name}?` : `Remove ${c.name}?`) && api.del(`/api/calendars/${c.id}`).then(reload) },
    ])}>
      <input type="checkbox" checked={c.enabled} style={{ accentColor: c.color }} onChange={(e) => api.patch(`/api/calendars/${c.id}`, { enabled: e.target.checked }).then(reload)} />
      <span className="truncate grow" title={c.readonly ? `${c.name} — read-only${c.lastSyncAt ? `, refreshed ${new Date(c.lastSyncAt).toLocaleString()}` : ''}` : c.name}>{c.name}</span>
      {c.syncError && <AlertTriangle size={13} color="var(--warning)" title={`Could not refresh: ${c.syncError}`} />}
      {c.showAs === 'free' && <span className="faint small" title="Events are shown but do not make you busy">free</span>}
      {c.showAs === 'info' && <Info size={12} className="faint" title="Just for information: shown faintly, never busy, no reminders" />}
      {c.readonly && <Lock size={12} className="faint" title="Read-only" />}
      {c.isDefault && <span className="faint small">default</span>}
      <input ref={fileRef} type="file" accept=".ics,text/calendar" hidden onChange={async (e) => {
        const f = e.target.files[0]; if (!f) return;
        try { const r = await api.post(`/api/calendars/${c.id}/import`, { ics: await f.text() }); toast(`Imported ${r.imported} events`); reload(); } catch (err) { toastError(err); }
        e.target.value = '';
      }} />
      {menuNode}
    </div>
  );
}

// Add a calendar: a new one here, a read-only subscription to a link (.ics / webcal — Google, Outlook, holidays), or
// read-only calendars from a CalDAV server that is not one of the mail accounts (Nextcloud, iCloud, Fastmail, ...).
function NewCalendarModal({ onClose, onDone }) {
  const [kind, setKind] = useState('local');
  const [f, setF] = useState({ name: '', color: '#10b981', url: '', username: '', password: '', showAs: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    setBusy(true);
    try {
      if (kind === 'caldav') {
        const r = await api.post('/api/calendar-sources', { url: f.url.trim(), username: f.username || undefined, password: f.password || undefined, name: f.name || undefined, showAs: f.showAs || 'busy' });
        toast(`Added ${r.calendars} calendar${r.calendars === 1 ? '' : 's'} from ${r.name} (read-only)`);
      } else {
        await api.post('/api/calendars', { name: f.name || (kind === 'link' ? 'Subscribed calendar' : 'Calendar'), color: f.color, url: kind === 'link' ? f.url.trim() : undefined,
          showAs: f.showAs || (kind === 'link' ? 'free' : 'busy') });
      }
      onDone();
    } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const ready = kind === 'local' || /^(https?|webcal):\/\//i.test(f.url.trim());
  return <Modal title="Add calendar" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !ready} onClick={save}>{busy ? <Spinner size={14} /> : null} {kind === 'local' ? 'Add' : 'Connect'}</button></>}>
    <div className="tabs" style={{ marginBottom: 12 }}>
      {[['local', 'New calendar'], ['link', 'Subscribe to a link'], ['caldav', 'CalDAV server']].map(([k, l]) => <button key={k} className={`tab ${kind === k ? 'active' : ''}`} onClick={() => setKind(k)}>{l}</button>)}
    </div>
    {kind === 'link' && <>
      <label className="field">Calendar address (iCal / .ics / webcal)<input className="input" placeholder="https://… or webcal://…" value={f.url} onChange={set('url')} autoFocus /></label>
      <div className="small muted" style={{ marginBottom: 8 }}>
        Read-only, refreshed every 30 minutes.<br />
        <b>Google Calendar:</b> calendar settings → “Integrate calendar” → “Secret address in iCal format”.<br />
        <b>Outlook / Microsoft 365:</b> Settings → Calendar → Shared calendars → “Publish a calendar” → ICS link.<br />
        <b>iCloud:</b> share the calendar as “Public Calendar” and copy the link.
      </div>
    </>}
    {kind === 'caldav' && <>
      <label className="field">CalDAV address<input className="input" placeholder="https://cloud.example.com/remote.php/dav" value={f.url} onChange={set('url')} autoFocus /></label>
      <div className="form-grid">
        <label className="field">User name<input className="input" value={f.username} onChange={set('username')} autoComplete="off" /></label>
        <label className="field">Password / app password<input className="input" type="password" value={f.password} onChange={set('password')} autoComplete="new-password" /></label>
      </div>
      <div className="small muted" style={{ marginBottom: 8 }}>
        All calendars found there are added <b>read-only</b> (nothing on that server is ever changed) and refreshed every 30 minutes.
        Nextcloud: https://your-server/remote.php/dav · iCloud: https://caldav.icloud.com (with an app-specific password) · Fastmail: https://caldav.fastmail.com.
        For a calendar you want to edit, add its CalDAV address to the mail account in Settings → Accounts instead.
      </div>
    </>}
    <label className="field">Name{kind === 'caldav' ? ' (optional)' : ''}<input className="input" value={f.name} onChange={set('name')} autoFocus={kind === 'local'} /></label>
    {kind !== 'caldav' && <label className="field">Color<input type="color" value={f.color} onChange={set('color')} /></label>}
    <label className="field">Show its events as
      <select className="input" value={f.showAs || (kind === 'link' ? 'free' : 'busy')} onChange={set('showAs')}>
        {SHOW_AS.map(([v, label, hint]) => <option key={v} value={v}>{label} — {hint}</option>)}
      </select></label>
  </Modal>;
}

function MiniMonth({ date, onPick, weekStart }) {
  const [cursor, setCursor] = useState(new Date(date.getFullYear(), date.getMonth(), 1));
  useEffect(() => setCursor(new Date(date.getFullYear(), date.getMonth(), 1)), [date.getMonth(), date.getFullYear()]);
  const start = startOfWeek(cursor, weekStart);
  const today = startOfDay(new Date()).getTime();
  const sel = startOfDay(date).getTime();
  const dow = [...Array(7)].map((_, i) => addDays(start, i).toLocaleDateString([], { weekday: 'narrow' }));
  return (
    <div className="mini-cal">
      <div className="row" style={{ marginBottom: 4 }}>
        <b className="grow small">{cursor.toLocaleDateString([], { month: 'long', year: 'numeric' })}</b>
        <button className="icon-btn" style={{ width: 24, height: 24 }} onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}><ChevronLeft size={14} /></button>
        <button className="icon-btn" style={{ width: 24, height: 24 }} onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}><ChevronRight size={14} /></button>
      </div>
      <div className="grid">
        {dow.map((d, i) => <b key={i} className="faint" style={{ fontSize: 11 }}>{d}</b>)}
        {[...Array(42)].map((_, i) => { const d = addDays(start, i); const t = d.getTime(); return <span key={i} className={`${d.getMonth() !== cursor.getMonth() ? 'other' : ''} ${t === today ? 'today' : ''} ${t === sel ? 'sel' : ''}`} onClick={() => onPick(d)}>{d.getDate()}</span>; })}
      </div>
    </div>
  );
}

function MonthView({ from, date, events, onNew, onOpen, onDay, onMenu }) {
  const today = startOfDay(new Date()).getTime();
  const days = [...Array(42)].map((_, i) => addDays(from, i));
  return (
    <>
      <div className="month-dow">{days.slice(0, 7).map((d, i) => <div key={i}>{d.toLocaleDateString([], { weekday: 'short' })}</div>)}</div>
      <div className="month-grid">
        {days.map((d, i) => {
          const s = d.getTime(), e = s + 864e5;
          const evs = events.filter((x) => x.start < e && (x.end > s || x.start >= s));
          return (
            <div key={i} className={`month-cell ${d.getMonth() !== date.getMonth() ? 'other' : ''} ${s === today ? 'today' : ''}`} onDoubleClick={() => onNew(d)}>
              <span className="num" style={{ cursor: 'pointer' }} onClick={() => onDay(d)}>{d.getDate()}</span>
              {evs.slice(0, 4).map((ev) => (
                <div key={ev.instanceId} className={`ev-pill show-${ev.showAs || 'busy'}`} style={ev.allDay ? { background: ev.color, color: '#fff' } : { color: 'var(--text)' }} onClick={() => onOpen(ev)} onContextMenu={(e) => onMenu?.(e, ev)} title={ev.title}>
                  {!ev.allDay && <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 4, background: ev.color, marginRight: 4 }} />}
                  {!ev.allDay && <span className="faint">{fmtTime(ev.start)} </span>}{ev.title}
                </div>
              ))}
              {evs.length > 4 && <span className="small faint" style={{ cursor: 'pointer' }} onClick={() => onDay(d)}>+{evs.length - 4} more</span>}
            </div>
          );
        })}
      </div>
    </>
  );
}

function layoutDay(evs) {
  const sorted = [...evs].sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  let cluster = [], clusterEnd = 0;
  const flush = () => {
    const cols = [];
    for (const ev of cluster) {
      let c = cols.findIndex((end) => end <= ev.start);
      if (c < 0) { c = cols.length; cols.push(0); }
      cols[c] = ev.end;
      out.push({ ev, col: c });
    }
    for (const o of out.slice(out.length - cluster.length)) o.cols = cols.length;
    cluster = [];
  };
  for (const ev of sorted) {
    if (cluster.length && ev.start >= clusterEnd) flush();
    cluster.push(ev);
    clusterEnd = Math.max(clusterEnd, ev.end);
  }
  if (cluster.length) flush();
  return out;
}

function TimeGrid({ from, days, events, settings, onNew, onOpen, onMove, onMenu }) {
  const scroller = useRef();
  const [drag, setDrag] = useState(null);
  const [now, setNow] = useState(Date.now());
  const today = startOfDay(new Date()).getTime();
  const [ws] = (settings.calendar.workStart || '08:00').split(':').map(Number);
  const [we] = (settings.calendar.workEnd || '17:00').split(':').map(Number);
  useEffect(() => { scroller.current.scrollTop = Math.max(0, (ws - 1) * HOUR_PX); }, []);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60e3); return () => clearInterval(t); }, []);
  const dayList = [...Array(days)].map((_, i) => addDays(from, i));
  const cols = `56px repeat(${days}, 1fr)`;
  const allDay = events.filter((e) => e.allDay || e.end - e.start >= 864e5);
  const timed = events.filter((e) => !(e.allDay || e.end - e.start >= 864e5));

  // Drag to move / resize with 15-minute snapping.
  const startDrag = (e, ev, mode) => {
    if (e.button !== 0) return; // right-click opens the event menu instead
    e.stopPropagation(); e.preventDefault();
    // Events of read-only (subscribed) calendars only open; they cannot be moved.
    if (ev.readonly) { const up = () => { window.removeEventListener('mouseup', up); onOpen(ev); }; window.addEventListener('mouseup', up); return; }
    const y0 = e.clientY, x0 = e.clientX;
    const colW = scroller.current.querySelector('.day-col')?.getBoundingClientRect().width || 100;
    let moved = false;
    const onMoveMouse = (m) => {
      const dy = Math.round((m.clientY - y0) / (HOUR_PX / 4)) * 15 * 60e3;
      const dd = mode === 'move' ? Math.round((m.clientX - x0) / colW) * 864e5 : 0;
      if (Math.abs(m.clientY - y0) > 3 || Math.abs(m.clientX - x0) > 3) moved = true;
      setDrag({ id: ev.instanceId, start: mode === 'move' ? ev.start + dy + dd : ev.start, end: Math.max(ev.start + 15 * 60e3, ev.end + dy + dd) });
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMoveMouse); window.removeEventListener('mouseup', onUp);
      setDrag((d) => { if (moved && d && (d.start !== ev.start || d.end !== ev.end)) onMove(ev, d.start, d.end); else if (!moved) onOpen(ev); return null; });
    };
    window.addEventListener('mousemove', onMoveMouse); window.addEventListener('mouseup', onUp);
  };

  return (
    <div className="week">
      <div className="week-head" style={{ gridTemplateColumns: cols }}>
        <div />
        {dayList.map((d, i) => <div key={i} className={`d ${d.getTime() === today ? 'today' : ''}`}>{d.toLocaleDateString([], { weekday: 'short' })}<b>{d.getDate()}</b></div>)}
      </div>
      <div className="allday-row" style={{ gridTemplateColumns: cols }}>
        <div className="small faint" style={{ padding: 4, textAlign: 'right' }}>all-day</div>
        {dayList.map((d, i) => {
          const s = d.getTime(), e = s + 864e5;
          return <div key={i} className="day-col" style={{ padding: 2, display: 'flex', flexDirection: 'column', gap: 2 }} onDoubleClick={() => onNew(s, true)}>
            {allDay.filter((x) => x.start < e && x.end > s).map((ev) => <div key={ev.instanceId} className={`ev-pill show-${ev.showAs || 'busy'}`} style={{ background: ev.color, color: '#fff' }} onClick={() => onOpen(ev)} onContextMenu={(e) => onMenu?.(e, ev)}>{ev.title}</div>)}
          </div>;
        })}
      </div>
      <div className="week-body" ref={scroller}>
        <div className="week-grid" style={{ gridTemplateColumns: cols }}>
          <div>{[...Array(24)].map((_, h) => <div key={h} className="hour-label">{h ? `${String(h).padStart(2, '0')}:00` : ''}</div>)}</div>
          {dayList.map((d, i) => {
            const s = d.getTime(), e = s + 864e5;
            const dayEvs = timed.map((x) => (drag?.id === x.instanceId ? { ...x, ...drag } : x)).filter((x) => x.start < e && x.end > s);
            return (
              <div key={i} className="day-col">
                {[...Array(48)].map((_, k) => <div key={k} className={`slot ${k / 2 < ws || k / 2 >= we || [0, 6].includes(d.getDay()) ? 'off' : ''}`} onDoubleClick={() => onNew(s + k * 30 * 60e3)} onClick={(ev) => ev.detail === 1 && innerWidth < 860 && onNew(s + k * 30 * 60e3)} />)}
                {layoutDay(dayEvs).map(({ ev, col, cols: n }) => {
                  const top = ((Math.max(ev.start, s) - s) / 3600e3) * HOUR_PX;
                  const height = Math.max(18, ((Math.min(ev.end, e) - Math.max(ev.start, s)) / 3600e3) * HOUR_PX - 2);
                  return (
                    <div key={ev.instanceId} onContextMenu={(e) => onMenu?.(e, ev)} className={`ev-block ${ev.status} show-${ev.showAs || 'busy'} ${ev.blocked ? 'blocked' : ''}`} style={{ top, height, '--ev': ev.color, background: ev.color, left: `calc(${(col / n) * 100}% + 2px)`, width: `calc(${100 / n}% - 4px)`, right: 'auto' }}
                      onMouseDown={(m) => startDrag(m, ev, 'move')} title={`${ev.title}\n${fmtTime(ev.start)}–${fmtTime(ev.end)}${ev.location ? `\n${ev.location}` : ''}`}>
                      <div style={{ fontWeight: 600 }} className="truncate">{ev.title}</div>
                      {height > 30 && <div style={{ opacity: 0.9 }}>{fmtTime(ev.start)}–{fmtTime(ev.end)}{ev.location ? ` · ${ev.location}` : ''}</div>}
                      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 6, cursor: 'ns-resize' }} onMouseDown={(m) => startDrag(m, ev, 'resize')} />
                    </div>
                  );
                })}
                {now >= s && now < e && <div className="now-line" style={{ top: ((now - s) / 3600e3) * HOUR_PX }} />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Agenda({ events, onOpen, onMenu }) {
  const groups = useMemo(() => {
    const m = new Map();
    for (const e of events) { const k = startOfDay(e.start).getTime(); if (!m.has(k)) m.set(k, []); m.get(k).push(e); }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [events]);
  return (
    <div style={{ overflow: 'auto', flex: 1, padding: '8px 16px' }}>
      {groups.map(([day, evs]) => (
        <div key={day} style={{ marginBottom: 14 }}>
          <div className="small" style={{ fontWeight: 700, color: startOfDay(new Date()).getTime() === day ? 'var(--accent)' : 'var(--text-2)', padding: '6px 0' }}>{new Date(day).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</div>
          {evs.map((e) => (
            <div key={e.instanceId} className="list-row" style={{ borderRadius: 8, opacity: e.showAs === 'info' ? 0.6 : 1 }} onClick={() => onOpen(e)} onContextMenu={(ev) => onMenu?.(ev, e)}>
              <span style={{ width: 4, alignSelf: 'stretch', borderRadius: 2, background: e.color }} />
              <span className="small muted" style={{ width: 96 }}>{e.allDay ? 'All day' : `${fmtTime(e.start)} – ${fmtTime(e.end)}`}</span>
              <span className="grow truncate"><b>{e.title}</b>{e.location && <span className="faint"> · {e.location}</span>}</span>
              {e.onlineMeeting && <a href={e.onlineMeeting} target="_blank" rel="noreferrer" onClick={(x) => x.stopPropagation()} className="btn sm"><Video size={13} /> Join</a>}
            </div>
          ))}
        </div>
      ))}
      {!groups.length && <div className="empty">No upcoming events.</div>}
    </div>
  );
}

function ScopeModal({ title, onPick, onClose }) {
  return <Modal title={title} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn" onClick={() => onPick('all')}>All events</button><button className="btn primary" onClick={() => onPick('this')}>This event</button></>}>
    <div>This is a recurring event. Apply the change to this occurrence only, or to the whole series?</div>
  </Modal>;
}

const REPEAT = [['', 'Does not repeat'], ['FREQ=DAILY', 'Daily'], ['FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'Every weekday'], ['FREQ=WEEKLY', 'Weekly'], ['FREQ=WEEKLY;INTERVAL=2', 'Every 2 weeks'], ['FREQ=MONTHLY', 'Monthly'], ['FREQ=YEARLY', 'Yearly']];
const REMINDERS = [[0, 'At time of event'], [5, '5 minutes before'], [10, '10 minutes before'], [15, '15 minutes before'], [30, '30 minutes before'], [60, '1 hour before'], [120, '2 hours before'], [1440, '1 day before'], [10080, '1 week before']];

export function EventEditor({ initial, calendars: cals, onClose, onSaved }) {
  const [calendars, setCalendars] = useState(cals || []);
  useEffect(() => { if (!cals) api.get('/api/calendars').then(setCalendars); }, []);
  const isExisting = !!initial.id;
  const [ev, setEv] = useState(() => ({
    title: '', location: '', description: '', attendees: [], reminders: [15], busy: true, allDay: false, rrule: '', onlineMeeting: '',
    ...initial, rrule: initial.rrule || '',
  }));
  const [sendInvites, setSendInvites] = useState(!isExisting);
  const [scopeFor, setScopeFor] = useState(null);
  const [attendeeText, setAttendeeText] = useState('');
  const [slots, setSlots] = useState(null);
  const [untilMode, setUntilMode] = useState(() => (/COUNT=/.test(initial.rrule || '') ? 'count' : /UNTIL=/.test(initial.rrule || '') ? 'until' : 'never'));
  const set = (k, v) => setEv((e) => ({ ...e, [k]: v }));
  const space = store.get().space;
  // New events in a space go to a writable calendar of that space before falling back to the shared default.
  const cal = calendars.find((c) => c.id === ev.calendarId) || (space && calendars.find((c) => c.space === space && !c.readonly && c.enabled)) || calendars.find((c) => c.isDefault) || calendars[0];
  const readonly = cal?.readonly;
  // Events of read-only, "for information" or shared calendars can be added to one's own calendar (a linked copy).
  const canLink = isExisting && !initial.linkedFrom && (readonly || initial.showAs === 'info' || cal?.showAs === 'info' || !!store.get().acting);
  const baseRule = (ev.rrule || '').replace(/;?(COUNT|UNTIL)=[^;]*/g, '');
  const ruleExtra = (ev.rrule || '').match(/(COUNT|UNTIL)=([^;]*)/);

  const setTimes = (startStr, endStr) => {
    if (ev.allDay) {
      const s = new Date(startStr + 'T00:00').getTime();
      const e = Math.max(s + 864e5, new Date((endStr || startStr) + 'T00:00').getTime() + 864e5);
      setEv((x) => ({ ...x, start: s, end: e }));
    } else {
      const s = new Date(startStr).getTime();
      let e = endStr ? new Date(endStr).getTime() : s + (ev.end - ev.start);
      if (e <= s) e = s + 30 * 60e3;
      setEv((x) => ({ ...x, start: s, end: e }));
    }
  };

  const addAttendees = (text) => {
    const list = text.split(/[,;\s]+/).filter((x) => /@/.test(x)).map((email) => ({ email: email.toLowerCase(), name: '', status: 'needs-action', role: 'req-participant' }));
    set('attendees', [...ev.attendees, ...list.filter((a) => !ev.attendees.some((b) => b.email === a.email))]);
    setAttendeeText('');
  };

  // Other events at the same time (all enabled calendars, also read-only ones); all-day and "free" events are ignored.
  const [overlaps, setOverlaps] = useState([]);
  useEffect(() => {
    if (ev.allDay || !ev.start || !ev.end || readonly) { setOverlaps([]); return undefined; }
    const t = setTimeout(() => api.get(`/api/events?from=${ev.start}&to=${ev.end}&allSpaces=1`).then((list) => setOverlaps(list.filter((o) => o.busy !== false && !o.allDay && o.end - o.start < 864e5
      && o.start < ev.end && o.end > ev.start && !(isExisting && o.id === ev.id && (!ev.occurrence || o.start === ev.occurrence))))).catch(() => setOverlaps([])), 250);
    return () => clearTimeout(t);
  }, [ev.start, ev.end, ev.allDay]);

  const findTimes = async () => {
    const r = await api.get(`/api/calendar/free-slots?from=${Math.max(Date.now(), startOfDay(ev.start).getTime())}&to=${startOfDay(ev.start).getTime() + 7 * 864e5}&duration=${Math.round((ev.end - ev.start) / 60e3)}`);
    setSlots(r.slice(0, 8));
  };

  const save = async (scope) => {
    if (!ev.title.trim()) return toast('Add a title', { kind: 'error' });
    const body = { calendarId: cal?.id, title: ev.title, location: ev.location, description: ev.description, start: ev.start, end: ev.end, allDay: ev.allDay,
      rrule: ev.rrule || null, attendees: ev.attendees, reminders: ev.reminders, busy: ev.busy, onlineMeeting: ev.onlineMeeting || null, sourceMessageId: ev.sourceMessageId,
      sendInvites: sendInvites && ev.attendees.length > 0 };
    try {
      if (isExisting) {
        const id = ev.id;
        if (ev.occurrence && !scope) return setScopeFor('save');
        await api.patch(`/api/events/${id}`, { ...body, scope, occurrence: ev.occurrence || undefined, rrule: scope === 'this' ? undefined : body.rrule });
      } else await api.post('/api/events', body);
      onSaved?.();
    } catch (e) { toastError(e); }
  };

  const remove = async (scope) => {
    if (ev.occurrence && !scope) return setScopeFor('delete');
    if (!confirm(`Delete “${ev.title || 'this event'}”${scope === 'this' ? ' (this occurrence)' : ''}?${calendars.find((c) => c.id === ev.calendarId)?.source === 'caldav' ? ' It is also removed from the server calendar.' : ''}`)) return;
    const notify = ev.attendees.length && confirm('Notify attendees that the event is cancelled?') ? '1' : '0';
    try { await api.del(`/api/events/${ev.id}?scope=${scope || 'all'}&occurrence=${ev.occurrence || ''}&notify=${notify}`); onSaved?.(); } catch (e) { toastError(e); }
  };

  return (
    <Modal title={isExisting ? (readonly ? 'Event' : 'Edit event') : 'New event'} onClose={onClose} wide footer={readonly ? <>{canLink && <LinkToMine ev={initial} onDone={() => { onSaved?.(); }} />}<span className="grow" /><button className="btn" onClick={onClose}>Close</button></> : <>
      {canLink && <LinkToMine ev={initial} onDone={() => { onSaved?.(); }} />}
      {isExisting && <button className="btn danger" onClick={() => remove()}><Trash2 size={15} /> Delete</button>}
      <span className="grow" />
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" onClick={() => save()}>{sendInvites && ev.attendees.length ? 'Save & send' : 'Save'}</button>
    </>}>
      {isExisting && store.get().settings?.ai?.enabled && <MeetingPrep eventId={initial.seriesId || initial.id} />}
      {initial.linkedFrom && <div className="notice small" style={{ margin: 0 }}><Link2 size={14} /><span className="grow">Added from “{initial.linkedFromName || 'another calendar'}” — it follows the original: when that moves or changes, this copy does too.</span>
        <button className="btn sm ghost" onClick={async () => { try { await api.post(`/api/events/${initial.seriesId || initial.id}/unlink`); toast('No longer follows the original'); onSaved?.(); } catch (e) { toastError(e); } }}>Stop following</button></div>}
      <input className="input" style={{ fontSize: 17, height: 42 }} placeholder="Add a title" value={ev.title} onChange={(e) => set('title', e.target.value)} autoFocus={!isExisting} disabled={readonly} />
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <Clock size={16} className="faint" />
        {ev.allDay ? <>
          <input className="input" style={{ width: 160 }} type="date" value={toDateInput(ev.start)} onChange={(e) => setTimes(e.target.value, toDateInput(ev.end - 864e5))} />
          <span>–</span>
          <input className="input" style={{ width: 160 }} type="date" value={toDateInput(ev.end - 864e5)} onChange={(e) => setTimes(toDateInput(ev.start), e.target.value)} />
        </> : <>
          <input className="input" style={{ width: 210 }} type="datetime-local" value={toLocalInput(ev.start)} onChange={(e) => setTimes(e.target.value)} />
          <span>–</span>
          <input className="input" style={{ width: 210 }} type="datetime-local" value={toLocalInput(ev.end)} onChange={(e) => setTimes(toLocalInput(ev.start), e.target.value)} />
        </>}
        <label className="row small"><input type="checkbox" checked={ev.allDay} onChange={(e) => { const allDay = e.target.checked; const s = startOfDay(ev.start).getTime(); setEv((x) => ({ ...x, allDay, start: allDay ? s : s + 9 * 3600e3, end: allDay ? s + 864e5 : s + 9.5 * 3600e3 })); }} /> All day</label>
        {!ev.allDay && !readonly && <button className="btn sm ghost" onClick={findTimes}><Sparkles size={13} /> Find a free time</button>}
      </div>
      {overlaps.length > 0 && (
        <div className="banner warn overlap">
          <AlertTriangle size={15} />
          <span className="grow">Overlaps with {overlaps.slice(0, 3).map((o, i) => <span key={o.instanceId || o.id}>{i ? ', ' : ''}<b>{o.title || '(no title)'}</b> {fmtTime(o.start)}–{fmtTime(o.end)}{o.calendarName ? ` (${o.calendarName}${o.space && o.space !== store.get().space ? ` · ${o.space}` : ''})` : ''}</span>)}
            {overlaps.length > 3 ? ` and ${overlaps.length - 3} more` : ''}</span>
          {!ev.allDay && <button className="btn sm" onClick={findTimes}>Find a free time</button>}
        </div>
      )}
      {slots && <div className="row" style={{ flexWrap: 'wrap' }}>{slots.map((s) => <button key={s.start} className="btn sm" onClick={() => { setEv((x) => ({ ...x, start: s.start, end: s.end })); setSlots(null); }}>{new Date(s.start).toLocaleString([], { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</button>)}{!slots.length && <span className="small faint">No free slots in working hours this week.</span>}</div>}
      <div className="row"><Repeat size={16} className="faint" />
        <select className="input" style={{ width: 220 }} value={REPEAT.some(([v]) => v === baseRule) ? baseRule : 'custom'} onChange={(e) => set('rrule', e.target.value ? e.target.value + (ruleExtra && e.target.value ? `;${ruleExtra[0]}` : '') : '')}>
          {REPEAT.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          {!REPEAT.some(([v]) => v === baseRule) && <option value="custom">Custom ({baseRule})</option>}
        </select>
        {ev.rrule && <>
          <select className="input" style={{ width: 130 }} value={untilMode} onChange={(e) => { setUntilMode(e.target.value); set('rrule', baseRule + (e.target.value === 'count' ? ';COUNT=10' : e.target.value === 'until' ? `;UNTIL=${new Date(ev.start + 90 * 864e5).toISOString().slice(0, 10).replace(/-/g, '')}T235959Z` : '')); }}>
            <option value="never">Forever</option><option value="count">Number of times</option><option value="until">Until date</option>
          </select>
          {untilMode === 'count' && <input className="input" style={{ width: 80 }} type="number" min="1" value={(ruleExtra?.[1]) || 10} onChange={(e) => set('rrule', `${baseRule};COUNT=${e.target.value}`)} />}
          {untilMode === 'until' && <input className="input" style={{ width: 160 }} type="date" value={ruleExtra?.[2] ? `${ruleExtra[2].slice(0, 4)}-${ruleExtra[2].slice(4, 6)}-${ruleExtra[2].slice(6, 8)}` : ''} onChange={(e) => set('rrule', `${baseRule};UNTIL=${e.target.value.replace(/-/g, '')}T235959Z`)} />}
        </>}
      </div>
      <div className="row"><MapPin size={16} className="faint" /><input className="input" placeholder="Location" value={ev.location || ''} onChange={(e) => set('location', e.target.value)} disabled={readonly} /></div>
      <div className="row"><Video size={16} className="faint" /><input className="input" placeholder="Online meeting link (Teams, Zoom, Meet, Jitsi…)" value={ev.onlineMeeting || ''} onChange={(e) => set('onlineMeeting', e.target.value)} disabled={readonly} />
        {!ev.onlineMeeting && !readonly && <button className="btn sm" title="Create a Jitsi Meet link" onClick={() => set('onlineMeeting', `https://meet.jit.si/halcyon-${Math.random().toString(36).slice(2, 10)}`)}><Link2 size={13} /> Jitsi</button>}
        {ev.onlineMeeting && <a className="btn sm" href={ev.onlineMeeting} target="_blank" rel="noreferrer">Join</a>}
      </div>
      <div className="row" style={{ alignItems: 'flex-start' }}><Users size={16} className="faint" style={{ marginTop: 9 }} />
        <div className="grow">
          <input className="input" placeholder="Invite attendees (emails, Enter to add)" value={attendeeText} onChange={(e) => setAttendeeText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addAttendees(attendeeText); } }} onBlur={() => attendeeText && addAttendees(attendeeText)} disabled={readonly} />
          {ev.attendees.length > 0 && <div className="row" style={{ flexWrap: 'wrap', marginTop: 6 }}>{ev.attendees.map((a) => (
            <span key={a.email} className="chip" title={a.status}>{a.status === 'accepted' ? '✓ ' : a.status === 'declined' ? '✗ ' : a.status === 'tentative' ? '? ' : ''}{a.name || a.email}
              {!readonly && <button className="icon-btn" style={{ width: 16, height: 16 }} onClick={() => set('attendees', ev.attendees.filter((x) => x.email !== a.email))}>×</button>}</span>))}</div>}
          {ev.attendees.length > 0 && !readonly && <label className="row small" style={{ marginTop: 6 }}><input type="checkbox" checked={sendInvites} onChange={(e) => setSendInvites(e.target.checked)} /> Send invitations / updates by email</label>}
        </div>
      </div>
      <div className="row"><Bell size={16} className="faint" />
        <select className="input" style={{ width: 220 }} value={ev.reminders?.[0] ?? ''} onChange={(e) => set('reminders', e.target.value === '' ? [] : [Number(e.target.value)])}>
          <option value="">No reminder</option>{REMINDERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select className="input" style={{ width: 130 }} value={ev.busy ? '1' : '0'} onChange={(e) => set('busy', e.target.value === '1')}><option value="1">Busy</option><option value="0">Free</option></select>
        <select className="input" style={{ width: 200 }} value={cal?.id || ''} onChange={(e) => set('calendarId', Number(e.target.value))} disabled={isExisting && readonly}>
          {calendars.filter((c) => !c.readonly || c.id === cal?.id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <textarea className="input" rows={4} placeholder="Description" value={ev.description || ''} onChange={(e) => set('description', e.target.value)} disabled={readonly} />
      {ev.organizer?.email && <div className="small faint">Organizer: {ev.organizer.name || ev.organizer.email}</div>}
      {ev.sourceMessageId && <div className="small"><a href={`#/mail/unified/${ev.sourceMessageId}`} onClick={onClose}>Open related email</a></div>}
      {scopeFor && <ScopeModal title={scopeFor === 'delete' ? 'Delete recurring event' : 'Save recurring event'} onClose={() => setScopeFor(null)} onPick={(s) => { const f = scopeFor; setScopeFor(null); f === 'delete' ? remove(s) : save(s); }} />}
    </Modal>
  );
}

/** "Add to my calendar": a copy in one of the user's own calendars that follows the original (calendar/linked.js). */
function LinkToMine({ ev, onDone }) {
  const [openMenu, menuNode] = useMenu();
  const choose = async (e) => {
    const targets = await api.get('/api/events/link-targets').catch(() => []);
    const add = async (c) => {
      try { await api.post(`/api/events/${ev.seriesId || ev.id}/link`, { calendarId: c?.id }); toast(`Added to “${c?.name || 'your calendar'}” — it follows the original${ev.rrule ? ' (the whole series)' : ''}`); onDone?.(); } catch (err) { toastError(err); }
    };
    if (targets.length <= 1) return add(targets[0]);
    openMenu(e, [{ section: 'Add to my calendar' }, ...targets.map((c) => ({ label: c.name, hint: c.isDefault ? 'default' : '', onClick: () => add(c) }))]);
  };
  return <><button className="btn" title="A copy in your own calendar that follows this event when it moves or changes" onClick={(e) => { e.persist?.(); choose(e); }}><CalendarPlus size={15} /> Add to my calendar</button>{menuNode}</>;
}

/** A briefing before the meeting, from recent mail with its participants and about its subject (streamed). */
function MeetingPrep({ eventId }) {
  const [text, setText] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true); setText('');
    try { let t = ''; const r = await stream(`/api/events/${eventId}/prep`, {}, { onToken: (x) => { t += x; setText(t); } }); setText(r || t); } catch (e) { toastError(e); setText(null); } finally { setBusy(false); }
  };
  if (text === null) return <div><button className="btn sm ai" onClick={run}><Sparkles size={13} /> Prepare with AI</button> <span className="small faint">a briefing from recent mail with the participants</span></div>;
  return <div className="card ai-card" style={{ margin: 0 }}><div className="title"><Sparkles size={15} /> Preparation{busy && <Spinner size={13} />}</div>
    <Markdown text={text || '…'} onOpenMessage={(id) => navigate(`#/mail/unified/${id}`)} /></div>;
}
