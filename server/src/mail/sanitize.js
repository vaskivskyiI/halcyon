import sanitizeHtml from 'sanitize-html';

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
  return { html: cleaned, blockedRemote: blocked };
}

export function htmlToText(html) {
  return sanitizeHtml(html || '', { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, ' ').trim();
}
