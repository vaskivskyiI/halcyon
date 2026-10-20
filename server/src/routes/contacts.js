import { get, all, run, now, json } from '../db/index.js';
import { requireUser } from '../auth.js';
import { httpError } from './util.js';
import { serializeContact, autocomplete } from '../contacts/service.js';
import { createContact, updateContact, deleteContact, importContacts } from '../contacts/repo.js';
import { parseVCards, toVCard } from '../contacts/vcard.js';
import { notify } from '../util/events.js';
import { serializeMessage } from '../mail/store.js';
import { scope, reqSpace, spaceMap, inIds } from '../spaces.js';

export default async function contactRoutes(app) {
  app.addHook('preHandler', requireUser);

  app.get('/api/address-books', async (req) => {
    const sc = scope(req.user.id, reqSpace(req)), spaces = spaceMap(req.user.id);
    return all(`SELECT id, name, source, account_id AS accountId, readonly, space AS ownSpace FROM address_books WHERE user_id = ? AND ${inIds('id', sc?.bookIds)}`, req.user.id)
      .map((b) => ({ ...b, space: spaces.books.get(b.id) ?? '' }));
  });

  app.get('/api/contacts', async (req) => {
    const { q, group, filter } = req.query;
    const sc = scope(req.user.id, reqSpace(req));
    const where = ['c.user_id = ?', 'c.deleted = 0', inIds('c.address_book_id', sc?.bookIds)], params = [req.user.id];
    if (q) { where.push("(c.display_name LIKE ? OR c.emails_json LIKE ? OR c.org LIKE ? OR c.phones_json LIKE ?)"); params.push(...Array(4).fill(`%${q}%`)); }
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
    // Without an explicit address book, a contact created while a space is active goes into that space.
    const sc = !b.addressBookId && scope(req.user.id, reqSpace(req));
    if (sc) {
      const spaces = spaceMap(req.user.id);
      const own = sc.bookIds.filter((id) => spaces.books.get(id) === sc.space);
      b.addressBookId = get(`SELECT id FROM address_books WHERE ${inIds('id', own.length ? own : sc.bookIds)} AND readonly = 0 ORDER BY source = 'local' DESC, id LIMIT 1`)?.id;
    }
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
