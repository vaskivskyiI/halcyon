// All-day events are dates: a birthday stays on its day in every year, zone and season; a rule means the event's own
// calendar day, also for an event just after local midnight.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expand, allDayMs } from '../src/calendar/recurrence.js';
import { parseIcs, buildIcs } from '../src/calendar/ics.js';

const days = (list) => list.map((o) => new Date(o.start).toISOString().slice(0, 10));
const Y = (y) => [Date.UTC(y, 0, 1), Date.UTC(y + 1, 0, 1)];

test('a local midnight is the date it stands for, in any zone within 12 hours, also before 1970', () => {
  assert.equal(allDayMs(Date.UTC(2026, 2, 3, 23)), Date.UTC(2026, 2, 4)); // Ljubljana, winter
  assert.equal(allDayMs(Date.UTC(2026, 6, 3, 22)), Date.UTC(2026, 6, 4)); // Ljubljana, summer
  assert.equal(allDayMs(Date.UTC(2026, 2, 4, 5)), Date.UTC(2026, 2, 4)); // New York
  assert.equal(allDayMs(Date.UTC(1961, 2, 3, 23)), Date.UTC(1961, 2, 4));
});

test('a yearly birthday from a calendar file stays on its date every year', () => {
  const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:t\r\nBEGIN:VEVENT\r\nUID:b\r\nDTSTAMP:20200101T000000Z\r\nDTSTART;VALUE=DATE:19610304\r\nDTEND;VALUE=DATE:19610305\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=4\r\nSUMMARY:Ana\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const [e] = parseIcs(ics).events;
  for (const y of [2026, 2027, 2028]) assert.deepEqual(days(expand(e, ...Y(y), 'Europe/Ljubljana')), [`${y}-03-04`]);
});

test('a date is written back as the same date, also from a local midnight', () => {
  const out = buildIcs([{ uid: 'x', title: 'B', allDay: true, start: Date.UTC(2026, 2, 3, 23), end: Date.UTC(2026, 2, 4, 23) }]);
  assert.match(out, /DTSTART;VALUE=DATE:20260304/);
  assert.match(out, /DTEND;VALUE=DATE:20260305/);
});

test('a rule means the day in the event\'s own zone, and the time stays across DST', () => {
  // Timed, 00:00 in Ljubljana on 4 March (23:00 UTC the day before), as Outlook keeps birthdays.
  const e = { start: Date.UTC(2020, 2, 3, 23), end: Date.UTC(2020, 2, 4, 23), rrule: 'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=4', timezone: 'Europe/Ljubljana' };
  const [o] = expand(e, ...Y(2026), 'Europe/Ljubljana');
  assert.equal(new Date(o.start).toLocaleString('en-GB', { timeZone: 'Europe/Ljubljana' }), '04/03/2026, 00:00:00');
  // Weekly on Monday 00:30 local: Sunday in UTC.
  const w = { start: Date.UTC(2026, 9, 18, 22, 30), end: Date.UTC(2026, 9, 18, 23), rrule: 'FREQ=WEEKLY;BYDAY=MO', timezone: 'Europe/Ljubljana' };
  const list = expand(w, Date.UTC(2026, 9, 18), Date.UTC(2026, 10, 3), 'Europe/Ljubljana');
  assert.deepEqual(list.map((x) => new Date(x.start).toLocaleString('en-GB', { timeZone: 'Europe/Ljubljana', weekday: 'short', hour: '2-digit', minute: '2-digit' })), ['Mon 00:30', 'Mon 00:30', 'Mon 00:30']);
});

test('a zone name that is not a known one (Outlook) falls back to the user\'s zone', () => {
  const e = { start: Date.UTC(2020, 2, 3, 23), end: Date.UTC(2020, 2, 4, 23), rrule: 'FREQ=YEARLY;BYMONTHDAY=4;BYMONTH=3', timezone: 'Central Europe Standard Time' };
  const [o] = expand(e, ...Y(2026), 'Europe/Ljubljana');
  assert.equal(new Date(o.start).toLocaleString('en-GB', { timeZone: 'Europe/Ljubljana' }), '04/03/2026, 00:00:00');
});
