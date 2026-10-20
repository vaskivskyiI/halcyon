import { useEffect, useRef, useState, useCallback } from 'react';
import {
  X, Minus, Maximize2, Minimize2, Send, Paperclip, Bold, Italic, Underline, Strikethrough, List, ListOrdered, Link2, Quote, RemoveFormatting,
  Sparkles, ChevronDown, Clock, FileText, Trash2, Wand2, Undo2, Languages, Image as ImageIcon,
} from 'lucide-react';
import { api, stream } from '../api.js';
import { store } from '../store.js';
import { toast, toastError, textToHtml, escapeHtml, addrFull, fileToBase64, fmtSize, fmtFull, htmlToText, toLocalInput } from '../util.js';
import { useMenu, Spinner, Modal } from '../components/common.jsx';

let seq = 0;
export function openComposer(init = {}) {
  const id = ++seq;
  store.set((s) => ({ composers: [...s.composers.map((c) => ({ ...c, minimized: true })), { id, init, minimized: false }] }));
  return id;
}
const closeComposer = (id) => store.set((s) => ({ composers: s.composers.filter((c) => c.id !== id) }));
const patchComposer = (id, patch) => store.set((s) => ({ composers: s.composers.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));

const mineSet = (accounts) => new Set(accounts.flatMap((a) => [a.email.toLowerCase(), ...(a.aliases || []).map((x) => (x.address || x).toLowerCase())]));

export function replyPayload(mode, msg, accounts, extra = {}) {
  const mine = mineSet(accounts);
  const fromMe = mine.has(msg.from.address?.toLowerCase());
  const base = msg.replyTo?.length ? msg.replyTo : [msg.from];
  let to = [], cc = [];
  if (mode === 'reply') to = fromMe ? msg.to : base;
  if (mode === 'replyAll') {
    to = fromMe ? msg.to : [...base, ...msg.to.filter((a) => !mine.has(a.address))];
    cc = msg.cc.filter((a) => !mine.has(a.address));
  }
  const dedupe = (l) => [...new Map(l.map((a) => [a.address.toLowerCase(), a])).values()];
  const prefix = mode === 'forward' ? 'Fwd: ' : 'Re: ';
  const subject = new RegExp(`^${prefix.trim()}`, 'i').test(msg.subject || '') ? msg.subject : `${prefix}${msg.subject || ''}`;
  const body = msg.html || textToHtml(msg.text || '');
  // data-quote marks where the user's own text ends: AI rewrite / drafting never touch what follows.
  const quote = mode === 'forward'
    ? `<div data-quote="1"><br>---------- Forwarded message ----------<br>From: ${escapeHtml(addrFull(msg.from))}<br>Date: ${fmtFull(msg.date)}<br>Subject: ${escapeHtml(msg.subject)}<br>To: ${escapeHtml(msg.to.map(addrFull).join(', '))}<br><br>${body}</div>`
    : `<div data-quote="1"><br><div>On ${fmtFull(msg.date)}, ${escapeHtml(addrFull(msg.from))} wrote:</div><blockquote>${body}</blockquote></div>`;
  return {
    accountId: msg.accountId, to: mode === 'forward' ? [] : dedupe(to), cc: dedupe(cc), subject,
    quoteHtml: quote, inReplyToId: mode === 'forward' ? null : msg.id, replyToMessage: mode !== 'forward' ? msg.id : null,
    attachments: mode === 'forward' ? (msg.attachments || []).map((a) => ({ fromMessageId: msg.id, index: a.index, filename: a.filename, size: a.size })) : [],
    ...extra,
  };
}

export default function ComposerDock() {
  const composers = store.use((s) => s.composers);
  return <div className="composer-dock">{composers.map((c) => <Composer key={c.id} id={c.id} init={c.init} minimized={c.minimized} />)}</div>;
}

const parseAddr = (s) => {
  const str = String(s).trim();
  if (/^[^\s<>"]+@[^\s<>"]+$/.test(str)) return { name: '', address: str.toLowerCase() };
  const m = str.match(/^"?([^"<]*?)"?\s*<([^\s<>]+@[^\s<>]+)>$/);
  return m ? { name: m[1].trim(), address: m[2].toLowerCase() } : null;
};
const validEmail = (a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a);

