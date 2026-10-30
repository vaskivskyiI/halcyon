// Shared by the web UI (components/InkwellNotes.jsx) and the tests.
const iso = (t) => (t == null || t === '' ? null : new Date(t).toISOString());
/**
 * The day of an event's occurrence, YYYY-MM-DD. All-day events are stored at midnight UTC, so their day is the UTC one;
 * timed events count on the day they fall in here.
 */
export function occurrenceDay(start, allDay = false) {
  if (start == null) return null;
  const d = new Date(start);
  if (allDay) return d.toISOString().slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/**
 * Inkwell's "#/new": it opens the note linked to this item, or makes one (linked, with the details given — for an event
 * the meeting template with its attendees, one note per occurrence — and in the Inkwell space named `hspace`). Same tab: Inkwell shows its sign-in first when needed; the desktop app
 * opens it in the browser.
 */
export function inkwellNewUrl(base, kind, item) {
  const p = { kind, ref: item.ref, title: item.title, start: iso(item.start), end: iso(item.end), location: item.location,
    attendees: item.attendees?.length ? item.attendees.join(', ') : null, from: item.from, date: iso(item.date), due: iso(item.due), hspace: item.space,
    day: kind === 'event' ? occurrenceDay(item.start, item.allDay) : null };
  const q = new URLSearchParams(Object.entries(p).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]));
  return `${base}/#/new?${q.toString().replace(/\+/g, '%20')}`;
}

/** Whether a linked note (its `date`: the `day` it was made with) belongs to this occurrence of an event. */
export const sameOccurrence = (date, start, allDay = false) => !!date && date === occurrenceDay(start, allDay);
