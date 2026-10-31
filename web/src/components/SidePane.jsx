// A second app next to the one in use: mail and calendar, calendar and notes… Any app of the suite, in a frame of its own
// that works as it always does. Kept on this device; a phone has no room for it.
import { useEffect, useRef, useState } from 'react';
import { X, ExternalLink } from 'lucide-react';
import { store } from '../store.js';

const KEY = 'halcyon:beside';
const saved = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } };
const keep = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* only a convenience */ } };

export const embedUrl = (origin, hash = '') => `${origin}/?embed=1${hash}`;
export function openBeside(title, url) {
  const v = { title, url, width: store.get().beside?.width || saved()?.width || 50 };
  keep(v);
  store.set({ beside: v });
}

export function SidePane() {
  const pane = store.use((s) => s.beside);
  const [dragging, setDragging] = useState(false);
  const ref = useRef();
  useEffect(() => { if (!store.get().beside && saved()?.url) store.set({ beside: saved() }); }, []);
  if (!pane?.url) return null;
  const close = () => { keep({ width: pane.width }); store.set({ beside: null }); };
  const drag = (e) => {
    e.preventDefault();
    setDragging(true);
    const app = ref.current.parentElement.getBoundingClientRect();
    const move = (m) => { const width = Math.min(75, Math.max(25, ((app.right - m.clientX) / app.width) * 100)); store.set({ beside: { ...store.get().beside, width } }); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); setDragging(false); keep(store.get().beside); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  return (
    <aside className="side-pane" ref={ref} style={{ width: `${pane.width}%` }}>
      <div className="side-drag" onPointerDown={drag} title="Drag to resize" />
      <div className="side-head"><b className="grow truncate">{pane.title}</b>
        <button className="icon-btn" title="Open in its own window" aria-label="Open in its own window" onClick={() => { window.open(pane.url.replace('?embed=1', ''), '_blank'); close(); }}><ExternalLink size={15} /></button>
        <button className="icon-btn" title="Close" aria-label="Close" onClick={close}><X size={16} /></button></div>
      <iframe title={pane.title} src={pane.url} style={{ pointerEvents: dragging ? 'none' : undefined }} />
    </aside>
  );
}
