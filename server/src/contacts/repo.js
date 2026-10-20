import { get, all, run, now, tx, update } from '../db/index.js';
import { uuid } from '../util/crypto.js';
import { syncContactEmails, defaultAddressBook } from './service.js';
import { queueMemory } from '../ai/queue.js';
import { removeMemory } from '../ai/memory.js';

const COLS = ['display_name', 'first_name', 'last_name', 'nickname', 'emails_json', 'phones_json', 'addresses_json', 'org', 'title', 'birthday', 'notes', 'photo', 'website', 'groups_json', 'favorite', 'auto_collected', 'etag', 'href', 'dirty', 'deleted', 'address_book_id', 'updated_at'];

export function toRow(c) {
  const row = {
    display_name: c.displayName, first_name: c.firstName, last_name: c.lastName, nickname: c.nickname,
    emails_json: c.emails && JSON.stringify(c.emails), phones_json: c.phones && JSON.stringify(c.phones),
    addresses_json: c.addresses && JSON.stringify(c.addresses), org: c.org, title: c.title, birthday: c.birthday, notes: c.notes,
    photo: c.photo, website: c.website, groups_json: c.groups && JSON.stringify(c.groups),
    favorite: c.favorite === undefined ? undefined : (c.favorite ? 1 : 0), address_book_id: c.addressBookId,
  };
  if (!row.display_name && (c.firstName || c.lastName)) row.display_name = [c.firstName, c.lastName].filter(Boolean).join(' ');
  return row;
}

export function createContact(userId, c, extra = {}) {
  const book = c.addressBookId ? get('SELECT * FROM address_books WHERE id = ? AND user_id = ?', c.addressBookId, userId) : defaultAddressBook(userId);
  const r = run('INSERT INTO contacts (user_id, address_book_id, uid, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', userId, book?.id, c.uid || uuid(), now(), now());
  const id = r.lastInsertRowid;
  update('contacts', id, { ...toRow(c), dirty: book?.source === 'carddav' ? 1 : 0, ...extra, updated_at: now() }, COLS);
  syncContactEmails(id, userId, c.emails);
  queueMemory(userId, 'contact', id);
  return get('SELECT * FROM contacts WHERE id = ?', id);
}

export function updateContact(userId, id, c, extra = {}) {
  const existing = get('SELECT c.*, b.source FROM contacts c LEFT JOIN address_books b ON b.id = c.address_book_id WHERE c.id = ? AND c.user_id = ?', id, userId);
  if (!existing) return null;
  update('contacts', id, { ...toRow(c), auto_collected: 0, dirty: existing.source === 'carddav' ? 1 : 0, ...extra, updated_at: now() }, COLS);
  if (c.emails) syncContactEmails(id, userId, c.emails);
  queueMemory(userId, 'contact', id);
  return get('SELECT * FROM contacts WHERE id = ?', id);
}

export function deleteContact(userId, id) {
  const c = get('SELECT c.*, b.source FROM contacts c LEFT JOIN address_books b ON b.id = c.address_book_id WHERE c.id = ? AND c.user_id = ?', id, userId);
  if (!c) return;
  if (c.source === 'carddav' && c.href) { run('UPDATE contacts SET deleted = 1, dirty = 1 WHERE id = ?', id); run('DELETE FROM contact_emails WHERE contact_id = ?', id); }
  else run('DELETE FROM contacts WHERE id = ?', id);
  removeMemory(userId, 'contact', [id]);
}

export function importContacts(userId, cards, addressBookId) {
  let created = 0, updated = 0;
  tx(() => {
    for (const card of cards) {
      const existing = card.uid && get('SELECT id FROM contacts WHERE user_id = ? AND uid = ?', userId, card.uid);
      if (existing) { updateContact(userId, existing.id, card); updated++; } else { createContact(userId, { ...card, addressBookId }); created++; }
    }
  });
  return { created, updated };
}
