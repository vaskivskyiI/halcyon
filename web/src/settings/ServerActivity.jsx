// Admin: what the server is doing in the background right now (GET /api/admin/activity), refreshed every few seconds —
// to find what keeps the CPU busy: AI jobs and calls, mail sync, calendar/contacts syncs, scheduled jobs, worker threads,
// slow requests (and whether they were slow themselves or waited for other work).
import { useEffect, useState } from 'react';
import { Pause, Play, X } from 'lucide-react';
import { api } from '../api.js';
import { Spinner } from '../components/common.jsx';
import { toastError } from '../util.js';

const dur = (ms) => (ms == null ? '' : ms < 1000 ? `${Math.round(ms)} ms` : ms < 60e3 ? `${(ms / 1000).toFixed(1)} s` : ms < 3600e3 ? `${Math.floor(ms / 60e3)} min ${Math.round(ms % 60e3 / 1000)} s` : `${(ms / 3600e3).toFixed(1)} h`);
const ago = (t, now) => (t ? `${dur(now - t)} ago` : '');
const who = (x) => (x.user ? `${x.user}${x.space ? ' (space)' : ''}` : x.userId ? `#${x.userId}` : '');
const warn = (ms, limit) => (ms > limit ? { color: 'var(--danger)', fontWeight: 600 } : undefined);

function Table({ head, rows, empty = 'Nothing.' }) {
  if (!rows.length) return <div className="small faint">{empty}</div>;
  return <table className="simple"><thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>{rows}</tbody></table>;
}

