// Summaries say what matters, not who wrote or what the subject was: the model is asked for that (prompts.js), and the
// common openings it still produces are taken off here ("Ana Novak asks you to send …" → "Send …").

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cap = (s) => (s ? s[0].toLocaleUpperCase() + s.slice(1) : s);
const norm = (s) => String(s || '').toLowerCase().replace(/^(re|fwd?|aw|odg|sv)\s*:\s*/gi, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// "<who> asks you to X" → "X" (an instruction); "<who> says that X" → "X" (a statement). Invitations, reminders,
// thanks etc. keep their verb, which carries the meaning.
const ASK = '(?:asks|requests|wants|would like|needs)(?: you)?(?: to)?';
const TELL = '(?:says|writes|informs(?: you)?|notifies(?: you)?|reports|mentions|confirms|announces|explains|shares)(?: that)?';
const GENERIC = '(?:the|this) (?:e-?mail|message|sender)(?: from [^,.:]{1,60})?';

export function cleanSummary(summary, { fromName, fromAddr, subject } = {}) {
  let s = String(summary || '').trim();
  if (!s) return s;
  fromName = String(fromName || ''); fromAddr = String(fromAddr || ''); subject = String(subject || '');
  const names = [fromName, fromName.split(/\s+/)[0], String(fromAddr).split('@')[0]].filter((n) => n && n.length >= 2).map(esc);
  const who = [GENERIC, ...names].join('|');
  const lead = new RegExp(`^(?:${who})\\s*(?:\\([^)]*\\))?[,:]?\\s+(?:(${ASK})|(${TELL})|(?:is |was )?(?:about|regarding)|(?:is|was) (?:asking|requesting) (?:you )?(?:to )?)\\s*:?\\s*`, 'iu');
  const m = s.match(lead);
  if (m) s = cap(s.slice(m[0].length));
  // "Regarding <subject>: …" / "<subject>: …" openings that only restate the subject.
  if (subject) {
    const subj = norm(subject);
    const colon = s.indexOf(':');
    if (colon > 0 && colon < 120 && subj && norm(s.slice(0, colon)).replace(/^(regarding|about|re) /, '') === subj) s = cap(s.slice(colon + 1).trim());
  }
  return s;
}
