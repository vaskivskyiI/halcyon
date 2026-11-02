// Popups (menus, panels, suggestion lists) close on a tap or click outside, on Escape and when the route changes.
// pointerdown rather than mousedown: a finger that lands outside and starts scrolling sends no mousedown, so menus
// stayed open on phones.
import { useEffect, useRef } from 'react';

/** Swallows the click that ends a touch which only closed a popup, as native menus do: the tap that dismisses
 *  does not also press the button or open the message under the finger. */
function swallowNextClick() {
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); done(); };
  // A later, separate touch is a new intent (the first one became a scroll and sent no click).
  const done = () => { window.removeEventListener('click', stop, true); window.removeEventListener('pointerdown', done, true); clearTimeout(t); };
  const t = setTimeout(done, 800);
  window.addEventListener('click', stop, true);
  window.addEventListener('pointerdown', done, true);
}

/**
 * Calls onClose while `open` on: a pointerdown outside `refs` (an element ref or a list of them — the popup and its
 * toggle button, so tapping the toggle toggles instead of closing and re-opening), Escape, or a hash change.
 * `ignore`: a selector for other places that do not count as outside (e.g. a menu opened from inside a panel).
 * `swallow`: a touch outside is used up by closing (default); off for suggestion lists beside a text field.
 */
export function useDismiss(refs, onClose, open = true, { ignore = '', swallow = true } = {}) {
  const cb = useRef(onClose);
  cb.current = onClose;
  const els = useRef(refs);
  els.current = refs;
  useEffect(() => {
    if (!open) return undefined;
    const inside = (t) => [].concat(els.current).some((r) => { const el = r && 'current' in r ? r.current : r; return el?.contains?.(t); })
      || (ignore && t?.closest?.(ignore));
    const down = (e) => {
      if (inside(e.target)) return;
      if (swallow && e.pointerType !== 'mouse') swallowNextClick();
      cb.current(e);
    };
    const key = (e) => { if (e.key === 'Escape') cb.current(e); };
    const route = () => cb.current();
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    window.addEventListener('hashchange', route);
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key); window.removeEventListener('hashchange', route); };
  }, [open, ignore, swallow]);
}
