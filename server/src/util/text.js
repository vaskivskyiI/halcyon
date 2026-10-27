// Small text helpers shared by mail composition, the MCP server and the AI's matching of words.

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Plain text as simple HTML: paragraphs at blank lines, line breaks inside them. */
export const textToHtml = (s) => String(s ?? '').split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');

// Words that say nothing about what an email is about (en; short words are dropped anyway).
const STOP = new Set('the and for with that this from your you are was were have has not but all any can will our their they them about into only also than then there what when which who why how more most some such very just like dear best regards thanks thank please email mail message'.split(' '));

/** The meaningful words of a text (4+ letters, any alphabet, lower-case), as a set. */
export const keywords = (s) => new Set((String(s || '').toLowerCase().match(/\p{L}{4,}/gu) || []).filter((w) => !STOP.has(w)));
