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

/** Returns occurrences [{start, end, recurrenceId}] of event e in [from, to). */
export function expand(e, from, to, tz) {
  const dur = Math.max(0, (e.end || e.start) - e.start);
  if (!e.rrule) return e.start < to && (e.end || e.start) >= from ? [{ start: e.start, end: e.end, recurrenceId: null }] : [];
  let rule;
  try {
    const opts = RRule.parseString(e.rrule);
    rule = new RRule({ ...opts, dtstart: new Date(e.start) });
  } catch { return [{ start: e.start, end: e.end, recurrenceId: null }]; }
  const zone = e.timezone || tz;
  const baseOff = e.allDay ? 0 : tzOffsetMs(zone, e.start);
  const ex = new Set((e.exdates || []).map(Number));
  const out = [];
  const dates = rule.between(new Date(from - dur - 864e5), new Date(to + 864e5), true);
  for (const d of dates) {
    let s = d.getTime();
    if (!e.allDay) s += baseOff - tzOffsetMs(zone, s); // keep wall-clock time stable across DST changes
    if (ex.has(s) || ex.has(d.getTime())) continue;
    if (s >= to || s + dur < from) continue;
    out.push({ start: s, end: s + dur, recurrenceId: s });
    if (out.length > 1000) break;
  }
  return out;
}
