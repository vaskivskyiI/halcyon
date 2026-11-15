// Addresses copied from the app paste as addresses: a selection over the To / Cc line of an email (or the recipients
// of a message being written) shows names, but what goes to the clipboard is "Name <address>, …" — so the whole
// list can be pasted into another email at once.
export function installAddressCopy() {
  document.addEventListener('copy', (e) => {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    let root = sel.getRangeAt(0).commonAncestorContainer;
    if (root.nodeType !== 1) root = root.parentElement;
    if (!root?.closest('[data-addr-scope]') && !root?.matches?.('[data-addr-scope]')) return;
    const list = [...new Set([...root.querySelectorAll('[data-addr]'), ...[root.closest('[data-addr]')].filter(Boolean)]
      .filter((el) => sel.containsNode(el, true)).map((el) => el.dataset.addr))];
    if (!list.length) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', list.join(', '));
  });
}
