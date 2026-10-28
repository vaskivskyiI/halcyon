import { useEffect, useRef, useState } from 'react';
import { Archive, Plus, Upload, Download, Trash2, Pencil, FolderOpen } from 'lucide-react';
import { api, onEvent } from '../api.js';
import { loadFolders, loadAccounts } from '../data.js';
import { toast, toastError, fmtSize, navigate } from '../util.js';
import { Spinner } from '../components/common.jsx';

const ACCEPT = '.pst,.ost,.mbox,.mbx,.eml,.zip';
const STATUS = { queued: 'Waiting', running: 'Working', done: 'Done', failed: 'Failed' };

/**
 * Archives: mail kept by Halcyon itself, on no mail server — Outlook data files (.pst / .ost) and other mail files
 * imported, or mail moved out of a mailbox. Searchable like any mail; exported as .eml files or .mbox.
 */
export default function Archives() {
  const [data, setData] = useState(null);
  const [upload, setUpload] = useState(null);
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
  // Sent in pieces (8 MB, smaller when a proxy refuses that much at once), each retried and resumed where the server
  // has the file up to — a proxy's upload limit and a dropped connection do not stop a large Outlook data file.
  const send = async (f) => {
    const id = target.current;
    setUpload({ name: f.name, pct: 0 });
    try {
      const up = await api.post('/api/archives/uploads', { filename: f.name, size: f.size });
      let offset = 0, piece = 8 << 20, fails = 0;
      while (offset < f.size) {
        let r;
        try {
          r = await fetch(api.url(`/api/archives/uploads/${up.id}?offset=${offset}`), { method: 'PUT', credentials: 'include', headers: { 'content-type': 'application/octet-stream' }, body: f.slice(offset, offset + piece) });
        } catch {
          // Connection lost: wait, ask where the server is, continue from there.
          if (++fails > 20) throw new Error('Upload stopped — the connection keeps failing. Start it again later; it continues where it stopped.');
          await new Promise((res) => setTimeout(res, Math.min(30e3, 1000 * fails)));
          offset = (await api.get(`/api/archives/uploads/${up.id}`).catch(() => ({ size: offset }))).size;
          continue;
        }
        if (r.status === 413 && piece > 256 << 10) { piece = Math.floor(piece / 2); continue; } // the proxy's limit is lower
        const d = await r.json().catch(() => ({}));
        if (r.status === 409) { offset = d.size; continue; }
        if (!r.ok) throw new Error(d.error || `Upload failed (${r.status})`);
        offset = d.size; fails = 0;
        setUpload({ name: f.name, pct: Math.floor((offset / f.size) * 100) });
      }
      await api.post(`/api/archives/${id}/import`, { uploadId: up.id });
      toast('Uploaded — importing in the background…'); load();
    } catch (e) { toastError(e); } finally { setUpload(null); }
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
      <div className="muted">Mail kept here by Halcyon, on no mail server — like Outlook's archive (.pst) files. Import Outlook data files (.pst, .ost) and other mail files (.mbox, .eml, a .zip of .eml files), or move mail out of your mailbox to free space there (right-click a message or a folder → archive). Archived mail is searchable and shown with your folders; the AI does not analyse it again (moved mail keeps its analysis).</div>
      <input type="file" ref={file} accept={ACCEPT} hidden onChange={(e) => { const f = e.target.files[0]; e.target.value = ''; if (f) send(f); }} />
      {upload && <div className="notice"><Upload size={15} /><span className="grow">Uploading {upload.name}… {upload.pct}%</span></div>}

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
            <button className="btn sm" disabled={!a.messages} title="All folders as .eml files in a ZIP — open it in Explorer and drag the emails into Outlook or another mail program, or import it back here" onClick={() => window.open(api.url(`/api/archives/export?archiveId=${a.id}`))}><Download size={14} /> Export (.eml in ZIP)</button>
            {a.folders[0] && <button className="btn sm ghost" onClick={() => navigate(`#/mail/f${a.folders.find((f) => f.total)?.id || a.folders[0].id}`)}><FolderOpen size={14} /> Open</button>}
            <button className="btn sm ghost" onClick={() => rename(a)}><Pencil size={14} /> Rename</button>
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
              <span className="grow">{j.type === 'import' ? `Import of ${j.fileName}` : 'Mail moved'} → {name}
                <span className="faint"> · {STATUS[j.status] || j.status}{j.done || j.total ? ` · ${j.done}${j.total ? ` of ${j.total}` : ''}` : ''}{j.skipped ? ` · ${j.skipped} skipped (already there or not mail)` : ''}{j.failed ? ` · ${j.failed} could not be read` : ''}</span>
                {j.error && <div className="faint" style={{ color: 'var(--danger)' }}>{j.error}</div>}</span>
              <span className="faint">{new Date(j.createdAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
            </div>);
        })}
      </>}
      {running.length === 0 && <div className="small faint">Outlook data files: .pst archives and .ost cache files (Outlook 2003 and later). Mail, with its folders, read state and attachments, is imported; calendar items and contacts in them are skipped. Large files are uploaded in pieces (no proxy setting needed) and continue where they stopped if the connection drops; in the desktop app (This PC) files are read where they are.</div>}
    </div>
  );
}
