import { api } from '../api.js';
import { toast, toastError, pushUndo } from '../util.js';
import { loadFolders } from '../data.js';

export function snoozeOptions() {
  const d = new Date();
  const at = (days, h, m = 0) => { const x = new Date(d); x.setDate(x.getDate() + days); x.setHours(h, m, 0, 0); return x.getTime(); };
  const laterToday = d.getHours() < 17 ? Math.max(d.getTime() + 3 * 3600e3, at(0, 13)) : null;
  const sat = (6 - d.getDay() + 7) % 7 || 7;
  const mon = (1 - d.getDay() + 7) % 7 || 7;
  return [
    laterToday && ['Later today', laterToday],
    ['Tomorrow morning', at(1, 8)],
    ['Tomorrow afternoon', at(1, 14)],
    d.getDay() >= 1 && d.getDay() <= 4 && ['This weekend', at(sat, 9)],
    ['Next week', at(mon, 8)],
    ['In a month', at(30, 8)],
  ].filter(Boolean);
}

/**
 * Performs a mailbox action; moves (archive, delete, spam, move) get an Undo button. "Delete" on mail that is already
 * in Trash or Junk would be permanent, so it is only done after an explicit confirmation.
 */
/** "Delete" on mail already in Trash/Junk means permanent deletion: returns 'delete' after confirmation, null if declined. */
export function confirmDelete(action, folderSpecial, count) {
  if (action !== 'trash' || !['\\Trash', '\\Junk'].includes(folderSpecial)) return action;
  return confirm(`Permanently delete ${count > 1 ? `${count} messages` : 'this message'}? You can undo it for 30 minutes (Ctrl+Z).`) ? 'delete' : null;
}

export async function mailAction(action, ids, extra = {}, { threads = false, onDone } = {}) {
  if (!ids.length) return;
  try {
    const r = await api.post('/api/messages/actions', { action, ids, threads, ...extra });
    const labels = { archive: 'Archived', trash: 'Moved to Trash', spam: 'Marked as spam', notspam: 'Moved to Inbox', move: 'Moved', snooze: 'Snoozed', delete: 'Deleted permanently' };
    const what = `${labels[action] || ''} ${ids.length > 1 ? `${ids.length} conversations` : ''}`.trim();
    if (r.undoDelete?.length) toast(what, { duration: 10000, action: { label: 'Undo', onClick: () => undelete(r.undoDelete, onDone) } });
    else if (r.undo?.length) {
      toast(what, { duration: 10000, action: { label: 'Undo', onClick: async () => {
        try { await api.post('/api/messages/actions', { action: 'restore', items: r.undo }); toast('Restored'); onDone?.(true); loadFolders(); } catch (e) { toastError(e); }
      } } });
    } else if (labels[action]) toast(what);
    // Quiet ones: no toast, but Ctrl+Z turns them back.
    const inverse = { read: 'unread', unread: 'read', flag: 'unflag', unflag: 'flag', label: 'unlabel', unlabel: 'label' }[action];
    if (inverse) pushUndo(action, () => api.post('/api/messages/actions', { action: inverse, ids, threads, ...extra }).then(() => { window.dispatchEvent(new Event('halcyon:mutated')); loadFolders(); }).catch(toastError));
    onDone?.();
    loadFolders();
  } catch (e) { toastError(e); }
}

/** Undo of a permanent deletion (kept 30 minutes on the server before it reaches the mail server). */
export async function undelete(held, onDone) {
  try {
    const r = await api.post('/api/messages/actions', { action: 'undelete', held });
    toast(r.count ? 'Restored' : 'Too late — already deleted on the mail server', r.count ? {} : { kind: 'error' });
    onDone?.(true); loadFolders(); window.dispatchEvent(new Event('halcyon:mutated'));
  } catch (e) { toastError(e); }
}

/** After queuing a message: once it should have gone out, refresh the list, the conversation and the counts
 *  (the live event does this too, but not when the event socket is unavailable). */
export function afterSend(r) {
  const due = Math.max(0, (r?.sendAt || Date.now()) - Date.now());
  if (due > 3600e3) return;
  for (const extra of [2500, 8000]) {
    setTimeout(() => ['halcyon:poll', 'halcyon:sent', 'halcyon:mutated'].forEach((t) => window.dispatchEvent(new Event(t))), due + extra);
  }
}
