// Subjects for conversation grouping: reply / forward prefixes differ by language and client ("Re:", "AW:", "Odg.:",
// "SV:", "RE[2]:", "Fwd:", "Posl.:", "回复：") and may sit before or after list tags ("[list] Re: …"). Prefixes are
// dropped; tags are kept, as they often tell tickets apart ("[PROJ-123] Status" vs "[PROJ-124] Status").

const PREFIX = /^(?:re|aw|sv|vs|antw|antwort|odg|odgovor|odp|ynt|res|rif|r|wg|fw|fwd|tr|rv|enc|pd|posl|posr|ref|vb|vl|fs|doorst|ilt|ats|atb|bls|πρθ|σχετ|отв|ответ|пересл|答复|回复|转发|返信|転送)(?:\s*\[\d+\]|\s*\(\d+\))?\s*\.?\s*[:：]\s*|^\((?:fwd|fw)\)\s*/i;
const TAG = /^\[[^\]]{1,40}\]\s*/;

function parse(subject) {
  let s = String(subject || '').trim();
  const tags = [];
  let prefixed = false;
  for (let i = 0; i < 12; i++) {
    const p = s.match(PREFIX);
    if (p) { s = s.slice(p[0].length); prefixed = true; continue; }
    const t = s.match(TAG);
    if (t) { tags.push(t[0].trim()); s = s.slice(t[0].length); continue; }
    break;
  }
  return { base: [...tags, s.trim()].filter(Boolean).join(' '), prefixed };
}

/** Subject without reply/forward prefixes (list tags kept). */
export const baseSubject = (subject) => parse(subject).base;

/** Grouping key (lower case, single spaces), or null when too short to group on. */
export function subjectKey(subject) {
  const k = baseSubject(subject).toLowerCase().replace(/\s+/g, ' ').trim();
  return k.length >= 3 ? k : null;
}

/** True when the subject carries a reply / forward prefix. */
export const isReplySubject = (subject) => parse(subject).prefixed;
