// Detection of quoted history in replies. Pure functions shared by the server (AI prompts) and the web reader.

// Attribution / header lines that start the quoted part. Tolerant of line breaks inside the line, because clients
// wrap long "On … wrote:" lines and Outlook puts From/Sent/To/Subject on separate lines.
const ATTRIBUTION = [
  String.raw`On\s[\s\S]{5,250}?\swrote:`,                                     // Gmail / Apple / Thunderbird (en)
  String.raw`(V|Dne)\s[\s\S]{5,250}?\snapisal(a|\(a\))?:`,                     // Slovenian
  String.raw`Am\s[\s\S]{5,250}?\sschrieb[\s\S]{0,60}?:`,                       // German
  String.raw`Le\s[\s\S]{5,250}?\sa\sécrit\s?:`,                                // French
];
const SEPARATOR = [
  String.raw`-{2,}\s*(Original Message|Izvirno sporočilo|Ursprüngliche Nachricht|Message d'origine|Forwarded message|Posredovano sporočilo)\s*-{2,}`,
  String.raw`(From|Od|Von|De)\s*:\s[\s\S]{1,300}?\s(Sent|Poslano|Gesendet|Envoyé|Date|Datum)\s*:\s`,   // Outlook header block
];

/** A whole line (or two/four joined lines) that starts the quote — strict, so normal sentences do not match. */
export const QUOTE_LINE = new RegExp(`^\\s*(?:(?:${ATTRIBUTION.join('|')})\\s*$|${SEPARATOR.join('|')}|_{20,}\\s*$)`, 'i');

/** Text that begins with an attribution/header (for HTML elements whose text continues with the quoted mail). */
export const QUOTE_HEAD = new RegExp(`^\\s*(?:${[...ATTRIBUTION, ...SEPARATOR].join('|')})`, 'i');

const isQuoteStart = (lines, i) => QUOTE_LINE.test(lines[i]) || (i + 1 < lines.length && QUOTE_LINE.test(`${lines[i]} ${lines[i + 1]}`)) ||
  (i + 3 < lines.length && /^\s*(From|Od|Von|De)\s*:/i.test(lines[i]) && QUOTE_LINE.test(lines.slice(i, i + 4).join(' ')));

/**
 * Splits a plain-text body into the new part and the quoted history.
 * Returns { own, quoted, lines } or null when there is nothing to fold (no quote, or nothing before it).
 */
export function splitPlainQuote(text) {
  const lines = String(text || '').split(/\r?\n/);
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isQuoteStart(lines, i)) { cut = i; break; }
    // A block of ">" lines running to the end of the message.
    if (/^\s*>/.test(lines[i]) && lines.slice(i).every((x) => !x.trim() || /^\s*>/.test(x))) { cut = i; break; }
  }
  if (cut <= 0 || !lines.slice(0, cut).join('').trim()) return null;
  return { own: lines.slice(0, cut).join('\n').trimEnd(), quoted: lines.slice(cut).join('\n'), lines: lines.length - cut };
}
