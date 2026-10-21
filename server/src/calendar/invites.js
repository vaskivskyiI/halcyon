// iMIP: incoming invitations (REQUEST / CANCEL / REPLY) and sending invitations & RSVPs.
import { get, all, json, run } from '../db/index.js';
import { getSettings } from '../settings.js';
import { parseIcs, buildIcs } from './ics.js';
import { createEvent, updateEvent, serializeEvent, defaultCalendar } from './repo.js';
import { queueSend } from '../mail/send.js';
import { userAccounts } from '../accounts.js';
import { calendarForAccount, spaceMap } from '../spaces.js';

const writable = (userId) => all('SELECT * FROM calendars WHERE user_id = ? AND readonly = 0 AND enabled = 1 ORDER BY name', userId);

/**
 * The calendar an accepted invitation goes to: the one chosen for the receiving account in Settings, else that
 * account's own calendar (its default one, else its main one — not "Birthdays" & co.), else its space's calendar.
 */
export function inviteCalendar(userId, accountId) {
  const cals = writable(userId);
  const acc = get('SELECT invite_calendar_id FROM accounts WHERE id = ? AND user_id = ?', accountId, userId);
  const chosen = acc?.invite_calendar_id && cals.find((c) => c.id === acc.invite_calendar_id);
  if (chosen) return chosen;
  const own = cals.filter((c) => c.account_id === Number(accountId));
  const main = /^(calendar|calendars|default|personal|primary|home|work|koledar|kalender|calendrier|calendario|agenda)$/i;
  const ranked = own.sort((a, b) => (b.is_default - a.is_default) || (main.test(b.name) - main.test(a.name))
    || (/birthday|rojstn|holiday|praznik|task|contacts/i.test(a.name) - /birthday|rojstn|holiday|praznik|task|contacts/i.test(b.name)) || a.id - b.id);
  return ranked[0] || calendarForAccount(userId, accountId) || defaultCalendar(userId);
}

export function invitationFor(userId, messageId) {
  const m = get('SELECT * FROM messages WHERE id = ? AND user_id = ?', messageId, userId);
  if (!m?.calendar_ics) return null;
  let parsed;
  // An invitation that cannot be read is reported (the card says so and offers alternatives), not hidden.
  try { parsed = parseIcs(m.calendar_ics, getSettings(userId).calendar.timezone); } catch (e) { return { error: `The calendar data in this email could not be read (${e.message})` }; }
  const ev = parsed.events.find((x) => x.start) || parsed.events[0];
  if (!ev) return { error: 'This email contains calendar data without an event' };
  const mine = userAccounts(userId).map((a) => a.email.toLowerCase());
  const me = ev.attendees.find((a) => mine.includes(a.email));
  const local = get('SELECT e.* FROM events e JOIN calendars c ON c.id = e.calendar_id WHERE c.user_id = ? AND e.uid = ? AND e.recurrence_id IS NULL', userId, ev.uid);
  const spaces = spaceMap(userId);
  return { method: parsed.method || 'REQUEST', event: ev, myStatus: me?.status || null, myEmail: me?.email || null, existingEventId: local?.id || null, existingStatus: local?.status || null,
    existingCalendarId: local?.calendar_id || null, defaultCalendarId: inviteCalendar(userId, m.account_id)?.id || null,
    calendars: writable(userId).map((c) => ({ id: c.id, name: c.name, color: c.color, space: spaces.calendars.get(c.id) || '', accountId: c.account_id })) };
}

