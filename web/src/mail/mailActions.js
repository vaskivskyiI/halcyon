import { api } from '../api.js';
import { toast, toastError } from '../util.js';
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

/** Performs a mailbox action; shows an undo toast for reversible moves. */
export async function mailAction(action, ids, extra = {}, { threads = false, onDone } = {}) {
  if (!ids.length) return;
  try {
    await api.post('/api/messages/actions', { action, ids, threads, ...extra });
    const labels = { archive: 'Archived', trash: 'Moved to Trash', spam: 'Marked as spam', move: 'Moved', snooze: 'Snoozed', delete: 'Deleted permanently' };
    if (labels[action]) toast(`${labels[action]} ${ids.length > 1 ? `${ids.length} conversations` : ''}`.trim());
    onDone?.();
    loadFolders();
  } catch (e) { toastError(e); }
}
