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

/**
 * The empty starter calendar / address book make way once synced ones (CalDAV / CardDAV) are there — otherwise an
 * unexplained "Calendar" stays next to the real ones. Only while nothing was ever put in them; the first writable
 * synced one becomes the default instead.
 */
export function dropStarters(userId) {
  const cal = get("SELECT c.id, c.is_default FROM calendars c WHERE c.user_id = ? AND c.source = 'local' AND c.name = 'Calendar' AND NOT EXISTS (SELECT 1 FROM events e WHERE e.calendar_id = c.id) ORDER BY c.id LIMIT 1", userId);
  const realCal = get("SELECT id FROM calendars WHERE user_id = ? AND source = 'caldav' AND readonly = 0 ORDER BY id LIMIT 1", userId);
  if (cal && realCal) {
    run('DELETE FROM calendars WHERE id = ?', cal.id);
    if (cal.is_default || !get('SELECT 1 FROM calendars WHERE user_id = ? AND is_default = 1', userId)) run('UPDATE calendars SET is_default = 1 WHERE id = ?', realCal.id);
  }
  const book = get("SELECT b.id, b.is_default FROM address_books b WHERE b.user_id = ? AND b.source = 'local' AND b.name = 'Contacts' AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.address_book_id = b.id) ORDER BY b.id LIMIT 1", userId);
  const realBook = get("SELECT id FROM address_books WHERE user_id = ? AND source = 'carddav' ORDER BY id LIMIT 1", userId);
  if (book && realBook) {
    run('DELETE FROM address_books WHERE id = ?', book.id);
    if (book.is_default) run('UPDATE address_books SET is_default = 1 WHERE id = ?', realBook.id);
  }
  return !!((cal && realCal) || (book && realBook));
}
