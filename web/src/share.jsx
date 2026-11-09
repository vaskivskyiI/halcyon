import { useEffect, useState } from 'react';
import { api } from './api.js';
import { toast, toastError, navigate, textToHtml } from './util.js';
import { Modal, Spinner } from './components/common.jsx';
import { openComposer } from './mail/Composer.jsx';
import { EventPicker } from './calendar/EventPicker.jsx';
import { EventEditor } from './calendar/CalendarView.jsx';

/**
 * Shared to Halcyon from another Android app (ShareActivity: "Send by email", "Add to task", "Add to event"). The app
 * keeps what was shared; the page asks for it through the bridge: shareData(id) → { subject, text, files: [{ name,
 * type, size }] }, shareFile(id, i) → the file as base64.
 */
export default function Share({ kind, id, onClose }) {
  const [data, setData] = useState(null);
  const [newEvent, setNewEvent] = useState(null);
  useEffect(() => {
    let d = null;
    try { d = JSON.parse(window.halcyonAndroid?.shareData?.(id) || 'null'); } catch { d = null; }
    if (!d) { toast('What was shared is no longer here — share it again', { kind: 'error' }); onClose(); return; }
    setData(d);
    if (kind === 'mail') mail(d).finally(onClose);
    if (kind === 'task') task(d).finally(onClose);
  }, [kind, id]);

  const firstLine = (d) => (d.subject || String(d.text || '').split('\n').find((l) => l.trim()) || d.files?.[0]?.name || 'Shared').trim().slice(0, 200);
  const fileNames = (d) => (d.files || []).map((f) => f.name).join(', ');

  async function mail(d) {
    const attachments = [];
    for (let i = 0; i < (d.files || []).length; i++) {
      const f = d.files[i];
      try {
        const b64 = window.halcyonAndroid.shareFile(id, i);
        if (!b64) throw new Error(`${f.name} could not be read`);
        attachments.push(await api.post('/api/uploads', { filename: f.name, contentType: f.type || 'application/octet-stream', contentBase64: b64 }));
      } catch (e) { toastError(e); }
    }
    navigate('#/mail/unified');
    openComposer({ subject: d.subject || (attachments.length === 1 && !d.text ? attachments[0].filename : ''), ...(d.text ? { prefixHtml: textToHtml(d.text) } : {}), attachments });
  }

  async function task(d) {
    try {
      const title = firstLine(d);
      const notes = [d.text && d.text.trim() !== title ? d.text.trim() : '', fileNames(d) ? `Files: ${fileNames(d)}` : ''].filter(Boolean).join('\n\n');
      const t = await api.post('/api/tasks', { title, notes });
      toast('Task added');
      navigate(`#/tasks/${t.id}`);
    } catch (e) { toastError(e); }
  }

  const shared = (d) => [d.subject && d.subject !== d.text ? d.subject : '', d.text || '', fileNames(d) ? `Files: ${fileNames(d)}` : ''].filter(Boolean).join('\n');
  // Added to an event already in the calendar: what was shared goes into its description.
  const addTo = async (e) => {
    const ev = await api.get(`/api/events/${e.seriesId || e.id}`);
    await api.patch(`/api/events/${ev.id}`, { description: [ev.description || '', shared(data)].filter((x) => x.trim()).join('\n\n') });
  };

  if (kind === 'mail' || kind === 'task' || !data) return kind === 'mail' && data?.files?.length ? <Modal title="Send by email" onClose={() => {}}><div className="small"><Spinner size={13} /> Attaching {data.files.length} file{data.files.length > 1 ? 's' : ''}…</div></Modal> : null;
  if (newEvent) return <EventEditor initial={newEvent} onClose={onClose} onSaved={() => { toast('Event added'); onClose(); }} />;
  const start = Math.ceil(Date.now() / 3600e3) * 3600e3;
  return <EventPicker what={{ kind: 'text', subject: firstLine(data) }} title="Add to an event" onPick={addTo} onClose={onClose}
    footer={<><span className="grow small faint">It is added to the event's description.</span><button className="btn" onClick={() => setNewEvent({ title: firstLine(data), description: shared(data), start, end: start + 3600e3, allDay: false, attendees: [] })}>New event</button></>} />;
}
