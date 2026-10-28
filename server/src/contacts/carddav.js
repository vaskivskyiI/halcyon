// CardDAV two-way sync using tsdav.
import { DAVClient } from 'tsdav';
import { Agent, fetch as undiciFetch } from 'undici';
import { tlsOf } from '../mail/connection.js';
import { get, all, run, now, tx, json } from '../db/index.js';
import { decrypt } from '../util/crypto.js';
import { accessToken, isOAuth } from '../mail/oauth.js';
import { parseVCards, toVCard } from './vcard.js';
import { createContact, updateContact } from './repo.js';
import { serializeContact } from './service.js';
import { logger } from '../util/log.js';

const log = logger('carddav');

// An account with its own certificate settings talks to its DAV server through an agent that uses them.
const agents = new Map();
function davFetch(account) {
  const t = tlsOf(account);
  if (t.rejectUnauthorized && !t.ca) return {};
  const key = `${t.rejectUnauthorized}|${String(account.tls_ca || '').length}|${account.id}`;
  if (!agents.has(key)) agents.set(key, new Agent({ connect: t }));
  const dispatcher = agents.get(key);
  return { fetch: (url, init = {}) => undiciFetch(url, { ...init, dispatcher }) };
}

export async function davClient(account, serverUrl, accountType) {
  const credentials = isOAuth(account)
    ? { accessToken: await accessToken(account) }
    : { username: account.dav_user || account.imap_user || account.email, password: decrypt(account.dav_pass_enc) || decrypt(account.imap_pass_enc) };
  const client = new DAVClient({ serverUrl, credentials, authMethod: isOAuth(account) ? 'Oauth' : 'Basic', defaultAccountType: accountType, ...davFetch(account) });
  await client.login();
  return client;
}

export async function syncCardDav(account) {
  if (!account.carddav_url) return;
  const client = await davClient(account, account.carddav_url, 'carddav');
  const books = await client.fetchAddressBooks();
  for (const remote of books) {
    let book = get('SELECT * FROM address_books WHERE user_id = ? AND url = ?', account.user_id, remote.url);
    if (!book) {
      const r = run("INSERT INTO address_books (user_id, account_id, name, source, url, created_at) VALUES (?, ?, ?, 'carddav', ?, ?)",
        account.user_id, account.id, typeof remote.displayName === 'string' ? remote.displayName : 'Contacts', remote.url, now());
      book = get('SELECT * FROM address_books WHERE id = ?', r.lastInsertRowid);
    }
    // Push local changes first.
    for (const c of all('SELECT * FROM contacts WHERE address_book_id = ? AND dirty = 1', book.id)) {
      try {
        if (c.deleted) {
          if (c.href) await client.deleteVCard({ vCard: { url: c.href, etag: c.etag } });
          run('DELETE FROM contacts WHERE id = ?', c.id);
        } else if (c.href) {
          const res = await client.updateVCard({ vCard: { url: c.href, etag: c.etag, data: toVCard(serializeContact(c)) } });
          run('UPDATE contacts SET dirty = 0, etag = ? WHERE id = ?', res.headers?.get?.('etag') || null, c.id);
        } else {
          const filename = `${c.uid}.vcf`;
          await client.createVCard({ addressBook: remote, filename, vCardString: toVCard(serializeContact(c)) });
          run('UPDATE contacts SET dirty = 0, href = ? WHERE id = ?', new URL(filename, remote.url).href, c.id);
        }
      } catch (e) { log.warn(`push contact ${c.id}: ${e.message}`); }
    }
    if (book.ctag && remote.ctag && book.ctag === remote.ctag) continue;
    const cards = await client.fetchVCards({ addressBook: remote });
    const seen = new Set();
    tx(() => {
      for (const v of cards) {
        seen.add(v.url);
        const local = get('SELECT * FROM contacts WHERE address_book_id = ? AND href = ?', book.id, v.url);
        if (local && local.etag === v.etag && v.etag) continue;
        const parsed = parseVCards(v.data)[0];
        if (!parsed) continue;
        if (local) updateContact(account.user_id, local.id, parsed, { dirty: 0, etag: v.etag, href: v.url });
        else createContact(account.user_id, { ...parsed, addressBookId: book.id }, { dirty: 0, etag: v.etag, href: v.url });
      }
      for (const c of all('SELECT id, href FROM contacts WHERE address_book_id = ? AND href IS NOT NULL AND dirty = 0', book.id)) {
        if (!seen.has(c.href)) run('DELETE FROM contacts WHERE id = ?', c.id);
      }
      run('UPDATE address_books SET ctag = ? WHERE id = ?', remote.ctag || null, book.id);
    });
  }
  return { books: books.length };
}
