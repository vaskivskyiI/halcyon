import { useEffect, useRef, useState } from 'react';
import { Archive, Plus, Upload, Download, Trash2, Pencil, FolderOpen, Sparkles, Combine } from 'lucide-react';
import AnalyzeOld from '../components/AnalyzeOld.jsx';
import { api, onEvent } from '../api.js';
import { loadFolders, loadAccounts } from '../data.js';
import { toast, toastError, fmtSize, navigate } from '../util.js';
import { Spinner, useMenu } from '../components/common.jsx';

const ACCEPT = '.pst,.ost,.mbox,.mbx,.eml,.zip';
const STATUS = { queued: 'Waiting', running: 'Working', done: 'Done', failed: 'Failed' };

/**
 * Archives: mail kept by Halcyon itself, on no mail server — Outlook data files (.pst / .ost) and other mail files
 * imported, or mail moved out of a mailbox. Searchable like any mail; exported as .eml files or .mbox.
 */
export default function Archives() {
  const [data, setData] = useState(null);
  const [upload, setUpload] = useState(null);
  const [analyze, setAnalyze] = useState(null);
  const [openMenu, menuNode] = useMenu();
  const file = useRef();
  const target = useRef(null);
  const load = () => api.get('/api/archives').then(setData).catch(toastError);
  useEffect(() => { load(); }, []);
  useEffect(() => onEvent((e) => {
    if (e.type !== 'archive:job') return;
    setData((d) => d && { ...d, jobs: [e.payload, ...d.jobs.filter((j) => j.id !== e.payload.id)].sort((a, b) => b.id - a.id) });
    if (['done', 'failed'].includes(e.payload.status)) { load(); loadFolders(); }
  }), []);
  const refresh = () => { load(); loadFolders(); loadAccounts().catch(() => {}); };

  const create = async () => {
    const name = prompt('Name of the archive', `Archive ${new Date().getFullYear()}`);
    if (!name) return null;
    try { const a = await api.post('/api/archives', { name }); refresh(); return a.id; } catch (e) { toastError(e); return null; }
  };
  // The desktop app's own server reads the file where it is (no copy of a large .pst); otherwise it is uploaded.
  const importInto = async (id) => {
    if (data?.localFiles && window.halcyonDesktop?.pickFile) {
      const p = await window.halcyonDesktop.pickFile({ title: 'Mail file to import', filters: [{ name: 'Mail files', extensions: ['pst', 'ost', 'mbox', 'mbx', 'eml', 'zip'] }] });
      if (p) api.post(`/api/archives/${id}/import`, { path: p }).then(() => toast('Importing in the background…')).then(load).catch(toastError);
      return;
    }
    target.current = id; file.current.click();
  };
  // Sent in pieces (8 MB, smaller when a proxy refuses that much or a piece stalls), each with a time limit, retried
  // and resumed where the server has the file up to — a proxy's upload limit, a stalled or dropped connection do not
  // stop a large Outlook data file. The upload is remembered for this file: choosing it again (also after closing the
  // page) continues where it stopped (the server keeps a started upload for two days).
  const stop = useRef(null);
  const send = async (f) => {
    const id = target.current;
    const key = `halcyon.upload.${id}|${f.name}|${f.size}|${f.lastModified}`;
    const ctl = new AbortController();
    stop.current = ctl;
    const t0 = Date.now();
    let startAt = 0;
    const show = (offset, note = '') => {
      const secs = (Date.now() - t0) / 1000, rate = secs > 2 ? (offset - startAt) / secs : 0;
      setUpload({ name: f.name, done: offset, total: f.size, rate, left: rate > 0 ? (f.size - offset) / rate : null, note });
    };
    show(0, 'Starting…');
    const leave = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', leave);
    try {
      let up = null, offset = 0;
      const saved = (() => { try { return localStorage.getItem(key); } catch { return null; } })();
      if (saved) {
        const s = await api.get(`/api/archives/uploads/${saved}`).catch(() => null);
        if (s && s.total === f.size) { up = { id: saved }; offset = startAt = s.size; }
      }
      if (!up) {
        up = await api.post('/api/archives/uploads', { filename: f.name, size: f.size });
        try { localStorage.setItem(key, up.id); } catch { /* private mode */ }
      }
      show(offset, startAt ? `Continuing where it stopped (${fmtSize(startAt)} already there)` : '');
      let piece = 8 << 20, fails = 0;
      while (offset < f.size) {
        if (ctl.signal.aborted) throw Object.assign(new Error('Upload cancelled — choose the same file again to continue where it stopped'), { cancelled: true });
        let r;
        // A piece that does not finish within 2 minutes is given up and sent again (smaller).
        const limit = AbortSignal.any ? AbortSignal.any([ctl.signal, AbortSignal.timeout(120e3)]) : ctl.signal;
        try {
          r = await fetch(api.url(`/api/archives/uploads/${up.id}?offset=${offset}`), { method: 'PUT', credentials: 'include', headers: { 'content-type': 'application/octet-stream' }, body: f.slice(offset, offset + piece), signal: limit });
        } catch (e) {
          if (ctl.signal.aborted) continue;
          // Stalled or dropped: smaller pieces (a proxy may cut large ones off without an answer), wait, ask where the
          // server is, continue from there.
          if (++fails > 25) throw new Error(`Upload stopped at ${fmtSize(offset)} — the connection keeps failing. Choose the same file again later; it continues where it stopped.`);
          piece = Math.max(1 << 20, Math.floor(piece / 2));
          const wait = Math.min(30, fails * 2);
          show(offset, `${e.name === 'TimeoutError' ? 'A piece did not get through in 2 minutes' : 'Connection dropped'} — trying again in ${wait} s with smaller pieces (${fmtSize(piece)}), attempt ${fails}`);
          await new Promise((res) => setTimeout(res, wait * 1000));
          offset = (await api.get(`/api/archives/uploads/${up.id}`).catch(() => ({ size: offset }))).size;
          continue;
        }
        if (r.status === 413 && piece > 256 << 10) { piece = Math.floor(piece / 2); show(offset, `The server takes at most ${fmtSize(piece * 2)} at once — sending ${fmtSize(piece)} pieces`); continue; }
        const d = await r.json().catch(() => ({}));
        if (r.status === 409) { offset = d.size; continue; }
        if (r.status === 404) { try { localStorage.removeItem(key); } catch { /* private mode */ } }
        if (!r.ok) throw new Error(d.error || `Upload failed (${r.status})`);
        offset = d.size; fails = 0;
        show(offset);
      }
      show(f.size, 'Uploaded — starting the import…');
      await api.post(`/api/archives/${id}/import`, { uploadId: up.id });
      try { localStorage.removeItem(key); } catch { /* private mode */ }
      toast('Uploaded — importing in the background…'); load();
    } catch (e) { if (e.cancelled) toast(e.message); else toastError(e); } finally { window.removeEventListener('beforeunload', leave); stop.current = null; setUpload(null); }
  };
  const merge = async (from, into) => {
    if (!confirm(`Move everything from “${from.name}” into “${into.name}”?\n\nFolders keep their names. Emails “${into.name}” already has are not added twice. “${from.name}” disappears when it is empty.`)) return;
    try { await api.post(`/api/archives/${into.id}/merge`, { fromId: from.id }); toast('Merging in the background…'); load(); } catch (e) { toastError(e); }
  };
  const rename = async (a) => { const n = prompt('Name', a.name); if (n && n !== a.name) { try { await api.patch(`/api/accounts/${a.id}`, { name: n }); refresh(); } catch (e) { toastError(e); } } };
  const remove = async (a) => {
    const typed = prompt(`Delete the archive “${a.name}” and the ${a.messages} emails in it from Halcyon? This cannot be undone — export it first if you may need it.\n\nType the archive's name to delete it:`);
    if (typed == null) return;
    if (typed.trim() !== a.name) return toast('Not deleted — the name did not match');
    try { await api.del(`/api/accounts/${a.id}`); toast('Archive deleted'); refresh(); } catch (e) { toastError(e); }
  };

  if (!data) return <div className="settings-section"><h2>Archives</h2><Spinner /></div>;
  const running = data.jobs.filter((j) => ['queued', 'running'].includes(j.status));
  return (
    <div className="settings-section">
      <h2>Archives</h2>
      {analyze && <AnalyzeOld {...analyze} onClose={() => setAnalyze(null)} />}
      <div className="muted">Mail kept here by Halcyon, on no mail server — like Outlook's archive (.pst) files. Import Outlook data files (.pst, .ost) and other mail files (.mbox, .eml, a .zip of .eml files), or move mail out of your mailbox to free space there (right-click a message or a folder → archive). Archived mail is searchable and shown with your folders; the AI does not analyse it again (moved mail keeps its analysis).</div>
      <input type="file" ref={file} accept={ACCEPT} hidden onChange={(e) => { const f = e.target.files[0]; e.target.value = ''; if (f) send(f); }} />
      {upload && <div className="notice upload-progress">
        <div className="row" style={{ gap: 8 }}><Upload size={15} /><span className="grow truncate">Uploading {upload.name}</span>
          <button className="btn sm ghost" onClick={() => stop.current?.abort()}>Cancel</button></div>
        <div className="bar"><span style={{ width: `${(upload.done / upload.total) * 100}%` }} /></div>
        <div className="small muted">{fmtSize(upload.done)} of {fmtSize(upload.total)} · {((upload.done / upload.total) * 100).toFixed(1)}%
          {upload.rate > 0 && ` · ${fmtSize(upload.rate)}/s`}{upload.left != null && upload.left > 1 && ` · about ${upload.left > 5400 ? `${Math.round(upload.left / 3600)} h` : upload.left > 90 ? `${Math.round(upload.left / 60)} min` : `${Math.round(upload.left)} s`} left`}
          {' '}· keep this page open (closing it pauses; choose the file again to continue)</div>
        {upload.note && <div className="small">{upload.note}</div>}
      </div>}

      {data.archives.map((a) => (
        <div key={a.id} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <Archive size={16} color={a.color} /><b className="grow">{a.name}</b>
            <span className="small muted">{a.messages} email{a.messages === 1 ? '' : 's'} · {fmtSize(a.bytes)}{a.space ? ` · space ${a.space}` : ''}</span>
          </div>
          {a.folders.length > 0 && <div className="small muted" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px' }}>
            {a.folders.filter((f) => f.total).map((f) => <a key={f.id} href={`#/mail/f${f.id}`}>{f.path} ({f.total})</a>)}</div>}
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <button className="btn sm" onClick={() => importInto(a.id)}><Upload size={14} /> Import a file…</button>
            {a.messages > 0 && <button className="btn sm" title="Summaries, topics and facts of its emails for search and the assistant" onClick={() => setAnalyze({ accountId: a.id, name: a.name })}><Sparkles size={14} /> Analyse with AI…</button>}
            <button className="btn sm" disabled={!a.messages} title="All folders as .eml files in a ZIP — open it in Explorer and drag the emails into Outlook or another mail program, or import it back here" onClick={() => window.open(api.url(`/api/archives/export?archiveId=${a.id}`))}><Download size={14} /> Export (.eml in ZIP)</button>
            {a.folders[0] && <button className="btn sm ghost" onClick={() => navigate(`#/mail/f${a.folders.find((f) => f.total)?.id || a.folders[0].id}`)}><FolderOpen size={14} /> Open</button>}
            <button className="btn sm ghost" onClick={() => rename(a)}><Pencil size={14} /> Rename</button>
            {data.archives.length > 1 && <button className="btn sm ghost" title="Move all of this archive into another one" onClick={(e) => openMenu(e, [{ section: 'Merge into' }, ...data.archives.filter((x) => x.id !== a.id).map((x) => ({ label: x.name, onClick: () => merge(a, x) }))])}><Combine size={14} /> Merge into…</button>}
            <span className="grow" />
            <button className="btn sm ghost danger" onClick={() => remove(a)}><Trash2 size={14} /> Delete</button>
          </div>
        </div>))}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="btn" onClick={create}><Plus size={15} /> New archive</button>
        <button className="btn" onClick={async () => { const id = data.archives[0]?.id || await create(); if (id) importInto(id); }}><Upload size={15} /> Import an Outlook data file…</button>
      </div>

      {data.jobs.length > 0 && <>
        <h3>Recent imports and moves</h3>
        {data.jobs.slice(0, 10).map((j) => {
          const name = data.archives.find((a) => a.id === j.archiveId)?.name || 'archive';
          return (
            <div key={j.id} className="row small" style={{ gap: 8, padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
              {['queued', 'running'].includes(j.status) && <Spinner size={12} />}
              <span className="grow">{j.type === 'import' ? `Import of ${j.fileName}` : j.type === 'merge' ? 'Archives merged' : 'Mail moved'} → {name}
                <span className="faint"> · {STATUS[j.status] || j.status}{j.done || j.total ? ` · ${j.done}${j.total ? ` of ${j.total}` : ''}` : ''}{j.skipped ? ` · ${j.skipped} skipped (already there or not mail)` : ''}{j.failed ? ` · ${j.failed} could not be read` : ''}</span>
                {j.error && <div className="faint" style={{ color: 'var(--danger)' }}>{j.error}</div>}</span>
              <span className="faint">{new Date(j.createdAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
            </div>);
        })}
      </>}
      {running.length === 0 && <div className="small faint">Outlook data files: .pst archives and .ost cache files (Outlook 2003 and later). Mail, with its folders, read state and attachments, is imported; calendar items and contacts in them are skipped. Large files are uploaded in pieces (no proxy setting needed) and continue where they stopped if the connection drops; in the desktop app (This PC) files are read where they are.</div>}
    {menuNode}
    </div>
  );
}
