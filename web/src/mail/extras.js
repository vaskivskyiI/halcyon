// Outlook-style actions shared by the message list and the reader: follow-up flags, block sender, sweep, ignore
// conversation and quick steps.
import { Flag, Ban, Brush, BellOff, Zap, Archive, Plus } from 'lucide-react';
import { api, ownerOf } from '../api.js';
import { store } from '../store.js';
import { toast, toastError } from '../util.js';
import { loadFolders } from '../data.js';
import { mailAction } from './mailActions.js';

export async function loadQuickSteps() {
  store.set({ quickSteps: await api.get('/api/quick-steps').catch(() => []) });
}

/** Follow-up choices: [label, due time or null]. */
export function followUpOptions() {
  const d = new Date();
  const at = (days, h) => { const x = new Date(d); x.setDate(x.getDate() + days); x.setHours(h, 0, 0, 0); return x.getTime(); };
  const friday = (5 - d.getDay() + 7) % 7;
  const monday = (1 - d.getDay() + 7) % 7 || 7;
  return [['Today', at(0, 17)], ['Tomorrow', at(1, 9)], friday > 0 && ['This week', at(friday, 15)], ['Next week', at(monday, 9)], ['No date', null]].filter(Boolean);
}

export async function followUp(ids, due, onDone) {
  try {
    for (const id of ids) await api.post(`/api/messages/${id}/follow-up`, { due });
    toast(due ? `Flagged — follow up ${new Date(due).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} (a task with a reminder)` : 'Flagged for follow-up (in Tasks)');
    onDone?.(); loadFolders();
  } catch (e) { toastError(e); }
}

export async function blockSender(address, onDone) {
  if (!confirm(`Block ${address}? Their mail goes to Junk from now on (also what is in the Inbox now). You can undo it in Settings → Rules.`)) return;
  try { const r = await api.post('/api/senders/block', { address, existing: true }); toast(`Blocked ${address}${r.moved ? ` — ${r.moved} message${r.moved > 1 ? 's' : ''} moved to Junk` : ''}`); onDone?.(); loadFolders(); } catch (e) { toastError(e); }
}

/** Sweep: archive (or delete) everything from a sender in the Inbox, or all but the newest — undoable. */
export async function sweep(address, action, keepLatest, onDone) {
  try {
    const { ids } = await api.get(`/api/messages/from-sender?address=${encodeURIComponent(address)}${keepLatest ? '&keepLatest=1' : ''}`);
    if (!ids.length) return toast('Nothing to sweep');
    if (!confirm(`${action === 'trash' ? 'Delete' : 'Archive'} ${ids.length} message${ids.length > 1 ? 's' : ''} from ${address}${keepLatest ? ' (keeping the newest)' : ''}?`)) return;
    await mailAction(action, ids, {}, { onDone });
  } catch (e) { toastError(e); }
}

export async function muteThread(threadId, muted, onDone) {
  try {
    await api.post(`/api/threads/${encodeURIComponent(threadId)}/mute`, { muted });
    toast(muted ? 'Ignored — new messages in this conversation go to the archive, read' : 'No longer ignored');
    onDone?.();
  } catch (e) { toastError(e); }
}

/** Runs a quick step on messages: flags, labels, categories and follow-ups first, then the one action that moves them. */
export async function runQuickStep(step, ids, onDone) {
  try {
    const moves = [];
    for (const a of step.actions) {
      if (a.type === 'markRead') await api.post('/api/messages/actions', { action: 'read', ids });
      else if (a.type === 'markUnread') await api.post('/api/messages/actions', { action: 'unread', ids });
      else if (a.type === 'flag') await api.post('/api/messages/actions', { action: 'flag', ids });
      else if (a.type === 'label' && a.labelId) await api.post('/api/messages/actions', { action: 'label', ids, labelId: a.labelId });
      else if (a.type === 'category' && a.categoryId) await api.post(`/api/custom-categories/${a.categoryId}/tag`, { ids, value: true });
      else if (a.type === 'followUp') for (const id of ids) await api.post(`/api/messages/${id}/follow-up`, { due: a.days != null ? Date.now() + Number(a.days) * 864e5 : null });
      else if (['archive', 'trash', 'move'].includes(a.type)) moves.push(a);
    }
    if (moves.length) { const m = moves[moves.length - 1]; await mailAction(m.type, ids, m.type === 'move' ? { folderId: m.folderId } : {}, { onDone }); } else { toast(`“${step.name}” done`); onDone?.(); }
    loadFolders();
  } catch (e) { toastError(e); }
}

