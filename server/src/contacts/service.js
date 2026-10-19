import { get, all, run, json, now, tx } from '../db/index.js';
import { uuid } from '../util/crypto.js';

export function syncContactEmails(contactId, userId, emails) {
  run('DELETE FROM contact_emails WHERE contact_id = ?', contactId);
  for (const e of emails || []) if (e?.value) run('INSERT INTO contact_emails (contact_id, user_id, email) VALUES (?, ?, ?)', contactId, userId, e.value.toLowerCase());
}

export function defaultAddressBook(userId) {
  return get("SELECT * FROM address_books WHERE user_id = ? ORDER BY source = 'local' DESC, id LIMIT 1", userId);
}

/** Records correspondents. `create` = create contacts for unknown addresses (used for recipients we wrote to). */
export function collectAddresses(userId, addrs, date, create) {
  const book = defaultAddressBook(userId);
  tx(() => {
    for (const a of addrs) {
      const email = (a.address || '').toLowerCase();
      if (!email || /no-?reply|mailer-daemon|notifications?@|bounce/i.test(email)) continue;
      const hit = get('SELECT contact_id FROM contact_emails WHERE user_id = ? AND email = ?', userId, email);
      if (hit) {
        run('UPDATE contacts SET contact_count = contact_count + 1, last_contacted = MAX(COALESCE(last_contacted, 0), ?) WHERE id = ?', date || now(), hit.contact_id);
      } else if (create && book) {
        const name = a.name || email.split('@')[0];
        const [first, ...rest] = name.split(' ');
        const r = run(`INSERT INTO contacts (user_id, address_book_id, uid, display_name, first_name, last_name, emails_json, auto_collected, contact_count, last_contacted, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`, userId, book.id, uuid(), name, first, rest.join(' '), JSON.stringify([{ type: 'work', value: email }]), date || now(), now(), now());
        syncContactEmails(r.lastInsertRowid, userId, [{ value: email }]);
      }
    }
  });
}

export function serializeContact(c) {
  return {
    id: c.id, addressBookId: c.address_book_id, uid: c.uid, displayName: c.display_name, firstName: c.first_name, lastName: c.last_name,
    nickname: c.nickname, emails: json(c.emails_json, []), phones: json(c.phones_json, []), addresses: json(c.addresses_json, []),
    org: c.org, title: c.title, birthday: c.birthday, notes: c.notes, photo: c.photo, website: c.website, groups: json(c.groups_json, []),
    favorite: !!c.favorite, autoCollected: !!c.auto_collected, lastContacted: c.last_contacted, contactCount: c.contact_count,
  };
}

export function autocomplete(userId, q, limit = 8) {
  const like = `%${q.toLowerCase()}%`;
  const rows = all(`SELECT c.*, ce.email FROM contact_emails ce JOIN contacts c ON c.id = ce.contact_id
    WHERE ce.user_id = ? AND c.deleted = 0 AND (ce.email LIKE ? OR lower(c.display_name) LIKE ?)
    ORDER BY c.favorite DESC, c.contact_count DESC, c.last_contacted DESC LIMIT ?`, userId, like, like, limit);
  return rows.map((r) => ({ contactId: r.id, name: r.display_name, address: r.email, photo: r.photo }));
}

export function contactByEmail(userId, email) {
  const hit = get('SELECT contact_id FROM contact_emails WHERE user_id = ? AND email = ?', userId, String(email).toLowerCase());
  return hit ? get('SELECT * FROM contacts WHERE id = ?', hit.contact_id) : null;
}
