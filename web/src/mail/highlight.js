// Search words shown in the messages found: the words and phrases of the query (and subject: / body: values), matched
// as the search does — from the start of a word, any case, accents ignored (the index folds them too).
import { createElement, useMemo } from 'react';
import { store } from '../store.js';

const KEPT = new Set(['subject', 'body', 'title', 'text']);

export function searchTerms(q) {
  const out = [];
  const re = /(-?)(\w+): ?(\([^)]*\)|"[^"]*"|\S+)|(-?)"([^"]+)"|(\S+)/g;
  let m, not = false;
  while ((m = re.exec(q || ''))) {
    const word = m[6];
    if (word === 'NOT') { not = true; continue; }
    if (word === 'AND' || word === 'OR') continue;
    const neg = not || m[1] === '-' || m[4] === '-' || word?.startsWith('-');
    not = false;
    if (neg) continue;
    if (m[2]) { if (KEPT.has(m[2].toLowerCase())) out.push(...m[3].replace(/^[("]|[)"]$/g, '').split(/\s+/)); continue; }
    out.push(m[5] || word);
  }
  return [...new Set(out.map((t) => fold(t.replace(/[^\p{L}\p{N}\s'’.@-]/gu, '').trim())).filter((t) => t.length > 1))];
}

const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const wordChar = (c) => !!c && /[\p{L}\p{N}]/u.test(c);

/** The words of the search the open message was found with ([] when none). */
export function useHits() {
  const q = store.use((s) => s.searchHighlight);
  return useMemo(() => searchTerms(q), [q]);
}

/** [start, end) of each match in text. */
function matches(text, terms) {
  if (!terms.length || !text) return [];
  // The folded text with, for each of its characters, where it came from.
  let f = '';
  const at = [];
  for (let i = 0; i < text.length; i++) { const c = fold(text[i]); f += c; for (let k = 0; k < c.length; k++) at.push(i); }
  at.push(text.length);
  const out = [];
  for (const t of terms) {
    for (let i = f.indexOf(t); i >= 0; i = f.indexOf(t, i + t.length)) if (!wordChar(f[i - 1])) out.push([at[i], at[i + t.length]]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out.filter((r, i) => !i || r[0] >= out[i - 1][1]);
}

export const hasHit = (text, terms) => matches(text, terms).length > 0;

/** Text as React nodes with the matches in <mark>. */
export function markText(text, terms) {
  const ms = matches(text, terms);
  if (!ms.length) return text;
  const out = [];
  let pos = 0;
  ms.forEach(([a, b], i) => { if (a > pos) out.push(text.slice(pos, a)); out.push(createElement('mark', { key: i, className: 'hit' }, text.slice(a, b))); pos = b; });
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}

/** Marks the matches in a document's text (an email's HTML); returns the marks. */
export function markDom(root, terms) {
  if (!root || !terms.length) return [];
  const doc = root.ownerDocument;
  const walk = doc.createTreeWalker(root, 4, { acceptNode: (n) => (/^(SCRIPT|STYLE|MARK)$/.test(n.parentNode?.nodeName) ? 2 : 1) });
  const nodes = [];
  while (walk.nextNode()) nodes.push(walk.currentNode);
  const marks = [];
  for (const n of nodes) {
    const ms = matches(n.data, terms), here = [];
    for (let k = ms.length - 1; k >= 0; k--) {
      const [a, b] = ms[k];
      const hit = n.splitText(a);
      hit.splitText(b - a);
      const mark = doc.createElement('mark');
      mark.className = 'hit';
      hit.replaceWith(mark);
      mark.appendChild(hit);
      here.unshift(mark);
    }
    marks.push(...here);
  }
  return marks;
}

/** Removes what markDom added. */
export function unmarkDom(root) {
  for (const m of root?.querySelectorAll('mark.hit') || []) m.replaceWith(...m.childNodes);
  root?.normalize();
}
