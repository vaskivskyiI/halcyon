// Due dates written in plain language, for tasks: "call Ana tomorrow at 10", "report by Friday",
// "pošlji poročilo v torek ob 9", "in 3 days", "21.10.", "Oct 21 15:30". English and Slovenian.
// Returns { title, due } with due in epoch ms (null when no date was found). Times are wall-clock in tz.
import { localToEpoch } from './time.js';

const WEEKDAYS = [
  ['sunday', 'sun', 'nedelja', 'nedeljo', 'ned'], ['monday', 'mon', 'ponedeljek', 'pon'], ['tuesday', 'tue', 'tues', 'torek', 'tor'],
  ['wednesday', 'wed', 'sreda', 'sredo', 'sre'], ['thursday', 'thu', 'thur', 'thurs', 'četrtek', 'cetrtek', 'čet'], ['friday', 'fri', 'petek', 'pet'],
  ['saturday', 'sat', 'sobota', 'soboto', 'sob'],
];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'ma[yj]', 'jun', 'jul', 'aug|avg', 'sep', 'oct|okt', 'nov', 'dec'];
const DEFAULT_TIME = '09:00';

// Parts of the user's local calendar date for an instant.
function localParts(t, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
const ymd = (y, m, d) => { const x = new Date(Date.UTC(y, m - 1, d)); return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`; };

export function parseDue(text, tz = 'UTC', now = Date.now()) {
  let s = ` ${String(text || '').trim()} `;
  const today = localParts(now, tz);
  let date = null, time = null;
  const take = (re, fn) => { const m = s.match(re); if (!m) return false; const r = fn(m); if (r === false) return false; s = s.replace(m[0], ' '); return true; };

  // --- time: "at 10", "ob 10:30", "10am", "3 pm", "15:00", "noon", "opoldne"
  // "10:30" anywhere, "10.30" only after at/ob (otherwise it is a date such as 21.10.).
  take(/\s(?:(?:at|ob|@)\s*(\d{1,2})[:.](\d{2})|(\d{1,2}):(\d{2}))\s*(am|pm)?(?=\s|[,!?]|\.(?!\d)|$)/i, (m) => {
    let h = +(m[1] ?? m[3]); const min = m[2] ?? m[4]; const ap = m[5]?.toLowerCase();
    if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
    if (h > 23 || +min > 59) return false;
    time = `${h}:${min}`;
  })
    || take(/\s(?:at\s+)?(\d{1,2})\s*(am|pm)(?=\s|[,.!?]|$)/i, (m) => { let h = +m[1] % 12; if (m[2].toLowerCase() === 'pm') h += 12; time = `${h}:00`; })
    || take(/\s(?:at|ob)\s+(\d{1,2})(?:h| uri)?(?=\s|[,.!?]|$)/i, (m) => { if (+m[1] > 23) return false; time = `${m[1]}:00`; })
    || take(/\s(?:at\s+)?(noon|midday|opoldne)(?=\s|$)/i, () => { time = '12:00'; });

  // --- relative days
  take(/\s(?:the\s+)?day after tomorrow|\spojutrišnjem|\spojutrisnjem/i, () => { date = ymd(today.y, today.m, today.d + 2); })
    || take(/\s(?:by\s+|until\s+|do\s+)?(?:tomorrow|jutri)(?:\s+(morning|afternoon|evening|zjutraj|popoldne|zvečer))?(?=\s|[,.!?]|$)/i, (m) => {
      date = ymd(today.y, today.m, today.d + 1);
      if (!time && m[1]) time = /morning|zjutraj/i.test(m[1]) ? '09:00' : /afternoon|popoldne/i.test(m[1]) ? '14:00' : '18:00';
    })
    || take(/\s(?:by\s+|until\s+|do\s+)?(?:today|tonight|danes|nocoj|this evening)(?=\s|[,.!?]|$)/i, (m) => { date = ymd(today.y, today.m, today.d); if (!time && /tonight|nocoj|evening/i.test(m[0])) time = '19:00'; })
    || take(/\s(?:in|čez|cez)\s+(\d{1,3})\s+(days?|dni|dan|weeks?|tednov|tedna|teden|months?|mesecev|meseca|mesec)(?=\s|[,.!?]|$)/i, (m) => {
      const n = +m[1], unit = m[2].toLowerCase();
      date = /^(week|ted)/.test(unit) ? ymd(today.y, today.m, today.d + 7 * n) : /^(month|mese)/.test(unit) ? ymd(today.y, today.m + n, today.d) : ymd(today.y, today.m, today.d + n);
    })
    || take(/\s(?:by\s+|until\s+|do\s+)?(?:the\s+)?(?:end of (?:the )?week|eow|konec tedna|konca tedna)(?=\s|[,.!?]|$)/i, () => { date = ymd(today.y, today.m, today.d + ((5 - today.wd + 7) % 7)); if (!time) time = '17:00'; })
    || take(/\s(?:next week|naslednji teden|prihodnji teden)(?=\s|[,.!?]|$)/i, () => { date = ymd(today.y, today.m, today.d + ((1 - today.wd + 7) % 7 || 7)); });

  // --- weekday: "(on|by|next|v|do|ta|naslednji) friday"
  if (!date) {
    for (let wd = 0; wd < 7 && !date; wd++) {
      const names = WEEKDAYS[wd].join('|');
      take(new RegExp(`\\s(?:(?:on|by|until|this|next|v|vo|do|na|ta|to|naslednji|naslednjo|prihodnji|prihodnjo)\\s+)?(${names})\\.?(?=\\s|[,.!?]|$)`, 'i'), (m) => {
        // The next occurrence of that weekday; on the day itself, a week later.
        let add = (wd - today.wd + 7) % 7;
        if (add === 0) add = 7;
        date = ymd(today.y, today.m, today.d + add);
      });
    }
  }

  // --- explicit dates: 21.10.(2026), 2026-10-21, 21/10, Oct 21, 21 Oct(ober)
  if (!date) {
    take(/\s(?:on|by|do|na|dne)?\s*(\d{4})-(\d{2})-(\d{2})(?=\s|[,.!?]|$)/i, (m) => { date = `${m[1]}-${m[2]}-${m[3]}`; })
      || take(/\s(?:on|by|do|na|dne)?\s*(\d{1,2})\.\s?(\d{1,2})\.(?:\s?(\d{4}))?(?=\s|[,!?]|$)/i, (m) => { date = pickYear(+m[3], +m[2], +m[1]); })
      || take(/\s(?:on|by|do|na|dne)?\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?(?=\s|[,.!?]|$)/i, (m) => { date = pickYear(+m[3], +m[2], +m[1]); })
      || take(new RegExp(`\\s(?:on|by)?\\s*(${MONTHS.join('|')})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?(?=\\s|[,.!?]|$)`, 'i'), (m) => { date = pickYear(+m[3], monthOf(m[1]), +m[2]); })
      || take(new RegExp(`\\s(?:on|by|do|na)?\\s*(\\d{1,2})\\.?\\s+(${MONTHS.join('|')})[a-zčšž]*\\.?(?:\\s+(\\d{4}))?(?=\\s|[,.!?]|$)`, 'i'), (m) => { date = pickYear(+m[3], monthOf(m[2]), +m[1]); });
  }

  if (!date && time) {
    // Only a time: today if still ahead, else tomorrow.
    const t = localToEpoch(ymd(today.y, today.m, today.d), time, tz);
    date = ymd(today.y, today.m, today.d + (t > now ? 0 : 1));
  }
  const due = date ? localToEpoch(date, time || DEFAULT_TIME, tz) : null;
  const title = s.replace(/\s+(by|on|at|until|do|ob|v|na)\s*$/i, ' ').replace(/\s{2,}/g, ' ').trim().replace(/[,;:\-–]+$/, '').trim();
  return { title: title || String(text || '').trim(), due: Number.isNaN(due) ? null : due };

  function monthOf(name) { return MONTHS.findIndex((p) => new RegExp(`^(${p})`, 'i').test(name)) + 1; }
  // Without a year: this year, or next year when that date has already passed.
  function pickYear(y, m, d) {
    if (!m || m > 12 || !d || d > 31) return null;
    if (y) return ymd(y, m, d);
    const thisYear = ymd(today.y, m, d);
    return thisYear < ymd(today.y, today.m, today.d) ? ymd(today.y + 1, m, d) : thisYear;
  }
}

/** True when the text seems to mention a time without the rules recognising it (worth asking the AI). */
export const mentionsTime = (text) => /\d|next|naslednj|prihodnj|konec|end of|before|until|after|po |pred |week|month|teden|mesec/i.test(text);
