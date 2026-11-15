// Focused / Other by hand (server: POST /api/messages/focus): moves the conversations without calling them important.
import { api } from '../api.js';
import { toast, toastError } from '../util.js';
import { loadFolders } from '../data.js';

export async function moveFocus(ids, focused, { always = false, onDone } = {}) {
  try {
    const r = await api.post('/api/messages/focus', { ids, focused, always });
    const where = focused ? 'Focused' : 'Other';
    toast(r.senders?.length ? `Moved to ${where} — mail from ${r.senders.join(', ')} will go there from now on`
      : `Moved to ${where}${always ? '' : ' — do it once more for this sender and their mail will always go there'}`);
    loadFolders();
    onDone?.(r);
  } catch (e) { toastError(e); }
}

/** Menu items for a list row or the reader; tab: the Focused / Other tab shown ('focused' | 'other' | other). */
export function focusMenuItems(ids, { tab, sender, onDone, icons }) {
  const who = sender ? ` from ${sender}` : '';
  return [
    tab !== 'focused' && { label: 'Move to Focused', icon: icons.to, hint: 'not important, just seen', onClick: () => moveFocus(ids, true, { onDone }) },
    tab !== 'other' && { label: 'Move to Other', icon: icons.away, onClick: () => moveFocus(ids, false, { onDone }) },
    tab !== 'focused' && { label: `Always move to Focused${who}`, icon: icons.to, onClick: () => moveFocus(ids, true, { always: true, onDone }) },
    tab !== 'other' && { label: `Always move to Other${who}`, icon: icons.away, onClick: () => moveFocus(ids, false, { always: true, onDone }) },
  ];
}
