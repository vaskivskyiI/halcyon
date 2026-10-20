// Spaces separate parts of a user's life (e.g. "Work" and "Private"). Accounts, calendars and address books carry a
// space label; '' means shared (visible in every space). Calendars/address books without their own label inherit the
// space of the account they sync from. A request picks its space with the x-halcyon-space header ('' = everything).
import { all, get, run, now } from './db/index.js';

export const reqSpace = (req) => {
  try { return decodeURIComponent(String(req.headers['x-halcyon-space'] || '')).trim().slice(0, 40); } catch { return ''; }
};
export const cleanSpace = (s) => String(s ?? '').trim().slice(0, 40);

/** Effective space of every account, calendar and address book of the user. */
export function spaceMap(userId) {
  const accounts = new Map(all('SELECT id, space FROM accounts WHERE user_id = ?', userId).map((a) => [a.id, a.space || '']));
  const inherit = (r) => (r.space != null ? r.space : (accounts.get(r.account_id) ?? ''));
  const calendars = new Map(all('SELECT id, account_id, space FROM calendars WHERE user_id = ?', userId).map((c) => [c.id, inherit(c)]));
  const books = new Map(all('SELECT id, account_id, space FROM address_books WHERE user_id = ?', userId).map((b) => [b.id, inherit(b)]));
  return { accounts, calendars, books };
}

export function listSpaces(userId) {
  const m = spaceMap(userId);
  return [...new Set([...m.accounts.values(), ...m.calendars.values(), ...m.books.values()].filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/**
 * Resolves a space into the ids it may see. Returns null for "all spaces" (no filtering).
 * owners: memory/fact owner keys visible in this space (see schema migration 3).
 */
export function scope(userId, space) {
  space = cleanSpace(space);
  if (!space) return null;
  const m = spaceMap(userId);
  const pick = (map) => [...map].filter(([, s]) => s === space || s === '').map(([id]) => id);
  const accountIds = pick(m.accounts), calendarIds = pick(m.calendars), bookIds = pick(m.books);
  const owners = new Set([...accountIds.map((id) => `a:${id}`), ...calendarIds.map((id) => `c:${id}`), ...bookIds.map((id) => `b:${id}`), `s:${space}`, 's:']);
  return { space, accountIds, calendarIds, bookIds, owners };
}

/** SQL fragment restricting a column to ids in the scope ('1' when unscoped, '0' when the scope has none). */
export function inIds(column, ids) {
  if (!ids) return '1';
  return ids.length ? `${column} IN (${ids.map(Number).join(',')})` : '0';
}

/** Space of a memory/fact owner key, for display. */
export function ownerSpace(userId, owner, map = spaceMap(userId)) {
  const [t, v] = [owner.slice(0, 1), owner.slice(2)];
  if (t === 's') return v;
  return ({ a: map.accounts, c: map.calendars, b: map.books }[t]?.get(Number(v))) ?? '';
}

/** Address book for contacts collected from an account: one in the account's space, created when missing. */
export function addressBookForAccount(userId, accountId) {
  const acc = accountId && get('SELECT id, space FROM accounts WHERE id = ? AND user_id = ?', accountId, userId);
  const space = acc?.space || '';
  if (space) {
    const m = spaceMap(userId);
    const ids = [...m.books].filter(([, s]) => s === space).map(([id]) => id);
    const book = ids.length && get(`SELECT * FROM address_books WHERE id IN (${ids.join(',')}) AND readonly = 0 ORDER BY account_id = ? DESC, source = 'local' DESC, id LIMIT 1`, acc.id);
    if (book) return book;
    const r = run("INSERT INTO address_books (user_id, name, source, space, created_at) VALUES (?, ?, 'local', ?, ?)", userId, `Contacts (${space})`, space, now());
    return get('SELECT * FROM address_books WHERE id = ?', r.lastInsertRowid);
  }
  return get("SELECT * FROM address_books WHERE user_id = ? AND readonly = 0 ORDER BY source = 'local' DESC, id LIMIT 1", userId);
}

/** Calendar for events coming from an account (e.g. accepted invitations): same account, else same space, else default. */
export function calendarForAccount(userId, accountId) {
  const m = spaceMap(userId);
  const space = m.accounts.get(Number(accountId)) ?? '';
  const ids = [...m.calendars].filter(([, s]) => s === space).map(([id]) => id);
  return (ids.length && get(`SELECT * FROM calendars WHERE id IN (${ids.join(',')}) AND readonly = 0 AND enabled = 1 ORDER BY account_id = ? DESC, is_default DESC, id LIMIT 1`, Number(accountId)))
    || get('SELECT * FROM calendars WHERE user_id = ? AND is_default = 1', userId);
}
