import sanitizeHtml from 'sanitize-html';
import { convert } from 'html-to-text';

// Produces safe HTML for display. Remote images are neutralised unless allowed; cid: refs are rewritten
// to the attachment endpoint. Output is additionally rendered in a sandboxed iframe on the client.
export function sanitizeEmailHtml(html, { messageId, allowRemote = false } = {}) {
  let blocked = 0;
  const out = sanitizeHtml(html || '', {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'span', 'center', 'font', 'style', 'del', 'ins', 'small', 'big', 'u', 's', 'sub', 'sup', 'h1', 'h2', 'col', 'colgroup']),
    disallowedTagsMode: 'discard',
    allowVulnerableTags: true, // <style> is allowed; the iframe sandbox contains it.
    allowedAttributes: {
      '*': ['style', 'class', 'align', 'valign', 'width', 'height', 'bgcolor', 'color', 'dir', 'lang', 'title', 'border', 'cellpadding', 'cellspacing', 'colspan', 'rowspan', 'face', 'size', 'id', 'role'],
      div: ['data-quote', 'style', 'class', 'align', 'dir', 'lang', 'id'], // data-quote marks the quoted part of Halcyon replies
      a: ['href', 'name', 'target', 'rel', 'style'],
      img: ['src', 'alt', 'width', 'height', 'style', 'data-remote-src'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel', 'cid', 'data'],
    allowedSchemesByTag: { img: ['http', 'https', 'cid', 'data'] },
    transformTags: {
      a: (tag, attribs) => ({ tagName: 'a', attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' } }),
      img: (tag, attribs) => {
        const src = attribs.src || '';
        if (src.startsWith('cid:') && messageId) return { tagName: 'img', attribs: { ...attribs, src: `/api/messages/${messageId}/cid/${encodeURIComponent(src.slice(4))}` } };
        if (/^https?:/i.test(src) && !allowRemote) {
          blocked++;
          return { tagName: 'img', attribs: { ...attribs, src: '', 'data-remote-src': src } };
        }
        return { tagName: 'img', attribs };
      },
    },
  });
  // Strip CSS url() remote loads too (tracking via background images).
  const cleaned = allowRemote ? out : out.replace(/url\(\s*['"]?https?:[^)]*\)/gi, () => { blocked++; return 'none'; });
  return { html: linkifyHtml(cleaned, ' target="_blank" rel="noopener noreferrer"'), blockedRemote: blocked };
}

// Web addresses written as text: http(s)://… or www.…, without the punctuation that ends a sentence (a closing bracket
// only when the address has no opening one).
const URL_RE = /\b(?:https?:\/\/|www\.)(?:(?!&(?:lt|gt|quot|#39|#34|nbsp);)[^\s<>"'])+/gi;
function trimUrl(u) {
  let end = u.length;
  while (end && /[.,;:!?'*)\]]/.test(u[end - 1])) {
    if (u[end - 1] === ')' && (u.slice(0, end).match(/\(/g) || []).length >= (u.slice(0, end).match(/\)/g) || []).length) break;
    end--;
  }
  return end;
}
export function linkifyText(escaped, attrs = '') {
  return escaped.replace(URL_RE, (m) => {
    const end = trimUrl(m), url = m.slice(0, end), rest = m.slice(end);
    if (!/\w\.\w/.test(url)) return m;
    const href = /^www\./i.test(url) ? `http://${url}` : url;
    return `<a href="${href.replace(/"/g, '&quot;')}"${attrs}>${url}</a>${rest}`;
  });
}

/** Addresses in the text of HTML become links (not inside links, styles, scripts or attributes). */
export function linkifyHtml(html, attrs = '') {
  if (!html || !/https?:\/\/|www\./i.test(html)) return html;
  let skip = 0;
  return html.split(/(<[^>]*>)/).map((part) => {
    if (part.startsWith('<')) {
      const m = part.match(/^<(\/?)(a|style|script|title|textarea)\b/i);
      if (m) skip = Math.max(0, skip + (m[1] ? -1 : 1));
      return part;
    }
    return skip ? part : linkifyText(part, attrs);
  }).join('');
}

/** The plain-text part of a message (and plain-text messages): paragraphs, lists, quotes ("> ") and link addresses kept. */
export const mailText = (html) => convert(html || '', {
  wordwrap: false,
  selectors: [
    { selector: 'img', format: 'skip' },
    { selector: 'a', options: { hideLinkHrefIfSameAsText: true, linkBrackets: ['<', '>'] } },
    { selector: 'h1', options: { uppercase: false } }, { selector: 'h2', options: { uppercase: false } }, { selector: 'h3', options: { uppercase: false } },
    { selector: 'table', format: 'dataTable' },
  ],
}).replace(/\n{3,}/g, '\n\n').trim();

export function htmlToText(html) {
  return sanitizeHtml(html || '', { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, ' ').trim();
}
