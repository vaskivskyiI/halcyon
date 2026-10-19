import { useEffect, useRef, useState, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { X } from 'lucide-react';
import { store } from '../store.js';
import { dismissToast, initials, colorFor } from '../util.js';

export function Modal({ title, onClose, children, footer, wide }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return createPortal(
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-label={title}>
        <div className="modal-head"><span className="grow">{title}</span><button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>, document.body);
}

/** Dropdown/context menu anchored at {x,y} or to an element. items: [{label, icon, onClick, danger} | {section} | 'sep'] */
export function Menu({ at, items, onClose }) {
  const ref = useRef();
  const [pos, setPos] = useState({ left: at.x, top: at.y });
  useLayoutEffect(() => {
    const r = ref.current.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(at.x, innerWidth - r.width - 8)), top: Math.max(8, Math.min(at.y, innerHeight - r.height - 8)) });
  }, [at.x, at.y]);
  useEffect(() => {
    const close = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    const key = (e) => e.key === 'Escape' && onClose();
    setTimeout(() => window.addEventListener('mousedown', close), 0);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', key); };
  }, [onClose]);
  return createPortal(
    <div className="menu" ref={ref} style={pos}>
      {items.filter(Boolean).map((it, i) => it === 'sep' ? <div key={i} className="sep" /> : it.section ? <div key={i} className="label">{it.section}</div> : (
        <button key={i} className={it.danger ? 'error-text' : ''} onClick={() => { onClose(); it.onClick?.(); }}>
          {it.icon && <it.icon size={15} />}{it.label}{it.hint && <span className="faint small" style={{ marginLeft: 'auto' }}>{it.hint}</span>}
        </button>
      ))}
    </div>, document.body);
}

export function useMenu() {
  const [menu, setMenu] = useState(null);
  const open = (e, items) => {
    e.preventDefault(); e.stopPropagation();
    const r = e.currentTarget?.getBoundingClientRect?.();
    setMenu({ at: e.type === 'contextmenu' || !r ? { x: e.clientX, y: e.clientY } : { x: r.left, y: r.bottom + 4 }, items });
  };
  const node = menu && <Menu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />;
  return [open, node];
}

export function Avatar({ name, email, photo, size = '' }) {
  return <div className={`avatar ${size}`} style={{ background: colorFor(email || name) }} title={email || name}>{photo ? <img src={photo} alt="" /> : initials(name || email)}</div>;
}

export function Toasts() {
  const toasts = store.use((s) => s.toasts);
  return <div className="toasts">{toasts.map((t) => (
    <div key={t.id} className={`toast ${t.kind || ''}`}>
      <span className="grow">{t.message}</span>
      {t.action && <button onClick={() => { t.action.onClick(); dismissToast(t.id); }}>{t.action.label}</button>}
      <button onClick={() => dismissToast(t.id)} aria-label="Dismiss"><X size={14} /></button>
    </div>
  ))}</div>;
}

marked.setOptions({ breaks: true, gfm: true });
/** Renders model output as safe Markdown. Links msg:ID and [#ID] cite messages. */
export function Markdown({ text, onOpenMessage }) {
  let src = String(text || '').replace(/\[#(\d+)\]/g, '[#$1](msg:$1)');
  const html = DOMPurify.sanitize(marked.parse(src), { ALLOWED_URI_REGEXP: /^(?:https?|mailto|msg):/i });
  return <div className="md" dangerouslySetInnerHTML={{ __html: html.replace(/<a href="msg:(\d+)">/g, '<a href="#" class="cite" data-msg="$1">') }}
    onClick={(e) => { const a = e.target.closest('a[data-msg]'); if (a) { e.preventDefault(); onOpenMessage?.(Number(a.dataset.msg)); } else if (e.target.closest('a')) { e.target.closest('a').target = '_blank'; } }} />;
}

export function Switch({ label, hint, checked, onChange }) {
  return <label className="switch"><span><div>{label}</div>{hint && <div className="small faint">{hint}</div>}</span><input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} /></label>;
}

export function Spinner({ size = 16 }) {
  return <svg className="spin" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 1 1-6.2-8.6" strokeLinecap="round" /></svg>;
}

export function Confirm({ title, message, confirmLabel = 'Confirm', danger, onConfirm, onClose }) {
  return <Modal title={title} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={() => { onConfirm(); onClose(); }}>{confirmLabel}</button></>}>
    <div>{message}</div>
  </Modal>;
}