export default function ServerActivity() {
  const [d, setD] = useState(null);
  const [every, setEvery] = useState(3);
  const load = () => api.get('/api/admin/activity').then(setD).catch(toastError);
  useEffect(() => {
    load();
    if (!every) return undefined;
    const timer = setInterval(load, every * 1000);
    return () => clearInterval(timer);
  }, [every]);
  if (!d) return <div className="settings-section"><h2>Server activity</h2><Spinner size={18} /></div>;
  const p = d.process, now = d.at;
  const pause = () => api.post('/api/admin/activity/ai-queue', { paused: !d.ai.paused }).then(load).catch(toastError);
  const cancel = (j) => { if (confirm(`Cancel ${j.type} job #${j.id}? It is marked failed and its slot is freed.`)) api.post(`/api/admin/activity/ai-jobs/${j.id}/cancel`, {}).then(load).catch(toastError); };
  return (
    <div className="settings-section">
      <h2>Server activity</h2>
      <div className="muted">What the server is doing in the background right now, for all users — to find what keeps the processor busy. CPU and event-loop numbers cover the time since the last refresh.</div>
      <div className="row">
        <label className="row small">Refresh <select className="input" value={every} onChange={(e) => setEvery(Number(e.target.value))}>
          {[[0, 'off'], [2, 'every 2 s'], [3, 'every 3 s'], [5, 'every 5 s'], [10, 'every 10 s']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <button className="btn" onClick={load}>Refresh now</button>
      </div>

      <h3>Process</h3>
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        <span className="chip" style={warn(p.cpuPercent, 80)}>CPU {p.cpuPercent}% of a core</span>
        <span className="chip">user {p.cpuUserPercent}%</span>
        <span className="chip" style={warn(p.eventLoop.utilisation, 80)}>event loop busy {p.eventLoop.utilisation}%</span>
        <span className="chip" style={warn(p.eventLoop.delayP99Ms, 100)}>loop delay p99 {p.eventLoop.delayP99Ms} ms · max {p.eventLoop.delayMaxMs} ms</span>
        {p.stalls && <span className="chip" style={warn(p.stalls.maxMs, 500)} title="Times in the last minute that the server could not answer any request for over 20 ms">
          stalls last min {p.stalls.count} · longest {dur(p.stalls.maxMs)} · total {dur(p.stalls.totalMs)}</span>}
        <span className="chip">memory {p.memoryMb.rss} MB (heap {p.memoryMb.heapUsed} / {p.memoryMb.heapTotal} MB)</span>
        <span className="chip">up {dur(p.uptimeSec * 1000)} · Node {p.node} · pid {p.pid}</span>
      </div>

      {d.workers?.length > 0 && <>
        <h4>Worker threads</h4>
        <div className="small faint">Heavy work done beside the thread that answers requests, so it does not hold them up. Busy is per thread since the last refresh.</div>
        <Table head={['Work', 'Threads', 'Busy', 'Calls', 'In progress', 'Time in calls', 'Failed / restarted']} rows={d.workers.map((w) => (
          <tr key={w.name}><td>{w.name}</td><td>{w.running} of {w.size}</td><td>{w.busyPercent.length ? w.busyPercent.map((b) => `${b}%`).join(' · ') : 'not started'}</td>
            <td>{w.calls}</td><td>{w.pending}</td><td>{dur(w.busyMs)}</td><td style={warn(w.restarts, 0)}>{w.failed} / {w.restarts}</td></tr>))} />
      </>}

      <h3>AI queue</h3>
      <div className="row">
        <span className="small">{d.ai.running} of {d.ai.maxConcurrency} running{d.ai.paused ? ' · paused: no new jobs start' : ''}</span>
        <button className="btn sm" onClick={pause}>{d.ai.paused ? <><Play size={13} /> Resume</> : <><Pause size={13} /> Pause</>}</button>
        {d.ai.counts.map((c) => <span key={`${c.type}-${c.status}`} className="chip">{c.type} {c.status}: {c.n}</span>)}
      </div>
      <Table head={['Job', 'User', 'Ref', 'Priority', 'Running for', 'Waiting on', '']} empty="No AI job running." rows={d.ai.active.map((j) => (
        <tr key={j.id}><td>{j.type} #{j.id}{j.attempts > 1 ? ` (try ${j.attempts})` : ''}</td><td>{who(j)}</td><td>{j.refId}</td><td>{j.priority}</td>
          <td style={warn(j.ms, 120e3)}>{dur(j.ms)}</td>
          <td className="small">{j.calls.map((c, i) => <div key={i}>{c.provider}:{c.model} · {c.task} · {dur(c.ms)}</div>)}{j.callsDone ? <div className="faint">{j.callsDone} call{j.callsDone === 1 ? '' : 's'} done</div> : null}</td>
          <td><button className="icon-btn" title="Cancel this job" onClick={() => cancel(j)}><X size={15} /></button></td></tr>))} />
      <h4>AI calls in flight</h4>
      <Table head={['Task', 'Provider / model', 'User', 'Kind', 'For']} empty="No call to an AI provider right now." rows={d.ai.calls.map((c) => (
        <tr key={c.id}><td>{c.label}{c.meta.texts ? ` (${c.meta.texts} texts)` : ''}</td><td>{c.meta.provider}:{c.meta.model}</td><td>{who(c)}</td><td>{c.meta.interactive ? 'interactive' : 'background'}</td><td style={warn(c.ms, 60e3)}>{dur(c.ms)}</td></tr>))} />
      {Object.keys(d.ai.lanes).length > 0 && <div className="small faint">Provider lanes: {Object.entries(d.ai.lanes).map(([id, l]) => `#${id}: ${l.interactive} interactive, ${l.background} background, ${l.waiting} waiting`).join(' · ')}</div>}
      <h4>Next queued ({d.ai.queued.length}{d.ai.queued.length >= 50 ? '+' : ''})</h4>
      <Table head={['Job', 'User', 'Ref', 'Priority', 'Due', '']} empty="Queue empty." rows={d.ai.queued.slice(0, 20).map((j) => (
        <tr key={j.id}><td>{j.type} #{j.id}{j.attempts ? ` (failed ${j.attempts}×)` : ''}</td><td>{who(j)}</td><td>{j.refId}</td><td>{j.priority}</td><td>{j.due ? 'now' : `in ${dur(j.runAfter - now)}`}</td>
          <td><button className="icon-btn" title="Drop this job" onClick={() => cancel(j)}><X size={15} /></button></td></tr>))} />

      <h3>Mail sync</h3>
      <Table head={['Account', 'User', 'Connection', 'Doing', 'For', 'Waiting server changes', 'Last full check']} empty="No mail accounts." rows={d.mail.map((a) => (
        <tr key={a.accountId}><td>{a.email}</td><td>{who(a)}</td>
          <td className="small">{!a.worker ? 'not running' : !a.connected ? 'connecting' : a.idling ? `IDLE on ${a.selected}` : `connected${a.selected ? ` · ${a.selected}` : ''}`}{a.lastError ? <div className="faint">{a.lastError}</div> : null}</td>
          <td className="small">{a.doing ? `${a.doing.phase}${a.doing.folder ? ` · ${a.doing.folder}` : ''}${a.doing.total ? ` · ${a.doing.done} of ${a.doing.total}` : ''}` : a.queuedWork?.full ? 'full sync requested' : a.queuedWork?.folders.length ? `${a.queuedWork.folders.length} folder(s) to check` : '—'}</td>
          <td style={warn(a.doing?.ms, 300e3)}>{a.doing ? dur(a.doing.ms) : ''}</td>
          <td className="small">{a.pendingOps.map((o) => `${o.op}: ${o.n}${o.retrying ? ` (${o.retrying} retrying)` : ''}`).join(', ') || '—'}</td>
          <td className="small">{a.lastFullAt ? `${ago(a.lastFullAt, now)}, took ${dur(a.lastFullMs)}` : ''}</td></tr>))} />
      {d.runningOps > 0 && <div className="small faint">{d.runningOps} server change(s) being sent now.</div>}

      <h3>Other background work</h3>
      <Table head={['Kind', 'What', 'Details', 'Running for']} empty="Nothing else running." rows={d.work.map((w) => (
        <tr key={w.id}><td>{w.kind}</td><td>{w.label}</td><td className="small">{[w.user && who(w), w.meta?.accountId && `account #${w.meta.accountId}`, w.meta?.kb && `${w.meta.kb} KB`].filter(Boolean).join(' · ')}</td><td style={warn(w.ms, 60e3)}>{dur(w.ms)}</td></tr>))} />
      {d.archives.length > 0 && <Table head={['Archive job', 'User', 'Status', 'Progress', 'Started']} rows={d.archives.map((j) => (
        <tr key={j.id}><td>{j.type} #{j.id}</td><td>#{j.userId}</td><td>{j.status}</td><td>{j.total ? `${j.done} of ${j.total}` : j.done}</td><td>{ago(j.createdAt, now)}</td></tr>))} />}

      <h3>Time spent since start</h3>
      <div className="small faint">Scheduled jobs, calendar/contacts syncs, AI calls and reading emails, by total time.</div>
      <Table head={['Kind', 'What', 'Runs', 'Total', 'Average', 'Longest', 'Last']} rows={d.totals.map((t) => (
        <tr key={`${t.kind}-${t.label}`}><td>{t.kind}</td><td>{t.label}</td><td>{t.runs}</td><td>{dur(t.totalMs)}</td><td>{dur(t.totalMs / t.runs)}</td><td>{dur(t.maxMs)}</td><td className="small">{ago(t.lastAt, now)}, {dur(t.lastMs)}</td></tr>))} />

      <h3>Slow requests (over 0.5 s)</h3>
      <div className="small faint">Handler: the request's own work. Server busy: time it waited because the server was doing something else (sync, AI, other requests). The rest is waiting on the disk, a mail server or an AI provider.</div>
      <Table head={['When', 'Request', 'Status', 'Took', 'Handler', 'Server busy', 'User']} empty="None since the server started." rows={d.slowRequests.map((r, i) => (
        <tr key={i}><td className="small">{ago(r.at, now)}</td><td>{r.method} {r.route}</td><td>{r.status}</td><td style={warn(r.ms, 2000)}>{dur(r.ms)}</td>
          <td>{r.ownMs != null ? dur(r.ownMs) : ''}</td><td style={warn(r.busyMs, r.ms / 2)}>{r.busyMs != null ? dur(r.busyMs) : ''}</td><td>{r.userId ? `#${r.userId}` : ''}</td></tr>))} />

      <h3>Slow background work (over 1 s)</h3>
      <Table head={['When', 'Kind', 'What', 'Details', 'Took']} empty="None since the server started." rows={d.slowWork.map((w, i) => (
        <tr key={i}><td className="small">{ago(w.at, now)}</td><td>{w.kind}</td><td>{w.label}</td><td className="small">{[w.meta?.provider && `${w.meta.provider}:${w.meta.model}`, w.meta?.accountId && `account #${w.meta.accountId}`, w.meta?.kb && `${w.meta.kb} KB`].filter(Boolean).join(' · ')}</td><td>{dur(w.ms)}</td></tr>))} />
    </div>
  );
}
