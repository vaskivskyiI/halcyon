// iCalendar parsing (ical.js) and generation.
import ICAL from 'ical.js';

function registerTimezones(comp) {
  for (const tz of comp.getAllSubcomponents('vtimezone')) {
    try { ICAL.TimezoneService.register(tz); } catch { /* duplicate */ }
  }
}

import { localToEpoch } from '../util/time.js';

// Floating times (no zone in the invitation) are wall-clock times of the reader: use the user's zone, not the server's.
let floatingTz = null;
const toMs = (t) => {
  if (!t) return null;
  if (floatingTz && !t.isDate && (!t.zone || t.zone.tzid === 'floating')) {
    const p2 = (n) => String(n).padStart(2, '0');
    return localToEpoch(`${t.year}-${p2(t.month)}-${p2(t.day)}`, `${p2(t.hour)}:${p2(t.minute)}`, floatingTz);
  }
  return t.toJSDate().getTime();
};

function parseAttendee(prop) {
  const v = String(prop.getFirstValue() || '').replace(/^mailto:/i, '');
  return {
    email: v.toLowerCase(), name: prop.getParameter('cn') || '', status: (prop.getParameter('partstat') || 'NEEDS-ACTION').toLowerCase(),
    role: (prop.getParameter('role') || 'REQ-PARTICIPANT').toLowerCase(), rsvp: prop.getParameter('rsvp') === 'TRUE',
  };
}

export function parseIcs(text, defaultTz = null) {
  floatingTz = defaultTz;
  try { return parseIcsInner(text); } finally { floatingTz = null; }
}

// Some senders put raw line breaks inside a value (a DESCRIPTION over several lines) instead of "\n": such lines are
// joined to the property they belong to, so the invitation is still understood.
function repairIcs(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (out.length && line && !/^[ \t]/.test(line) && !/^[A-Za-z][A-Za-z0-9-]*[;:]/.test(line)) out[out.length - 1] += `\\n${line}`;
    else out.push(line);
  }
  return out.join('\r\n');
}

