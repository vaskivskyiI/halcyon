import { get, all, run, json, now, tx, fold } from '../db/index.js';
import { uuid } from '../util/crypto.js';
import { addressBookForAccount, inIds } from '../spaces.js';

export function syncContactEmails(contactId, userId, emails) {
  run('DELETE FROM contact_emails WHERE contact_id = ?', contactId);
  for (const e of emails || []) if (e?.value) run('INSERT INTO contact_emails (contact_id, user_id, email) VALUES (?, ?, ?)', contactId, userId, e.value.toLowerCase());
}

export function defaultAddressBook(userId) {
  return get("SELECT * FROM address_books WHERE user_id = ? ORDER BY source = 'local' DESC, id LIMIT 1", userId);
}

/** Records correspondents. `create` = create contacts for unknown addresses (used for recipients we wrote to). */
export function collectAddresses(userId, addrs, date, create, accountId = null) {
  const book = create ? addressBookForAccount(userId, accountId) : null;
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

/**
 * Recipients for what was typed (accents ignored: "sasa" finds Saša): contacts first, then people from the mail of the
 * last two years (who wrote to the user, or whom the user wrote to) — also those never saved as contacts.
 */
export function autocomplete(userId, q, limit = 8, sc = null) {
  const like = `%${fold(q)}%`;
  const rows = all(`SELECT c.*, ce.email FROM contact_emails ce JOIN contacts c ON c.id = ce.contact_id
    WHERE ce.user_id = ? AND c.deleted = 0 AND ${inIds('c.address_book_id', sc?.bookIds)} AND (fold(ce.email) LIKE ? OR fold(c.display_name) LIKE ?)
    ORDER BY c.favorite DESC, c.contact_count DESC, c.last_contacted DESC LIMIT ?`, userId, like, like, limit);
  const out = rows.map((r) => ({ contactId: r.id, name: r.display_name, address: r.email, photo: r.photo }));
  if (out.length >= limit || !q.trim()) return out;
  const have = new Set(out.map((r) => r.address.toLowerCase()));
  const since = now() - 2 * 365 * 864e5;
  const seen = new Map();
  const note = (address, name, n) => {
    const a = String(address || '').toLowerCase();
    if (!a.includes('@') || have.has(a) || /no-?reply|mailer-daemon|notifications?@|bounce/i.test(a)) return;
    if (!fold(a).includes(fold(q)) && !fold(name || '').includes(fold(q))) return;
    const s = seen.get(a) || { name: '', n: 0 };
    seen.set(a, { name: s.name || name || '', n: s.n + n });
  };
  const accounts = inIds('m.account_id', sc?.accountIds);
  for (const r of all(`SELECT m.from_addr AS a, MAX(m.from_name) AS name, COUNT(*) AS n FROM messages m WHERE m.user_id = ? AND ${accounts} AND m.date > ?
      AND (fold(m.from_addr) LIKE ? OR fold(m.from_name) LIKE ?) GROUP BY lower(m.from_addr) ORDER BY n DESC LIMIT 20`, userId, since, like, like)) note(r.a, r.name, r.n);
  // Whom the user wrote to counts more.
  for (const r of all(`SELECT m.to_json, m.cc_json FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.user_id = ? AND ${accounts} AND f.special_use = '\\Sent'
      AND m.date > ? AND (fold(m.to_json) LIKE ? OR fold(m.cc_json) LIKE ?) ORDER BY m.date DESC LIMIT 200`, userId, since, like, like)) {
    for (const x of [...json(r.to_json, []), ...json(r.cc_json, [])]) note(x.address, x.name, 3);
  }
  const more = [...seen].sort((x, y) => y[1].n - x[1].n).slice(0, limit - out.length);
  return [...out, ...more.map(([address, s]) => ({ contactId: null, name: s.name || null, address, photo: null }))];
}

export function contactByEmail(userId, email) {
  const hit = get('SELECT contact_id FROM contact_emails WHERE user_id = ? AND email = ?', userId, String(email).toLowerCase());
  return hit ? get('SELECT * FROM contacts WHERE id = ?', hit.contact_id) : null;
}
