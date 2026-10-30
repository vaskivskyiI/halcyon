// Shared by the web UI (components/InkwellNotes.jsx) and the tests.
const iso = (t) => (t == null || t === '' ? null : new Date(t).toISOString());
/**
 * Inkwell's "#/new": it opens the note linked to this item, or makes one (linked, with the details given — for an event
 * the meeting template with its attendees). Same tab: Inkwell shows its sign-in first when needed; the desktop app
 * opens it in the browser.
 */
export function inkwellNewUrl(base, kind, item) {
  const p = { kind, ref: item.ref, title: item.title, start: iso(item.start), end: iso(item.end), location: item.location,
    attendees: item.attendees?.length ? item.attendees.join(', ') : null, from: item.from, date: iso(item.date), due: iso(item.due) };
  const q = new URLSearchParams(Object.entries(p).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]));
  return `${base}/#/new?${q.toString().replace(/\+/g, '%20')}`;
}