function parseIcsInner(text) {
  let jcal;
  try { jcal = ICAL.parse(text); } catch { jcal = ICAL.parse(repairIcs(text)); }
  const comp = new ICAL.Component(jcal);
  registerTimezones(comp);
  const method = comp.getFirstPropertyValue('method') || null;
  const events = comp.getAllSubcomponents('vevent').map((ve) => {
    const ev = new ICAL.Event(ve);
    const allDay = ev.startDate?.isDate || false;
    const rruleProp = ve.getFirstPropertyValue('rrule');
    const exdates = ve.getAllProperties('exdate').flatMap((p) => p.getValues()).map((d) => d.toJSDate().getTime());
    const org = ve.getFirstProperty('organizer');
    const alarms = ve.getAllSubcomponents('valarm').map((a) => {
      const trig = a.getFirstPropertyValue('trigger');
      return trig && typeof trig.toSeconds === 'function' ? Math.max(0, Math.round(-trig.toSeconds() / 60)) : null;
    }).filter((x) => x != null);
    let end = toMs(ev.endDate);
    if (!end && ev.startDate) end = toMs(ev.startDate) + (allDay ? 864e5 : 3600e3);
    const desc = ev.description || '';
    const meeting = (String(ve.getFirstPropertyValue('x-microsoft-skypeteamsmeetingurl') || '') ||
      (desc.match(/https:\/\/(?:teams\.microsoft\.com|[\w.-]*zoom\.us|meet\.google\.com|[\w.-]*webex\.com)\/[^\s<>"]+/) || [])[0]) || null;
    return {
      uid: ev.uid, title: ev.summary || '(no title)', description: desc, location: ev.location || '',
      start: toMs(ev.startDate), end, allDay, timezone: ev.startDate?.zone?.tzid && ev.startDate.zone.tzid !== 'floating' ? ev.startDate.zone.tzid : null,
      rrule: rruleProp ? rruleProp.toString() : null, exdates,
      recurrenceId: ev.recurrenceId ? toMs(ev.recurrenceId) : null,
      attendees: ve.getAllProperties('attendee').map(parseAttendee),
      organizer: org ? { email: String(org.getFirstValue()).replace(/^mailto:/i, '').toLowerCase(), name: org.getParameter('cn') || '' } : null,
      reminders: alarms, status: (ve.getFirstPropertyValue('status') || 'CONFIRMED').toLowerCase(),
      busy: (ve.getFirstPropertyValue('transp') || 'OPAQUE') !== 'TRANSPARENT', url: ve.getFirstPropertyValue('url') || null,
      onlineMeeting: meeting, sequence: Number(ve.getFirstPropertyValue('sequence') || 0),
    };
  });
  return { method, events };
}

const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
const utc = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const dateOnly = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
};
const fold = (line) => { const out = []; let s = line; while (s.length > 74) { out.push(s.slice(0, 74)); s = ' ' + s.slice(74); } out.push(s); return out.join('\r\n'); };

export function veventLines(e, { method, attendeeOverride, clientScheduling = false } = {}) {
  // Saved on a CalDAV server: SCHEDULE-AGENT=CLIENT (RFC 6638) — Halcyon sends invitations itself, the server must not
  // email attendees too (or at all, for events merely moved there).
  const agent = clientScheduling ? ';SCHEDULE-AGENT=CLIENT' : '';
  const L = ['BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${utc(Date.now())}`];
  if (e.allDay) { L.push(`DTSTART;VALUE=DATE:${dateOnly(e.start)}`, `DTEND;VALUE=DATE:${dateOnly(e.end)}`); }
  else { L.push(`DTSTART:${utc(e.start)}`, `DTEND:${utc(e.end)}`); }
  if (e.recurrenceId) L.push(e.allDay ? `RECURRENCE-ID;VALUE=DATE:${dateOnly(e.recurrenceId)}` : `RECURRENCE-ID:${utc(e.recurrenceId)}`);
  L.push(`SUMMARY:${esc(e.title)}`);
  if (e.description) L.push(`DESCRIPTION:${esc(e.description)}`);
  if (e.location) L.push(`LOCATION:${esc(e.location)}`);
  if (e.url) L.push(`URL:${e.url}`);
  if (e.rrule && !e.recurrenceId) L.push(`RRULE:${e.rrule}`);
  for (const x of e.exdates || []) L.push(e.allDay ? `EXDATE;VALUE=DATE:${dateOnly(x)}` : `EXDATE:${utc(x)}`);
  L.push(`STATUS:${(e.status || 'confirmed').toUpperCase()}`, `TRANSP:${e.busy === false ? 'TRANSPARENT' : 'OPAQUE'}`, `SEQUENCE:${e.sequence || 0}`);
  if (e.organizer?.email) L.push(`ORGANIZER;CN=${esc(e.organizer.name || e.organizer.email)}${agent}:mailto:${e.organizer.email}`);
  const attendees = attendeeOverride || e.attendees || [];
  for (const a of attendees) {
    L.push(`ATTENDEE;CN=${esc(a.name || a.email)};ROLE=${(a.role || 'req-participant').toUpperCase()};PARTSTAT=${(a.status || 'needs-action').toUpperCase()};RSVP=${method === 'REQUEST' ? 'TRUE' : 'FALSE'}${agent}:mailto:${a.email}`);
  }
  if (method !== 'REPLY') {
    for (const m of e.reminders || []) L.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(e.title)}`, `TRIGGER:-PT${m}M`, 'END:VALARM');
  }
  L.push('END:VEVENT');
  return L;
}

export function buildIcs(events, { method, clientScheduling = false } = {}) {
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Halcyon//Halcyon Mail//EN', 'CALSCALE:GREGORIAN'];
  if (method) L.push(`METHOD:${method}`);
  for (const e of events) L.push(...veventLines(e, { method, clientScheduling }));
  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}
