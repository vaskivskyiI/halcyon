// Attachments dropped somewhere to be sent: onto a message being written, a draft, or a person (a new email to them).
// Inside the app an attachment dragged from an email carries ATT_TYPE (sent on from the mail it is in, not downloaded);
// the desktop apps drag a real file (so it can also go to Explorer), which arrives here as a file and is uploaded.
import { api } from '../api.js';
import { toast, toastError, fileToBase64 } from '../util.js';

export const ATT_TYPE = 'application/x-halcyon-attachment';
export const carriesFiles = (dt) => !!dt && (dt.types.includes('Files') || dt.types.includes(ATT_TYPE));

/** Files uploaded once (a draft only refers to them); larger than 25 MB are refused. */
export async function uploadFiles(files) {
  const list = [];
  for (const f of files) {
    if (f.size > 25 * 1024 * 1024) { toast(`${f.name} is larger than 25 MB`, { kind: 'error' }); continue; }
    try { list.push(await api.post('/api/uploads', { filename: f.name, contentType: f.type || 'application/octet-stream', contentBase64: await fileToBase64(f) })); } catch (e) { toastError(e); }
  }
  return list;
}

/** What was dropped, as composer attachments. */
export async function droppedAttachments(dt) {
  try {
    const a = JSON.parse(dt.getData(ATT_TYPE) || 'null');
    if (a) return [{ fromMessageId: a.messageId, index: a.index, filename: a.filename, size: a.size }];
  } catch { /* not ours */ }
  return dt.files?.length ? uploadFiles([...dt.files]) : [];
}

/** Props for a drop target; onList gets the attachments, setOver (optional) highlights it while something is above. */
export function attachmentDrop(onList, setOver) {
  return {
    onDragOver: (e) => { if (!carriesFiles(e.dataTransfer)) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; setOver?.(true); },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver?.(false); },
    onDrop: async (e) => {
      if (!carriesFiles(e.dataTransfer)) return;
      e.preventDefault(); e.stopPropagation(); setOver?.(false);
      const list = await droppedAttachments(e.dataTransfer);
      if (list.length) onList(list);
    },
  };
}