function RecipientInput({ value, onChange, autoFocus }) {
  const [text, setText] = useState('');
  const [sugs, setSugs] = useState([]);
  const [active, setActive] = useState(0);
  const timer = useRef();
  const latest = useRef('');
  latest.current = text;
  const commit = (raw = text) => {
    const parts = raw.split(/[,;\n](?=(?:[^"]*"[^"]*")*[^"]*$)/).map(parseAddr).filter(Boolean);
    if (parts.length) onChange([...value, ...parts.filter((p) => !value.some((v) => v.address === p.address))]);
    setText(''); setSugs([]);
  };
  const choose = (s) => { onChange([...value, { name: s.name, address: s.address }]); setText(''); setSugs([]); };
  useEffect(() => {
    clearTimeout(timer.current);
    setSugs([]);
    if (text.length < 2) return;
    const q = text;
    timer.current = setTimeout(() => api.get(`/api/contacts/autocomplete?q=${encodeURIComponent(q)}`).then((r) => {
      if (q !== latest.current) return; // ignore responses for outdated input
      setSugs(r.filter((x) => !value.some((v) => v.address === x.address))); setActive(0);
    }).catch(() => {}), 120);
  }, [text]);
  return (
    <div className="recipients">
      {value.map((a, i) => (
        <span key={a.address + i} className={`recipient ${validEmail(a.address) ? '' : 'invalid'}`} title={a.address}>
          {a.name || a.address}<button type="button" onClick={() => onChange(value.filter((_, j) => j !== i))}><X size={12} /></button>
        </span>
      ))}
      <input className="bare" value={text} autoFocus={autoFocus} onChange={(e) => setText(e.target.value)} onBlur={() => setTimeout(() => text && commit(), 150)}
        onPaste={(e) => { const t = e.clipboardData.getData('text'); if (/[,;\n]/.test(t)) { e.preventDefault(); commit(t); } }}
        onKeyDown={(e) => {
          if (sugs.length && e.key === 'ArrowDown') { e.preventDefault(); setActive((active + 1) % sugs.length); }
          else if (sugs.length && e.key === 'ArrowUp') { e.preventDefault(); setActive((active - 1 + sugs.length) % sugs.length); }
          else if ((e.key === 'Enter' || e.key === 'Tab') && sugs.length) { e.preventDefault(); choose(sugs[active]); }
          else if (['Enter', ',', ';'].includes(e.key) && text) { e.preventDefault(); commit(); }
          else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
        }} />
      {sugs.length > 0 && <div className="suggest">{sugs.map((s, i) => (
        <div key={s.address} className={i === active ? 'active' : ''} onMouseDown={(e) => { e.preventDefault(); choose(s); }}>
          <span>{s.name}</span><span className="small faint">{s.address}</span>
        </div>))}</div>}
    </div>
  );
}

const REWRITES = [['improve', 'Improve writing'], ['fix', 'Fix spelling & grammar'], ['shorten', 'Make shorter'], ['expand', 'Make longer'], ['formal', 'More formal'], ['friendly', 'More friendly'], ['confident', 'More confident'], ['bullet', 'Use bullet points']];
const LANGS = ['English', 'Slovenian', 'German', 'French', 'Spanish', 'Italian', 'Croatian', 'Serbian', 'Ukrainian', 'Polish'];

function Composer({ id, init, minimized }) {
  const accounts = store.use((s) => s.accounts);
  const settings = store.use((s) => s.settings);
  const space = store.get().space;
  const inSpace = accounts.filter((a) => !space || !a.space || a.space === space);
  const [accountId, setAccountId] = useState(init.accountId || (inSpace.some((a) => a.id === settings.mail.defaultAccountId) ? settings.mail.defaultAccountId : inSpace[0]?.id) || accounts[0]?.id);
  const account = accounts.find((a) => a.id === Number(accountId)) || accounts[0];
  const [to, setTo] = useState(init.to?.map((a) => (typeof a === 'string' ? parseAddr(a) : a)).filter(Boolean) || []);
  const [cc, setCc] = useState(init.cc?.map((a) => (typeof a === 'string' ? parseAddr(a) : a)).filter(Boolean) || []);
  const [bcc, setBcc] = useState(init.bcc?.map((a) => (typeof a === 'string' ? parseAddr(a) : a)).filter(Boolean) || []);
  const [showCc, setShowCc] = useState(!!(init.cc?.length || init.bcc?.length));
  const [subject, setSubject] = useState(init.subject || '');
  const [attachments, setAttachments] = useState(init.attachments || []);
  const [max, setMax] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [undoHtml, setUndoHtml] = useState(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [draftId, setDraftId] = useState(init.draftId || null);
  const [dirty, setDirty] = useState(false);
  const [templates, setTemplates] = useState([]);
  const editor = useRef();
  const abort = useRef();
  const fileInput = useRef();
  const [openMenu, menuNode] = useMenu();
  const isReply = !!init.inReplyToId;

  const signature = (acc) => (acc?.signatureHtml ? `<div class="signature"><br>-- <br>${acc.signatureHtml}</div>` : '');

  useEffect(() => {
    const html = init.html != null ? init.html : `${init.prefixHtml || '<p><br></p>'}${signature(account)}${init.quoteHtml || ''}`;
    editor.current.innerHTML = html;
    api.get('/api/templates').then(setTemplates).catch(() => {});
    if (init.aiIntent !== undefined) runAiReply(init.aiIntent);
    else if (!isReply || to.length) placeCaret();
  }, []);

  const placeCaret = () => {
    const el = editor.current;
    el.focus();
    const r = document.createRange();
    r.setStart(el.firstChild || el, 0); r.collapse(true);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  };

  // Body = editor content up to the signature or the quoted/forwarded message, so AI only changes the user's text.
  const bodyParts = () => {
    const el = editor.current;
    const top = (n) => { while (n && n.parentNode !== el) n = n.parentNode; return n; };
    const marker = el.querySelector('.signature, [data-quote]');
    // Drafts written before the marker existed: find the "wrote:" / "Forwarded message" line or the first blockquote.
    const legacy = !marker && ([...el.querySelectorAll('div, p')].find((n) => /^\s*(On .{5,200} wrote:|-{5,} Forwarded message -{5,})/.test(n.textContent || '')) || el.querySelector('blockquote'));
    return { el, quoteStart: top(marker || legacy) || null };
  };
  const setBodyText = (text, { html } = {}) => {
    const { el, quoteStart } = bodyParts();
    const nodes = [];
    for (const n of [...el.childNodes]) { if (n === quoteStart) break; nodes.push(n); }
    nodes.forEach((n) => n.remove());
    const wrap = document.createElement('div');
    wrap.innerHTML = html || textToHtml(text);
    const frag = document.createDocumentFragment();
    [...wrap.childNodes].forEach((n) => frag.appendChild(n));
    el.insertBefore(frag, el.firstChild);
    setDirty(true);
  };
  const userText = () => {
    const { el, quoteStart } = bodyParts();
    const d = document.createElement('div');
    for (const n of [...el.childNodes]) { if (n === quoteStart) break; d.appendChild(n.cloneNode(true)); }
    return d.innerText.trim();
  };

  async function runAiReply(intent) {
    setAiBusy(true); setUndoHtml(editor.current.innerHTML);
    const ctl = new AbortController(); abort.current = ctl;
    try {
      if (intent === null) {
        const r = await api.post('/api/ai/draft-reply', { messageId: init.inReplyToId });
        setBodyText(r.text);
      } else {
        let out = '';
        await stream('/api/ai/draft-reply', { messageId: init.inReplyToId, intent: intent || null, stream: true }, { signal: ctl.signal, onToken: (t) => { out += t; setBodyText(out); } });
      }
    } catch (e) { if (e.name !== 'AbortError') toastError(e); } finally { setAiBusy(false); }
  }

  const runAiCompose = async () => {
    const instruction = aiPrompt.trim();
    if (!instruction) return;
    if (isReply) { setAiPrompt(''); return runAiReply(instruction); }
    setAiBusy(true); setUndoHtml(editor.current.innerHTML);
    const ctl = new AbortController(); abort.current = ctl;
    try {
      let out = '';
      const r = await stream('/api/ai/compose', { instruction, to: to.map(addrFull).join(', ') }, {
        signal: ctl.signal,
        onToken: (t) => { out += t; const m = out.match(/^\s*Subject:\s*(.+)\n+([\s\S]*)$/i); setBodyText(m ? m[2] : out.replace(/^\s*Subject:.*$/im, '')); },
      });
      if (r.subject && !subject) setSubject(r.subject);
      setBodyText(r.body);
      setAiPrompt('');
    } catch (e) { if (e.name !== 'AbortError') toastError(e); } finally { setAiBusy(false); }
  };

  const runRewrite = async (mode, language) => {
    const sel = getSelection();
    const inEditor = sel.rangeCount && editor.current.contains(sel.anchorNode) && !sel.isCollapsed;
    const range = inEditor ? sel.getRangeAt(0).cloneRange() : null;
    const text = inEditor ? sel.toString() : userText();
    if (!text.trim()) return toast('Write something first, or select text to rewrite');
    setAiBusy(true); setUndoHtml(editor.current.innerHTML);
    try {
      let out = '';
      let node;
      if (range) { range.deleteContents(); node = document.createElement('span'); range.insertNode(node); }
      const result = await stream('/api/ai/rewrite', { text, mode, language }, { onToken: (t) => { out += t; if (node) node.innerText = out; else setBodyText(out); } });
      if (node) node.innerText = result; else setBodyText(result);
      setDirty(true);
    } catch (e) { toastError(e); } finally { setAiBusy(false); }
  };

  const exec = (cmd, val) => { editor.current.focus(); document.execCommand(cmd, false, val); setDirty(true); };

  const payload = () => ({
    accountId: account?.id, from: { address: account?.email, name: account?.displayName || '' }, to, cc, bcc, subject,
    html: editor.current.innerHTML, inReplyToId: init.inReplyToId || null,
    attachments: attachments.map((a) => (a.fromMessageId != null ? { fromMessageId: a.fromMessageId, index: a.index, filename: a.filename } : { filename: a.filename, contentType: a.contentType, contentBase64: a.contentBase64 })),
    draftId,
  });

  // Autosave
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(async () => {
      try {
        const p = payload();
        const r = await api.post('/api/drafts', { ...p, id: draftId, quoteHtml: undefined, attachments: p.attachments.filter((a) => a.fromMessageId != null || (a.contentBase64?.length || 0) < 2e6) });
        setDraftId(r.id); setDirty(false);
      } catch { /* offline */ }
    }, 2500);
    return () => clearTimeout(t);
  }, [dirty, to, cc, bcc, subject, attachments]);

  const send = async (sendAt) => {
    if (!to.length && !cc.length && !bcc.length) return toast('Add at least one recipient', { kind: 'error' });
    const bad = [...to, ...cc, ...bcc].find((a) => !validEmail(a.address));
    if (bad) return toast(`Invalid address: ${bad.address}`, { kind: 'error' });
    if (!subject && !confirm('Send without a subject?')) return;
    const text = htmlToText(editor.current.innerHTML);
    if (/\battach(ed|ment)|\bpriložen|\banbei|\bpièce jointe/i.test(text.split(/On .* wrote:/)[0]) && !attachments.length && !confirm('You mentioned an attachment but none is attached. Send anyway?')) return;
    const p = payload();
    try {
      const r = await api.post('/api/send', sendAt ? { ...p, sendAt } : p);
      closeComposer(id);
      if (sendAt) toast(`Scheduled for ${new Date(sendAt).toLocaleString()}`);
      else if (settings.mail.undoSendSeconds > 0) {
        toast('Sending…', {
          duration: settings.mail.undoSendSeconds * 1000,
          action: { label: 'Undo', onClick: async () => { try { const c = await api.post(`/api/outbox/${r.id}/cancel`); openComposer({ ...c.payload, to: c.payload.to, html: c.payload.html, draftId: null }); } catch { toast('Too late — message already sent', { kind: 'error' }); } } },
        });
      } else toast('Sent');
    } catch (e) { toastError(e); }
  };

  const discard = async () => {
    abort.current?.abort();
    if (draftId) await api.del(`/api/drafts/${draftId}`).catch(() => {});
    closeComposer(id);
  };

  const addFiles = async (files) => {
    const list = [];
    for (const f of files) {
      if (f.size > 25 * 1024 * 1024) { toast(`${f.name} is larger than 25 MB`, { kind: 'error' }); continue; }
      list.push({ filename: f.name, contentType: f.type || 'application/octet-stream', size: f.size, contentBase64: await fileToBase64(f) });
    }
    setAttachments((a) => [...a, ...list]); setDirty(true);
  };

  const insertLink = () => { const url = prompt('Link URL', 'https://'); if (url) exec('createLink', url); };
  const insertImage = () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.onchange = async () => { const f = input.files[0]; if (f) exec('insertImage', `data:${f.type};base64,${await fileToBase64(f)}`); };
    input.click();
  };

  const onAccountChange = (newId) => {
    const next = accounts.find((a) => a.id === Number(newId));
    const sig = editor.current.querySelector('.signature');
    if (sig) sig.outerHTML = signature(next) || '';
    setAccountId(Number(newId));
  };

  if (minimized) {
    return <div className="composer min"><div className="composer-head" onClick={() => patchComposer(id, { minimized: false })}><span className="grow truncate">{subject || 'New message'}</span><button className="icon-btn" onClick={(e) => { e.stopPropagation(); discard(); }}><X size={16} /></button></div></div>;
  }

  return (
    <div className={`composer ${max ? 'max' : ''}`} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); addFiles([...e.dataTransfer.files]); } }}
      onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } if (e.key === 'Escape') patchComposer(id, { minimized: true }); }}>
      <div className="composer-head" onClick={() => patchComposer(id, { minimized: true })}>
        <span className="grow truncate">{subject || (isReply ? 'Reply' : 'New message')}</span>
        {dirty ? <span className="small faint">Saving…</span> : draftId ? <span className="small faint">Draft saved</span> : null}
        <button className="icon-btn" onClick={(e) => { e.stopPropagation(); patchComposer(id, { minimized: true }); }} title="Minimize"><Minus size={16} /></button>
        <button className="icon-btn" onClick={(e) => { e.stopPropagation(); setMax(!max); }} title="Maximize">{max ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
        <button className="icon-btn" onClick={(e) => { e.stopPropagation(); discard(); }} title="Discard"><X size={16} /></button>
      </div>
      <div className="composer-fields">
        {accounts.length > 1 && <div><label>From</label><select className="bare" value={account?.id} onChange={(e) => onAccountChange(e.target.value)}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.displayName ? `${a.displayName} <${a.email}>` : a.email}</option>)}</select></div>}
        <div><label>To</label><RecipientInput value={to} onChange={(v) => { setTo(v); setDirty(true); }} autoFocus={!to.length} />{!showCc && <button className="btn ghost sm" onClick={() => setShowCc(true)}>Cc/Bcc</button>}</div>
        {showCc && <div><label>Cc</label><RecipientInput value={cc} onChange={(v) => { setCc(v); setDirty(true); }} /></div>}
        {showCc && <div><label>Bcc</label><RecipientInput value={bcc} onChange={(v) => { setBcc(v); setDirty(true); }} /></div>}
        <div><label>Subject</label><input className="bare" value={subject} onChange={(e) => { setSubject(e.target.value); setDirty(true); }} /></div>
      </div>
      <div className="editor-toolbar">
        <button className="icon-btn" title="Bold" onMouseDown={(e) => { e.preventDefault(); exec('bold'); }}><Bold size={15} /></button>
        <button className="icon-btn" title="Italic" onMouseDown={(e) => { e.preventDefault(); exec('italic'); }}><Italic size={15} /></button>
        <button className="icon-btn" title="Underline" onMouseDown={(e) => { e.preventDefault(); exec('underline'); }}><Underline size={15} /></button>
        <button className="icon-btn" title="Strikethrough" onMouseDown={(e) => { e.preventDefault(); exec('strikeThrough'); }}><Strikethrough size={15} /></button>
        <button className="icon-btn" title="Bulleted list" onMouseDown={(e) => { e.preventDefault(); exec('insertUnorderedList'); }}><List size={15} /></button>
        <button className="icon-btn" title="Numbered list" onMouseDown={(e) => { e.preventDefault(); exec('insertOrderedList'); }}><ListOrdered size={15} /></button>
        <button className="icon-btn" title="Quote" onMouseDown={(e) => { e.preventDefault(); exec('formatBlock', 'blockquote'); }}><Quote size={15} /></button>
        <button className="icon-btn" title="Link" onMouseDown={(e) => { e.preventDefault(); insertLink(); }}><Link2 size={15} /></button>
        <button className="icon-btn" title="Inline image" onMouseDown={(e) => { e.preventDefault(); insertImage(); }}><ImageIcon size={15} /></button>
        <button className="icon-btn" title="Clear formatting" onMouseDown={(e) => { e.preventDefault(); exec('removeFormat'); }}><RemoveFormatting size={15} /></button>
        <span className="grow" />
        {templates.length > 0 && <button className="btn ghost sm" onClick={(e) => openMenu(e, templates.map((t) => ({ label: t.name, icon: FileText, onClick: () => { if (t.subject && !subject) setSubject(t.subject); setBodyText(null, { html: t.bodyHtml }); } })))}><FileText size={14} /> Templates</button>}
        {settings.ai.enabled && <button className="btn ai sm" disabled={aiBusy} onClick={(e) => openMenu(e, [
          { section: 'Rewrite (selection or whole text)' },
          ...REWRITES.map(([mode, label]) => ({ label, icon: Wand2, onClick: () => runRewrite(mode) })),
          { section: 'Translate to' },
          ...LANGS.map((l) => ({ label: l, icon: Languages, onClick: () => runRewrite('translate', l) })),
        ])}><Wand2 size={14} /> Rewrite <ChevronDown size={12} /></button>}
      </div>
      <div ref={editor} className="editor" contentEditable suppressContentEditableWarning onInput={() => setDirty(true)}
        onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); addFiles([...e.clipboardData.files]); } }} />
      {attachments.length > 0 && <div className="att-list">{attachments.map((a, i) => (
        <span key={i} className="chip"><Paperclip size={12} /> {a.filename} {a.size ? `· ${fmtSize(a.size)}` : ''}<button className="icon-btn" style={{ width: 18, height: 18 }} onClick={() => setAttachments(attachments.filter((_, j) => j !== i))}><X size={12} /></button></span>
      ))}</div>}
      {settings.ai.enabled && (
        <div className="ai-bar">
          <Sparkles size={16} color="var(--ai)" />
          <input className="input" style={{ height: 30 }} placeholder={isReply ? 'Tell AI how to reply (e.g. "accept, propose Thursday 2pm")…' : 'Describe the email you want AI to write…'} value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runAiCompose(); } }} disabled={aiBusy} />
          {aiBusy ? <button className="btn sm" onClick={() => abort.current?.abort()}><Spinner size={13} /> Stop</button>
            : <button className="btn sm ai" onClick={runAiCompose} disabled={!aiPrompt.trim() && !isReply}>{isReply && !aiPrompt.trim() ? 'Draft reply' : 'Write'}</button>}
          {isReply && !aiPrompt && !aiBusy && <button className="btn sm ghost" onClick={() => runAiReply('')}>Auto-draft</button>}
          {undoHtml && !aiBusy && <button className="btn sm ghost" title="Undo AI change" onClick={() => { editor.current.innerHTML = undoHtml; setUndoHtml(null); }}><Undo2 size={13} /></button>}
        </div>
      )}
      <div className="composer-foot">
        <div className="row" style={{ gap: 0 }}>
          <button className="btn primary" style={{ borderRadius: '8px 0 0 8px' }} onClick={() => send()}><Send size={15} /> Send</button>
          <button className="btn primary" style={{ borderRadius: '0 8px 8px 0', padding: '0 6px', borderLeft: '1px solid rgb(255 255 255 / 30%)' }} title="Schedule send" onClick={(e) => openMenu(e, [
            { section: 'Schedule send' },
            ...scheduleOptions().map(([l, t]) => ({ label: l, hint: new Date(t).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }), icon: Clock, onClick: () => send(t) })),
            { label: 'Pick date & time…', icon: Clock, onClick: () => setScheduleOpen(true) },
          ])}><ChevronDown size={15} /></button>
        </div>
        <button className="icon-btn" title="Attach files" onClick={() => fileInput.current.click()}><Paperclip size={17} /></button>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { addFiles([...e.target.files]); e.target.value = ''; }} />
        <span className="grow" />
        <button className="icon-btn" title="Discard draft" onClick={discard}><Trash2 size={17} /></button>
      </div>
      {menuNode}
      {scheduleOpen && <ScheduleModal onClose={() => setScheduleOpen(false)} onPick={(t) => { setScheduleOpen(false); send(t); }} />}
    </div>
  );
}

function scheduleOptions() {
  const d = new Date();
  const at = (days, h) => { const x = new Date(d); x.setDate(x.getDate() + days); x.setHours(h, 0, 0, 0); return x.getTime(); };
  const mon = (1 - d.getDay() + 7) % 7 || 7;
  return [['Tomorrow morning', at(1, 8)], ['Tomorrow afternoon', at(1, 13)], ['Monday morning', at(mon, 8)]];
}

function ScheduleModal({ onClose, onPick }) {
  const [v, setV] = useState(toLocalInput(Date.now() + 3600e3));
  return <Modal title="Schedule send" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => onPick(new Date(v).getTime())}>Schedule</button></>}>
    <input className="input" type="datetime-local" value={v} onChange={(e) => setV(e.target.value)} />
  </Modal>;
}
