// Wall-clock times in a named time zone → absolute time. Models are unreliable with UTC offsets (a meeting "at
// 12:30" often comes back as 12:30Z, i.e. 14:30 in Ljubljana), so prompts ask for the local date and time as written
// and the conversion happens here, with the user's time zone and its DST rules.

function tzOffsetMs(epoch, tz) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(epoch));
  const g = (t) => Number(p.find((x) => x.type === t).value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - epoch;
}

/** 'YYYY-MM-DD' + 'HH:MM' (wall clock in tz) → epoch ms, or NaN. */
export function localToEpoch(date, time, tz) {
  const d = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!d) return NaN;
  const t = String(time || '00:00').match(/^(\d{1,2})[:.](\d{2})/) || [0, 0, 0];
  const guess = Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2]);
  try {
    // Two passes settle the offset around DST changes.
    const first = guess - tzOffsetMs(guess, tz);
    return guess - tzOffsetMs(first, tz);
  } catch { return guess; }
}

/**
 * Normalises an event proposed by a model to { title, start, end, all_day, location } with ISO (UTC) times.
 * Accepts { date, start_time, end_time } (preferred) or a legacy ISO "start"/"end", whose wall-clock part is used
 * and whose offset is ignored. Returns null when no usable date is present.
 */
export function normalizeEvent(e, userTz) {
  if (!e || typeof e !== 'object') return null;
  // e.tz: the zone the email states for these times ("CET", "UTC", "Europe/London"); otherwise the user's zone.
  const tz = zoneOf(e.tz) || userTz;
  const legacy = (v) => String(v || '').match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}:\d{2}))?/);
  const ls = legacy(e.start), le = legacy(e.end);
  const date = e.date || ls?.[1];
  const startTime = e.start_time || ls?.[2] || null;
  const allDay = !!e.all_day || !startTime;
  const start = localToEpoch(date, allDay ? '00:00' : startTime, tz);
  if (Number.isNaN(start)) return null;
  let end = e.end_time ? localToEpoch(e.end_date || date, e.end_time, tz) : le?.[2] ? localToEpoch(le[1], le[2], tz) : NaN;
  if (Number.isNaN(end) || end <= start) end = allDay ? start + 864e5 : start + 3600e3;
  return { title: String(e.title || '').slice(0, 200), start: new Date(start).toISOString(), end: new Date(end).toISOString(), all_day: allDay, location: e.location || null };
}

/** Keeps the wall-clock reading of an absolute time when the zone it was read in changes (UTC 08:00 → Ljubljana 08:00). */
export function rezone(epoch, fromTz, toTz) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: fromTz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(epoch));
  const g = (t) => p.find((x) => x.type === t).value;
  return localToEpoch(`${g('year')}-${g('month')}-${g('day')}`, `${g('hour')}:${g('minute')}`, toTz);
}

// Zone abbreviations models copy from mail ("14:00 CET", "9am EST"). People use them loosely all year ("CET" in summer
// means Central European local time), so they map to the region's zone with its DST rules; UTC/GMT stay fixed.
const ABBR = { UTC: 'UTC', GMT: 'UTC', Z: 'UTC', WET: 'Europe/Lisbon', WEST: 'Europe/Lisbon', BST: 'Europe/London', CET: 'Europe/Paris',
  CEST: 'Europe/Paris', MET: 'Europe/Paris', MEST: 'Europe/Paris', EET: 'Europe/Athens', EEST: 'Europe/Athens', MSK: 'Europe/Moscow',
  IST: 'Asia/Kolkata', EST: 'America/New_York', EDT: 'America/New_York', CST: 'America/Chicago', CDT: 'America/Chicago',
  MST: 'America/Denver', MDT: 'America/Denver', PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles', JST: 'Asia/Tokyo',
  KST: 'Asia/Seoul', AEST: 'Australia/Sydney', AEDT: 'Australia/Sydney' };

/** A zone named in mail → something localToEpoch understands (IANA name or fixed offset), or null. */
export function zoneOf(label) {
  const s = String(label || '').trim();
  if (!s) return null;
  try { new Intl.DateTimeFormat('en', { timeZone: s }); if (s.includes('/') || /^(UTC|GMT)$/i.test(s)) return s; } catch { /* not IANA */ }
  const up = s.toUpperCase();
  if (ABBR[up]) return ABBR[up];
  let off = null;
  const m = up.match(/^(?:UTC|GMT)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (off == null && m) off = (m[1] === '-' ? -1 : 1) * (Number(m[2]) + Number(m[3] || 0) / 60);
  if (off == null || Math.abs(off) > 14) return null;
  // Etc/GMT zones have inverted signs and whole hours only; other offsets are expressed as +HH:MM.
  if (Number.isInteger(off)) return off === 0 ? 'UTC' : `Etc/GMT${off > 0 ? '-' : '+'}${Math.abs(off)}`;
  const mins = Math.round(Math.abs(off) * 60);
  return `${off < 0 ? '-' : '+'}${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}
