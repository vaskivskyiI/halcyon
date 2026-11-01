// Repeating events jump to the asked period instead of walking from their first year: same occurrences, far less work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import rrulePkg from 'rrule';
import { expand } from '../src/calendar/recurrence.js';

const { RRule } = rrulePkg;
const RULES = ['FREQ=DAILY', 'FREQ=DAILY;INTERVAL=3', 'FREQ=DAILY;BYDAY=MO,WE', 'FREQ=WEEKLY', 'FREQ=WEEKLY;INTERVAL=2', 'FREQ=WEEKLY;INTERVAL=3;BYDAY=TU,FR', 'FREQ=WEEKLY;BYDAY=MO;WKST=SU;INTERVAL=2',
  'FREQ=MONTHLY', 'FREQ=MONTHLY;INTERVAL=5', 'FREQ=MONTHLY;BYDAY=2TU', 'FREQ=MONTHLY;BYDAY=-1FR', 'FREQ=MONTHLY;BYMONTHDAY=-1', 'FREQ=MONTHLY;BYMONTHDAY=31', 'FREQ=YEARLY', 'FREQ=YEARLY;INTERVAL=4',
  'FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29', 'FREQ=YEARLY;BYYEARDAY=100', 'FREQ=WEEKLY;COUNT=500', 'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1', 'FREQ=DAILY;UNTIL=20261115T000000Z'];
const STARTS = [Date.UTC(1975, 2, 4), Date.UTC(2015, 0, 5, 9), Date.UTC(2016, 1, 29), Date.UTC(2018, 0, 31, 22, 30), Date.UTC(2024, 11, 31)];
const WINDOWS = [[Date.UTC(2026, 10, 1), Date.UTC(2026, 10, 2)], [Date.UTC(2026, 9, 26), Date.UTC(2026, 11, 7)], [Date.UTC(2028, 1, 1), Date.UTC(2028, 2, 5)], [Date.UTC(2015, 0, 1), Date.UTC(2015, 1, 1)]];

test('every kind of rule gives the same occurrences as walking from the start', () => {
  for (const rrule of RULES) for (const start of STARTS) for (const [from, to] of WINDOWS) {
    const dur = 36e5, e = { start, end: start + dur, rrule, allDay: true };
    const walked = new RRule({ ...RRule.parseString(rrule), dtstart: new Date(start) }).between(new Date(from - dur - 864e5), new Date(to + 864e5), true)
      .map((d) => d.getTime()).filter((s) => s < to && s + dur >= from);
    assert.deepEqual(expand(e, from, to, 'UTC').map((o) => o.start), walked, `${rrule} from ${new Date(start).toISOString()} in ${new Date(from).toISOString()}`);
  }
});

test('a timed event keeps its wall-clock time after the jump, across daylight saving', () => {
  const e = { start: Date.UTC(2015, 0, 5, 8), end: Date.UTC(2015, 0, 5, 9), rrule: 'FREQ=WEEKLY', timezone: 'Europe/Ljubljana' };
  for (const [from, to] of [[Date.UTC(2026, 0, 5), Date.UTC(2026, 0, 12)], [Date.UTC(2026, 6, 6), Date.UTC(2026, 6, 13)]]) {
    const [o] = expand(e, from, to, 'Europe/Ljubljana');
    assert.equal(new Date(o.start).toLocaleTimeString('en-GB', { timeZone: 'Europe/Ljubljana' }), '09:00:00');
  }
});

test('two thousand long-running events expand quickly', () => {
  const now = Date.UTC(2026, 10, 1), t = performance.now();
  for (let i = 0; i < 2000; i++) expand({ start: Date.UTC(1975 + (i % 40), i % 12, 1 + (i % 28)), end: Date.UTC(1975 + (i % 40), i % 12, 2 + (i % 28)), rrule: i % 2 ? 'FREQ=YEARLY' : 'FREQ=WEEKLY', timezone: 'Europe/Ljubljana' }, now, now + 864e5, 'Europe/Ljubljana');
  assert.ok(performance.now() - t < 500, `took ${performance.now() - t} ms`);
});
