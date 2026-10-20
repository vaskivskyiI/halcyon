import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { ChevronLeft, ChevronRight, Plus, MapPin, Video, Users, Repeat, Bell, Trash2, Download, Upload, RefreshCw, Link2, Clock, Sparkles } from 'lucide-react';
import { api, onEvent } from '../api.js';
import { store } from '../store.js';
import { Modal, useMenu, Spinner } from '../components/common.jsx';
import { toast, toastError, startOfDay, addDays, startOfWeek, toLocalInput, toDateInput, fmtTime, navigate } from '../util.js';

const HOUR_PX = 48;
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

export default function CalendarView() {
  const settings = store.use((s) => s.settings);
  const weekStart = settings.ui.weekStart ?? 1;
  const [view, setView] = useState(() => localStorage.getItem('cal.view') || (innerWidth < 860 ? 'agenda' : 'week'));
  const [date, setDate] = useState(new Date());
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

  const visibleCals = calendars.filter((c) => c.enabled);
  return (
    <div className="main">
      <aside className="sidebar cal-side">
        <div className="sidebar-head"><button className="btn primary grow" style={{ justifyContent: 'center', height: 38 }} onClick={() => newEvent()}><Plus size={16} /> New event</button></div>
        <MiniMonth date={date} onPick={(d) => { setDate(d); if (view === 'month') setView('day'); }} weekStart={weekStart} />
        <div className="sidebar-scroll">
          <div className="nav-section" style={{ cursor: 'default' }}><span className="grow">Calendars</span><button className="icon-btn" style={{ width: 22, height: 22 }} title="Add calendar" onClick={() => setNewCal(true)}><Plus size={13} /></button></div>
          {calendars.map((c) => <CalendarItem key={c.id} c={c} reload={() => { loadCals(); load(); }} />)}
        </div>
      </aside>
      <section className="cal">
        <div className="cal-head">
          <button className="btn" onClick={() => setDate(new Date())}>Today</button>
          <button className="icon-btn" onClick={() => step(-1)} aria-label="Previous"><ChevronLeft size={18} /></button>
          <button className="icon-btn" onClick={() => step(1)} aria-label="Next"><ChevronRight size={18} /></button>
          <h2 className="truncate">{title}</h2>
          <span className="grow" />
          <button className="icon-btn mobile-only" onClick={() => newEvent()}><Plus size={18} /></button>
          <select className="input" style={{ width: 'auto' }} value={view} onChange={(e) => setView(e.target.value)}>{VIEWS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </div>
        {view === 'month' && <MonthView from={from} date={date} events={events} onNew={(d) => newEvent(d.getTime() + 9 * 3600e3)} onOpen={setEditing} onDay={(d) => { setDate(d); setView('day'); }} />}
        {['week', 'workweek', 'day'].includes(view) && <TimeGrid from={from} days={Math.round((to - from) / 864e5)} events={events} settings={settings} onNew={newEvent} onOpen={setEditing} onMove={moveEvent} />}
        {view === 'agenda' && <Agenda events={events} onOpen={setEditing} />}
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
      { label: 'Export .ics', icon: Download, onClick: () => window.open(api.url(`/api/calendars/${c.id}/export.ics`)) },
      !c.readonly && { label: 'Import .ics', icon: Upload, onClick: () => fileRef.current.click() },
      c.source !== 'local' && { label: 'Refresh', icon: RefreshCw, onClick: () => api.post(`/api/calendars/${c.id}/refresh`).then(reload) },
      !c.isDefault && { label: 'Remove calendar', icon: Trash2, danger: true, onClick: () => confirm(`Remove ${c.name}?`) && api.del(`/api/calendars/${c.id}`).then(reload) },
    ])}>
      <input type="checkbox" checked={c.enabled} style={{ accentColor: c.color }} onChange={(e) => api.patch(`/api/calendars/${c.id}`, { enabled: e.target.checked }).then(reload)} />
      <span className="truncate grow">{c.name}</span>{c.isDefault && <span className="faint small">default</span>}
      <input ref={fileRef} type="file" accept=".ics,text/calendar" hidden onChange={async (e) => {
        const f = e.target.files[0]; if (!f) return;
        try { const r = await api.post(`/api/calendars/${c.id}/import`, { ics: await f.text() }); toast(`Imported ${r.imported} events`); reload(); } catch (err) { toastError(err); }
        e.target.value = '';
      }} />
      {menuNode}
    </div>
  );
}

function NewCalendarModal({ onClose, onDone }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [color, setColor] = useState('#10b981');
  const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); try { await api.post('/api/calendars', { name: name || 'Calendar', color, url: url || undefined }); onDone(); } catch (e) { toastError(e); } finally { setBusy(false); } };
  return <Modal title="Add calendar" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>Add</button></>}>
    <label className="field">Name<input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
    <label className="field">Color<input type="color" value={color} onChange={(e) => setColor(e.target.value)} /></label>
    <label className="field">Subscribe to URL (optional, read-only .ics / webcal)<input className="input" placeholder="https://… or webcal://…" value={url} onChange={(e) => setUrl(e.target.value)} /></label>
    <div className="small faint">To sync a CalDAV server (Nextcloud, iCloud, Fastmail, Google…), set its CalDAV URL on the mail account in Settings → Accounts.</div>
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

function MonthView({ from, date, events, onNew, onOpen, onDay }) {
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
                <div key={ev.instanceId} className="ev-pill" style={ev.allDay ? { background: ev.color, color: '#fff' } : { color: 'var(--text)' }} onClick={() => onOpen(ev)} title={ev.title}>
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

function TimeGrid({ from, days, events, settings, onNew, onOpen, onMove }) {
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
    e.stopPropagation(); e.preventDefault();
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
            {allDay.filter((x) => x.start < e && x.end > s).map((ev) => <div key={ev.instanceId} className="ev-pill" style={{ background: ev.color, color: '#fff' }} onClick={() => onOpen(ev)}>{ev.title}</div>)}
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
                    <div key={ev.instanceId} className={`ev-block ${ev.status}`} style={{ top, height, background: ev.color, left: `calc(${(col / n) * 100}% + 2px)`, width: `calc(${100 / n}% - 4px)`, right: 'auto' }}
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

function Agenda({ events, onOpen }) {
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
            <div key={e.instanceId} className="list-row" style={{ borderRadius: 8 }} onClick={() => onOpen(e)}>
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
    <Modal title={isExisting ? (readonly ? 'Event' : 'Edit event') : 'New event'} onClose={onClose} wide footer={readonly ? <button className="btn" onClick={onClose}>Close</button> : <>
      {isExisting && <button className="btn danger" onClick={() => remove()}><Trash2 size={15} /> Delete</button>}
      <span className="grow" />
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" onClick={() => save()}>{sendInvites && ev.attendees.length ? 'Save & send' : 'Save'}</button>
    </>}>
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
