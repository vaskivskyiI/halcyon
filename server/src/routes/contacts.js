import { get, all, run, now, json, tx, fold } from '../db/index.js';
import { requireUser } from '../auth.js';
import { httpError } from './util.js';
import { serializeContact, autocomplete } from '../contacts/service.js';
import { createContact, updateContact, deleteContact, importContacts } from '../contacts/repo.js';
import { parseVCards, toVCard } from '../contacts/vcard.js';
import { notify } from '../util/events.js';
import { serializeMessage } from '../mail/store.js';
import { scope, reqSpace, spaceMap, inIds, spaceDefault } from '../spaces.js';
import { originOf } from './spaces.js';
import { queueMemory } from '../ai/queue.js';
import { syncDav } from '../scheduler.js';
import { targetsForMessage } from '../targets.js';

export default async function contactRoutes(app) {
  app.addHook('preHandler', requireUser);

  // ?all=1: every address book of every space, hidden ones too, with its number of contacts.
  app.get('/api/address-books', async (req) => {
    const every = req.query.all === '1';
    const sc = every ? null : scope(req.user.id, reqSpace(req)), spaces = spaceMap(req.user.id);
    return all(`SELECT b.id, b.name, b.source, b.account_id AS accountId, b.readonly, b.is_default AS isDefault, b.space AS ownSpace, COALESCE(b.hidden, 0) AS hidden, a.email,
        (SELECT COUNT(*) FROM contacts c WHERE c.address_book_id = b.id AND c.deleted = 0) AS contacts
      FROM address_books b LEFT JOIN accounts a ON a.id = b.account_id WHERE b.user_id = ? AND ${inIds('b.id', sc?.bookIds)} ${every ? '' : 'AND COALESCE(b.hidden, 0) = 0'} ORDER BY b.name`, req.user.id)
      .map((b) => ({ ...b, readonly: !!b.readonly, isDefault: !!b.isDefault, hidden: !!b.hidden, origin: originOf(b), space: spaces.books.get(b.id) ?? '' }));
  });

  // Contacts of a local address book moved into another one (e.g. the synced book of an account, so they go to its
  // server). Saved contacts are uploaded — unless the target already has the person (same UID or a shared email
  // address): those are skipped and stay. Addresses collected from mail (for suggestions) move along but stay in
  // Halcyon: they are never uploaded as contacts. Nothing is deleted.
  app.post('/api/address-books/:id/move-contacts', async (req, reply) => {
    const from = get('SELECT * FROM address_books WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    const to = get('SELECT * FROM address_books WHERE id = ? AND user_id = ? AND readonly = 0', Number(req.body?.to), req.user.id);
    if (!from || !to || to.id === from.id) return httpError(reply, 404, 'Not found');
    if (from.source !== 'local') return httpError(reply, 400, 'Only contacts of an address book kept in Halcyon can be moved');
    const dav = to.source === 'carddav' ? 1 : 0;
    const uids = new Set(all('SELECT uid FROM contacts WHERE address_book_id = ? AND deleted = 0', to.id).map((r) => r.uid));
    const emails = new Set(all('SELECT lower(e.email) AS e FROM contact_emails e JOIN contacts c ON c.id = e.contact_id WHERE c.address_book_id = ? AND c.deleted = 0', to.id).map((r) => r.e));
    let moved = 0, skipped = 0, collected = 0;
    tx(() => {
      for (const c of all('SELECT * FROM contacts WHERE address_book_id = ? AND deleted = 0', from.id)) {
        const mine = all('SELECT lower(email) AS e FROM contact_emails WHERE contact_id = ?', c.id).map((r) => r.e);
        const saved = !c.auto_collected || c.favorite;
        if (uids.has(c.uid) || mine.some((e) => emails.has(e))) { skipped++; continue; }
        run('UPDATE contacts SET address_book_id = ?, href = NULL, etag = NULL, dirty = ?, updated_at = ? WHERE id = ?', to.id, saved ? dav : 0, now(), c.id);
        if (saved) { moved++; queueMemory(req.user.id, 'contact', c.id); } else collected++;
      }
    });
    const acc = to.account_id && get('SELECT * FROM accounts WHERE id = ?', to.account_id);
    if (acc?.carddav_url && moved) syncDav(acc).catch(() => {});
    notify(req.user.id, 'contacts:changed', {});
    return { moved, skipped, collected };
  });

  // A local address book is deleted with its contacts (another one takes over as the default); one from a server
  // (CardDAV) is only hidden — it would come back with the next sync and stays on the server.
  app.delete('/api/address-books/:id', async (req, reply) => {
    const b = get('SELECT * FROM address_books WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!b) return httpError(reply, 404, 'Not found');
    const next = get('SELECT id FROM address_books WHERE user_id = ? AND id != ? AND readonly = 0 ORDER BY COALESCE(hidden, 0), id LIMIT 1', req.user.id, b.id);
    if (!next) return httpError(reply, 400, 'This is your only address book');
    if (b.source !== 'local') run('UPDATE address_books SET hidden = 1, is_default = 0 WHERE id = ?', b.id);
    else {
      run('DELETE FROM contact_emails WHERE contact_id IN (SELECT id FROM contacts WHERE address_book_id = ?)', b.id);
      run('DELETE FROM contacts WHERE address_book_id = ?', b.id);
      run('DELETE FROM address_books WHERE id = ?', b.id);
    }
    if (b.is_default) run('UPDATE address_books SET is_default = 1, hidden = 0 WHERE id = ?', next.id);
    notify(req.user.id, 'contacts:changed', {});
    return { ok: true, hidden: b.source !== 'local' };
  });

  // Renamed, or made the default for new contacts.
  app.patch('/api/address-books/:id', async (req, reply) => {
    const b = get('SELECT * FROM address_books WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!b) return httpError(reply, 404, 'Not found');
    const { name, isDefault, hidden } = req.body || {};
    if (name !== undefined && String(name).trim()) run('UPDATE address_books SET name = ? WHERE id = ?', String(name).trim().slice(0, 80), b.id);
    if (hidden !== undefined) run('UPDATE address_books SET hidden = ? WHERE id = ?', hidden ? 1 : 0, b.id);
    if (isDefault) { run('UPDATE address_books SET is_default = 0 WHERE user_id = ?', req.user.id); run('UPDATE address_books SET is_default = 1, hidden = 0 WHERE id = ?', b.id); }
    notify(req.user.id, 'contacts:changed', {});
    return { ok: true };
  });

  // Where an event, task or contact made from this email goes: the calendar, task list and address book of its space.
  app.get('/api/messages/:id/targets', async (req, reply) => targetsForMessage(req.user.id, req.params.id) || httpError(reply, 404, 'Not found'));

  // The sender of an email saved as a contact, in the address book of the email's space. Someone already known only as
  // a collected address becomes a saved contact (moved there, uploaded when that book is synced) — no duplicate.
  app.post('/api/messages/:id/save-sender', async (req, reply) => {
    const m = get('SELECT from_name, from_addr FROM messages WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    const t = m && targetsForMessage(req.user.id, req.params.id);
    if (!m || !t?.bookId) return httpError(reply, 404, 'Not found');
    const email = String(m.from_addr || '').toLowerCase();
    const known = get('SELECT c.* FROM contact_emails e JOIN contacts c ON c.id = e.contact_id WHERE e.user_id = ? AND e.email = ? AND c.deleted = 0 ORDER BY c.auto_collected, c.id LIMIT 1', req.user.id, email);
    if (known && !known.auto_collected) return { contact: serializeContact(known), existed: true };
    const book = get('SELECT * FROM address_books WHERE id = ?', t.bookId);
    let c;
    if (known) {
      run('UPDATE contacts SET auto_collected = 0, address_book_id = ?, display_name = COALESCE(NULLIF(?, \'\'), display_name), href = NULL, etag = NULL, dirty = ?, updated_at = ? WHERE id = ?',
        book.id, m.from_name || '', book.source === 'carddav' ? 1 : 0, now(), known.id);
      c = get('SELECT * FROM contacts WHERE id = ?', known.id);
    } else {
      const name = m.from_name || email.split('@')[0];
      const [first, ...rest] = name.split(' ');
      c = createContact(req.user.id, { displayName: name, firstName: first, lastName: rest.join(' '), emails: [{ type: 'work', value: email }], addressBookId: book.id });
    }
    const acc = book.account_id && get('SELECT * FROM accounts WHERE id = ?', book.account_id);
    if (acc?.carddav_url) syncDav(acc).catch(() => {});
    notify(req.user.id, 'contacts:changed', {});
    return { contact: serializeContact(c), book: book.name };
  });

  app.get('/api/contacts', async (req) => {
    const { q, group, filter } = req.query;
    const sc = scope(req.user.id, reqSpace(req));
    const where = ['c.user_id = ?', 'c.deleted = 0', inIds('c.address_book_id', sc?.bookIds), 'c.address_book_id NOT IN (SELECT id FROM address_books WHERE hidden = 1)'], params = [req.user.id];
    if (q) { where.push('(fold(c.display_name) LIKE ? OR fold(c.emails_json) LIKE ? OR fold(c.org) LIKE ? OR c.phones_json LIKE ?)'); params.push(...Array(4).fill(`%${fold(q)}%`)); }
    if (group) { where.push('EXISTS (SELECT 1 FROM json_each(c.groups_json) j WHERE j.value = ?)'); params.push(group); }
    if (filter === 'favorites') where.push('c.favorite = 1');
    if (filter === 'collected') where.push('c.auto_collected = 1');
    if (filter === 'saved') where.push('c.auto_collected = 0');
    return all(`SELECT c.* FROM contacts c WHERE ${where.join(' AND ')} ORDER BY c.favorite DESC, lower(c.display_name) LIMIT 5000`, ...params).map(serializeContact);
  });

  app.get('/api/contacts/autocomplete', async (req) => autocomplete(req.user.id, String(req.query.q || ''), 8, scope(req.user.id, reqSpace(req))));

  app.get('/api/contacts/groups', async (req) => all("SELECT j.value AS name, COUNT(*) AS count FROM contacts c, json_each(c.groups_json) j WHERE c.user_id = ? AND c.deleted = 0 GROUP BY j.value ORDER BY j.value", req.user.id));

  app.get('/api/contacts/export.vcf', async (req, reply) => {
    const list = all('SELECT * FROM contacts WHERE user_id = ? AND deleted = 0 AND auto_collected = ?', req.user.id, req.query.collected === '1' ? 1 : 0).map(serializeContact);
    reply.header('content-type', 'text/vcard; charset=utf-8');
    reply.header('content-disposition', 'attachment; filename="contacts.vcf"');
    return list.map(toVCard).join('');
  });

  app.post('/api/contacts/import', async (req, reply) => {
    const text = String(req.body?.vcf || '');
    const cards = text.includes('BEGIN:VCARD') ? parseVCards(text) : parseCsv(text);
    if (!cards.length) return httpError(reply, 400, 'No contacts found in file');
    const r = importContacts(req.user.id, cards, req.body?.addressBookId);
    notify(req.user.id, 'contacts:changed', {});
    return r;
  });

  app.get('/api/contacts/:id', async (req, reply) => {
    const c = get('SELECT * FROM contacts WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!c) return httpError(reply, 404, 'Not found');
    const sc = scope(req.user.id, reqSpace(req));
    const emails = json(c.emails_json, []).map((e) => e.value.toLowerCase());
    const recent = emails.length ? all(`SELECT * FROM messages WHERE user_id = ? AND ${inIds('account_id', sc?.accountIds)} AND (from_addr IN (${emails.map(() => '?').join(',')}) OR ${emails.map(() => 'to_json LIKE ?').join(' OR ')}) ORDER BY date DESC LIMIT 15`,
      req.user.id, ...emails, ...emails.map((e) => `%"${e}"%`)).map((m) => serializeMessage(m)) : [];
    const events = emails.length ? all(`SELECT e.id, e.title, e.start FROM events e JOIN calendars k ON k.id = e.calendar_id WHERE k.user_id = ? AND ${inIds('k.id', sc?.calendarIds)} AND e.deleted = 0 AND (${emails.map(() => 'e.attendees_json LIKE ?').join(' OR ')}) ORDER BY e.start DESC LIMIT 10`, req.user.id, ...emails.map((e) => `%${e}%`)) : [];
    return { ...serializeContact(c), recentMessages: recent, events };
  });

  app.post('/api/contacts', async (req, reply) => {
    const b = req.body || {};
    if (!b.displayName && !b.firstName && !b.lastName && !b.emails?.length) return httpError(reply, 400, 'Name or email required');
    // Without an explicit address book: the default chosen for the space (Settings → Spaces); else, while a space is
    // active, a book of that space; else the default address book.
    if (!b.addressBookId) b.addressBookId = spaceDefault(req.user.id, reqSpace(req), 'bookId') || undefined;
    const sc = !b.addressBookId && scope(req.user.id, reqSpace(req));
    if (sc) {
      const spaces = spaceMap(req.user.id);
      const own = sc.bookIds.filter((id) => spaces.books.get(id) === sc.space);
      b.addressBookId = get(`SELECT id FROM address_books WHERE ${inIds('id', own.length ? own : sc.bookIds)} AND readonly = 0 ORDER BY source = 'local' DESC, id LIMIT 1`)?.id;
    }
    if (!b.addressBookId) b.addressBookId = get('SELECT id FROM address_books WHERE user_id = ? AND is_default = 1 AND readonly = 0', req.user.id)?.id;
    const c = createContact(req.user.id, b);
    notify(req.user.id, 'contacts:changed', {});
    return serializeContact(c);
  });

  app.patch('/api/contacts/:id', async (req, reply) => {
    const c = updateContact(req.user.id, Number(req.params.id), req.body || {});
    if (!c) return httpError(reply, 404, 'Not found');
    notify(req.user.id, 'contacts:changed', {});
    return serializeContact(c);
  });

  app.delete('/api/contacts/:id', async (req) => {
    deleteContact(req.user.id, Number(req.params.id));
    notify(req.user.id, 'contacts:changed', {});
    return { ok: true };
  });

  app.post('/api/contacts/merge', async (req, reply) => {
    const [keepId, ...rest] = (req.body?.ids || []).map(Number);
    const keep = get('SELECT * FROM contacts WHERE id = ? AND user_id = ?', keepId, req.user.id);
    if (!keep || !rest.length) return httpError(reply, 400, 'Select at least two contacts');
    const k = serializeContact(keep);
    for (const id of rest) {
      const o = get('SELECT * FROM contacts WHERE id = ? AND user_id = ?', id, req.user.id);
      if (!o) continue;
      const x = serializeContact(o);
      const uniq = (arr) => [...new Map(arr.map((v) => [String(v.value || JSON.stringify(v)).toLowerCase(), v])).values()];
      k.emails = uniq([...k.emails, ...x.emails]); k.phones = uniq([...k.phones, ...x.phones]); k.addresses = [...k.addresses, ...x.addresses];
      k.groups = [...new Set([...k.groups, ...x.groups])];
      for (const f of ['org', 'title', 'birthday', 'notes', 'photo', 'website', 'nickname']) k[f] ||= x[f];
      deleteContact(req.user.id, id);
    }
    const c = updateContact(req.user.id, keepId, k);
    notify(req.user.id, 'contacts:changed', {});
    return serializeContact(c);
  });
}

// CSV import (Outlook / Google exports): maps common header names.
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; continue; }
    if (ch === '"') q = true; else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  if (rows.length < 2) return [];
  const h = rows[0].map((x) => x.trim().toLowerCase());
  const col = (...names) => h.findIndex((x) => names.includes(x));
  const idx = {
    first: col('first name', 'given name'), last: col('last name', 'family name'), name: col('name', 'display name', 'full name'),
    email: col('e-mail address', 'email', 'e-mail 1 - value', 'email address', 'primary email'), email2: col('e-mail 2 address', 'e-mail 2 - value'),
    phone: col('mobile phone', 'phone 1 - value', 'primary phone', 'phone', 'business phone'), org: col('company', 'organization 1 - name', 'organization'),
    title: col('job title', 'organization 1 - title', 'title'), notes: col('notes'), birthday: col('birthday'),
  };
  return rows.slice(1).filter((r) => r.some((c) => c.trim())).map((r) => {
    const v = (i) => (i >= 0 ? (r[i] || '').trim() : '');
    const emails = [v(idx.email), v(idx.email2)].filter(Boolean).map((value) => ({ type: 'other', value }));
    return {
      firstName: v(idx.first), lastName: v(idx.last), displayName: v(idx.name) || [v(idx.first), v(idx.last)].filter(Boolean).join(' ') || emails[0]?.value,
      emails, phones: v(idx.phone) ? [{ type: 'mobile', value: v(idx.phone) }] : [], org: v(idx.org), title: v(idx.title), notes: v(idx.notes), birthday: v(idx.birthday),
    };
  }).filter((c) => c.displayName);
}