/**
 * The archives (kept by Halcyon, on no mail server) of an owner: the person's own (null) or a shared space's — mail
 * goes only into an archive of the same owner (business mail stays in the business space).
 */
export const archives = (owner = null) => (store.get().folders?.accounts || []).filter((a) => a.kind === 'archive' && (a.owner ?? null) === owner);

/**
 * Into an archive: copied there and checked, then the mailbox copy goes to Trash on the mail server (recoverable
 * there until Trash is emptied). Runs in the background (Settings → Archives shows the progress).
 */
export async function moveToArchive(ids, archive, onDone) {
  if (!archive) {
    const name = prompt('Name of the new archive', `Archive ${new Date().getFullYear()}`);
    if (!name) return;
    // (ids: the archive is made where the mail is — in its shared space, if it is from one.)
    try { const a = await api.post('/api/archives', { name, ids }); await loadFolders(); archive = { accountId: a.id, name: a.name }; } catch (e) { return toastError(e); }
  }
  const n = ids.length;
  if (!confirm(`Move ${n > 1 ? `${n} messages` : 'this message'} to the archive “${archive.name}”?

Each is copied into the archive (kept by Halcyon), checked, and then moved to Trash on your mail server — it is removed from the server when Trash is emptied there.`)) return;
  try {
    await api.post(`/api/archives/${archive.accountId}/move`, { ids });
    toast(`Archiving ${n > 1 ? `${n} messages` : '1 message'}…`, { action: { label: 'Progress', onClick: () => { location.hash = '#/settings/archives'; } } });
    onDone?.();
  } catch (e) { toastError(e); }
}

/** Menu entries for one message (or a selection, ids) — follow-up, quick steps, sweep, block, ignore, archives. */
export function extraMenuItems({ msg, ids, onDone, muted = false }) {
  const steps = store.get().quickSteps || [];
  const from = msg?.from?.address;
  return [
    'sep', { section: 'Follow up' },
    ...followUpOptions().map(([label, due]) => ({ label, icon: Flag, hint: due ? new Date(due).toLocaleDateString([], { weekday: 'short' }) : '', onClick: () => followUp(ids, due, onDone) })),
    ...(steps.length ? ['sep', { section: 'Quick steps' }, ...steps.map((s) => ({ label: s.name, icon: Zap, onClick: () => runQuickStep(s, ids, onDone) }))] : []),
    'sep',
    from && { label: `Sweep: archive all from ${from}`, icon: Brush, onClick: () => sweep(from, 'archive', false, onDone) },
    from && { label: 'Sweep: keep only the newest', icon: Brush, onClick: () => sweep(from, 'archive', true, onDone) },
    msg?.threadId && { label: muted ? 'Stop ignoring this conversation' : 'Ignore conversation', icon: BellOff, hint: muted ? '' : 'new replies → archive', onClick: () => muteThread(msg.threadId, !muted, onDone) },
    from && { label: `Block ${from}`, icon: Ban, danger: true, onClick: () => blockSender(from, onDone) },
    'sep', { section: 'Move to archive' },
    ...archives(ownerOf(msg?.id ?? ids[0])).filter((a) => !msg || a.accountId !== msg.accountId).map((a) => ({ label: a.name, icon: Archive, hint: 'off the server', onClick: () => moveToArchive(ids, a, onDone) })),
    { label: 'New archive…', icon: Plus, onClick: () => moveToArchive(ids, null, onDone) },
  ];
}