export function respondToInvitation(userId, messageId, response, { comment, sendReply = true, calendarId } = {}) {
  const inv = invitationFor(userId, messageId);
  if (!inv?.event) throw new Error(inv?.error || 'No invitation in this message');
  const m = get('SELECT * FROM messages WHERE id = ?', messageId);
  const account = get('SELECT * FROM accounts WHERE id = ?', m.account_id);
  const myEmail = inv.myEmail || account.email.toLowerCase();
  const partstat = { accept: 'accepted', tentative: 'tentative', decline: 'declined' }[response];
  if (!partstat) throw new Error('Invalid response');
  const attendees = inv.event.attendees.map((a) => (a.email === myEmail ? { ...a, status: partstat } : a));
  if (!attendees.some((a) => a.email === myEmail)) attendees.push({ email: myEmail, name: account.display_name || '', status: partstat, role: 'req-participant' });

  let eventId = inv.existingEventId;
  const evData = { ...inv.event, attendees, status: response === 'decline' ? 'cancelled' : (response === 'tentative' ? 'tentative' : 'confirmed'), sourceMessageId: messageId };
  if (response === 'decline') {
    if (eventId) updateEvent(userId, eventId, { status: 'cancelled', attendees });
  } else {
    // A calendar chosen on the card (writable, the user's own), else the receiving account's calendar.
    const target = (calendarId && writable(userId).find((c) => c.id === Number(calendarId))) || inviteCalendar(userId, account.id);
    if (eventId) {
      // Already in a calendar: updated there, or moved when another calendar was chosen.
      eventId = updateEvent(userId, eventId, { ...evData, calendarId: calendarId ? target?.id : undefined })?.id || eventId;
    } else eventId = createEvent(userId, { ...evData, calendarId: target?.id }).id;
  }
  if (sendReply && inv.event.organizer?.email) {
    const me = attendees.find((a) => a.email === myEmail);
    const ics = buildIcs([{ ...inv.event, attendees: [me] }], { method: 'REPLY' });
    const verb = { accept: 'Accepted', tentative: 'Tentative', decline: 'Declined' }[response];
    queueSend(userId, {
      accountId: account.id, to: [{ address: inv.event.organizer.email, name: inv.event.organizer.name }],
      subject: `${verb}: ${inv.event.title}`, text: comment || `${verb}: ${inv.event.title}`,
      icalEvent: { method: 'REPLY', content: ics },
    });
  }
  // Where it went, so the user can find it (the calendar may belong to another space).
  const placed = eventId && get('SELECT e.start, c.id AS calendar_id, c.name FROM events e JOIN calendars c ON c.id = e.calendar_id WHERE e.id = ?', eventId);
  return { eventId, status: partstat, start: placed?.start || inv.event.start, calendar: placed ? { id: placed.calendar_id, name: placed.name, space: spaceMap(userId).calendars.get(placed.calendar_id) || '' } : null };
}

/** Process METHOD:REPLY / CANCEL automatically when such messages arrive. */
export function processIncomingIcs(userId, messageId) {
  const inv = invitationFor(userId, messageId);
  if (!inv || !inv.existingEventId) return;
  const ev = get('SELECT * FROM events WHERE id = ?', inv.existingEventId);
  const sender = String(get('SELECT from_addr FROM messages WHERE id = ?', messageId)?.from_addr || '').toLowerCase();
  if (inv.method === 'REPLY') {
    // An attendee may only answer for themself; anything else in the ICS is ignored.
    const r = inv.event.attendees.find((x) => x.email === sender);
    if (!r) return;
    const attendees = json(ev.attendees_json, []).map((a) => (a.email === sender ? { ...a, status: r.status } : a));
    updateEvent(userId, ev.id, { attendees });
  } else if (inv.method === 'CANCEL') {
    // Only the organizer can cancel; otherwise anyone who knows the UID could wipe the user's meetings.
    const organizer = String(json(ev.organizer_json, {})?.email || '').toLowerCase();
    if (organizer && organizer === sender) updateEvent(userId, ev.id, { status: 'cancelled' });
  }
}

/** Send METHOD:REQUEST (or CANCEL) to attendees of an event the user organizes. */
export function sendInvitations(userId, eventId, { method = 'REQUEST', accountId } = {}) {
  const ev = get('SELECT * FROM events WHERE id = ?', eventId);
  if (!ev) return;
  const e = serializeEvent(ev);
  const account = (accountId && get('SELECT * FROM accounts WHERE id = ? AND user_id = ?', accountId, userId)) || userAccounts(userId)[0];
  if (!account) throw new Error('No mail account to send invitations from');
  const organizer = e.organizer?.email ? e.organizer : { email: account.email, name: account.display_name || '' };
  if (!e.organizer?.email) run('UPDATE events SET organizer_json = ? WHERE id = ?', JSON.stringify(organizer), eventId);
  const recipients = e.attendees.filter((a) => a.email && a.email !== organizer.email);
  if (!recipients.length) return;
  const ics = buildIcs([{ ...e, organizer, status: method === 'CANCEL' ? 'cancelled' : e.status, sequence: Math.floor(Date.now() / 60000) }], { method });
  const when = new Date(e.start).toUTCString();
  queueSend(userId, {
    accountId: account.id, to: recipients.map((a) => ({ address: a.email, name: a.name })),
    subject: `${method === 'CANCEL' ? 'Cancelled' : 'Invitation'}: ${e.title}`,
    html: `<p><b>${e.title}</b></p><p>${when}${e.location ? `<br>${e.location}` : ''}</p>${e.description ? `<p>${e.description.replace(/\n/g, '<br>')}</p>` : ''}`,
    icalEvent: { method, content: ics },
  });
}
