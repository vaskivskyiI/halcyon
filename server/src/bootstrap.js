import { get, run, now } from './db/index.js';

// Per-user defaults: a local calendar and a local address book.
export function ensureDefaults(userId) {
  if (!get('SELECT id FROM calendars WHERE user_id = ?', userId)) {
    run("INSERT INTO calendars (user_id, name, color, source, is_default, created_at) VALUES (?, 'Calendar', '#3b82f6', 'local', 1, ?)", userId, now());
  }
  if (!get('SELECT id FROM address_books WHERE user_id = ?', userId)) {
    run("INSERT INTO address_books (user_id, name, source, created_at) VALUES (?, 'Contacts', 'local', ?)", userId, now());
  }
}
