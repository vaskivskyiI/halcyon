// Expansion of recurring events into concrete occurrences, with DST correction for the event's timezone.
import rrulePkg from 'rrule';
const { RRule } = rrulePkg;

export function tzOffsetMs(tz, ms) {
  if (!tz) return -new Date(ms).getTimezoneOffset() * 60e3;
  try {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const p = Object.fromEntries(dtf.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
  } catch { return 0; }
}

/**
 * All-day events are dates, not moments: stored as UTC midnight of the date (as iCalendar DATE values are read). A local
 * midnight (from the editor, any zone within ±12 h) is the nearest UTC midnight of the same date.
 */
export const allDayMs = (t) => Math.round(Number(t) / 864e5) * 864e5;

const validZone = (tz) => { if (!tz) return false; try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

/** Returns occurrences [{start, end, recurrenceId}] of event e in [from, to). */
export function expand(e, from, to, tz) {
  const dur = Math.max(0, (e.end || e.start) - e.start);
  if (!e.rrule) return e.start < to && (e.end || e.start) >= from ? [{ start: e.start, end: e.end, recurrenceId: null }] : [];
  // The rule runs on wall-clock time (held in UTC fields): BYMONTHDAY, BYDAY and the like mean the event's own calendar
  // day, not the UTC one, and the time stays the same across DST changes. All-day events already are UTC dates.
  const zone = validZone(e.timezone) ? e.timezone : tz;
  const off = (t) => (e.allDay ? 0 : tzOffsetMs(zone, t));
  const fromWall = (w) => { const s = w - off(w); return w - off(s); };
  let rule;
  try {
    const opts = RRule.parseString(e.rrule);
    rule = new RRule({ ...opts, ...(opts.until ? { until: new Date(opts.until.getTime() + off(opts.until.getTime())) } : {}), dtstart: new Date(e.start + off(e.start)) });
  } catch { return [{ start: e.start, end: e.end, recurrenceId: null }]; }
  const ex = new Set((e.exdates || []).map((x) => (e.allDay ? allDayMs(x) : Number(x))));
  const out = [];
  const dates = rule.between(new Date(from + off(from) - dur - 864e5), new Date(to + off(to) + 864e5), true);
  for (const d of dates) {
    const s = fromWall(d.getTime());
    if (ex.has(s)) continue;
    if (s >= to || s + dur < from) continue;
    out.push({ start: s, end: s + dur, recurrenceId: s });
    if (out.length > 1000) break;
  }
  return out;
}
