import { useEffect, useState } from 'react';
import { NotebookPen, Plus } from 'lucide-react';
import { api } from '../api.js';
import { inkwellNewUrl, sameOccurrence } from '../../../server/src/util/inkwell.js';

// Answers per page load for a minute, so reopening the same mail or event does not ask Inkwell again.
const cache = new Map();
const TTL = 60e3;
export const forgetInkwellLinks = () => cache.clear();

/** Asks Halcyon (which asks Inkwell) for pages linked to items of one kind; { url: null } when not set up or not reachable. */
export async function inkwellLinks(kind, refs) {
  const ids = [...new Set(refs.filter((r) => r != null).map(String))];
  if (!ids.length) return { url: null, links: [] };
  const key = `${kind}:${ids.join(',')}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const data = await api.get(`/api/integrations/inkwell/links?kind=${kind}&ref=${ids.join(',')}`).catch(() => ({ url: null, links: [] }));
  cache.set(key, { at: Date.now(), data });
  return data;
}

/**
 * Inkwell pages linked to this email / event / task, and a button for a new one (`item`: ref and details for it). Renders nothing while Inkwell is not
 * connected or does not answer, so the view stays as it is without it.
 */
export default function InkwellNotes({ kind, refs, item, style }) {
  const [data, setData] = useState(null);
  const key = (refs || []).filter((r) => r != null).join(',');
  useEffect(() => {
    let live = true;
    setData(null);
    inkwellLinks(kind, refs || []).then((d) => { if (live) setData(d); });
    return () => { live = false; };
  }, [kind, key]);
  if (!data?.url || data.error) return null;
  const seen = new Set();
  const links = data.links.filter((l) => !seen.has(l.id) && seen.add(l.id));
  // An event has one note per occurrence: this one's may not exist yet although others do.
  const hasNote = kind === 'event' ? links.some((l) => sameOccurrence(l.date, item?.start, item?.allDay)) : links.length > 0;
  return (
    <div className="card inkwell-notes" style={style}>
      <div className="inkwell-head"><NotebookPen size={13} /><span className="grow">Notes{links.length ? <span className="muted"> · {links.length}</span> : ''}</span>
        {item?.ref != null && <a className="btn sm ghost" href={inkwellNewUrl(data.url, kind, item)} title={hasNote ? 'Opens the note linked to this in Inkwell' : 'Makes a note in Inkwell, linked to this'}>
          <Plus size={13} /> {hasNote ? 'Open in Inkwell' : 'New note in Inkwell'}</a>}</div>
      {links.map((l) => (
        <a key={l.id} className="recent-row" href={l.url} target="_blank" rel="noreferrer">
          <span className="truncate">{l.icon ? `${l.icon} ` : ''}{l.title || 'Untitled'}</span>
          {l.snippet && <span className="small muted truncate">{l.snippet}</span>}
        </a>))}
    </div>
  );
}
