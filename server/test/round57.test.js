// A deadline is a task with a due date, not a slot in the calendar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HALCYON_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r57-test-'));
process.env.HALCYON_LOG_LEVEL = 'error';
const { deadlinesToItems, isDeadline, serializeInsight } = await import('../src/ai/tasks.js');
const tz = 'Europe/Ljubljana';
const ev = (title, o = {}) => ({ title, date: '2026-11-20', start_time: '17:00', end_time: null, tz: null, all_day: false, location: null, ...o });

test('deadlines are told from meetings, in several languages', () => {
  for (const t of ['Report deadline', 'Invoice due', 'Rok za oddajo poročila', 'Abgabefrist', 'Abgabe Bericht', 'Paper submission']) assert.ok(isDeadline({ title: t }), t);
  for (const t of ['Project kickoff', 'Dentist', 'Lunch with Rok-san'.replace('Rok-san', 'Ana'), 'Produce review']) assert.ok(!isDeadline({ title: t }), t);
});

test('a deadline gives its date and time to the item that has none, the meeting stays', () => {
  const d = deadlinesToItems({ events: [ev('Report deadline'), ev('Project kickoff')], action_items: [{ text: 'Send the report', due: null }] }, tz);
  assert.deepEqual(d.events.map((e) => e.title), ['Project kickoff']);
  assert.deepEqual(d.action_items, [{ text: 'Send the report', due: '2026-11-20 17:00' }]);
});

test('without an item it becomes one; a time in another zone is the user\'s time; no time stays a date; no double', () => {
  assert.deepEqual(deadlinesToItems({ events: [ev('Grant deadline', { tz: 'UTC' })], action_items: [] }, tz, 'by 17:00 UTC').action_items, [{ text: 'Grant deadline', due: '2026-11-20 18:00' }]);
  assert.equal(deadlinesToItems({ events: [ev('Fee due', { all_day: true, start_time: null })] }, tz).action_items[0].due, '2026-11-20');
  assert.equal(deadlinesToItems({ events: [ev('Fee due')], action_items: [{ text: 'Pay fee', due: '2026-11-20' }] }, tz).action_items.length, 1);
});

test('mail analysed earlier no longer offers its deadline as an event', () => {
  const i = serializeInsight({ events_json: JSON.stringify([ev('Report deadline'), ev('Project kickoff')]) });
  assert.deepEqual(i.events.map((e) => e.title), ['Project kickoff']);
});
