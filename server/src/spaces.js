// Spaces separate parts of a user's life (e.g. "Work" and "Private"). Accounts, calendars and address books carry a
// space label; '' means shared (visible in every space). Calendars/address books/task lists without their own label inherit the
// space of the account they sync from. A request picks its space with the x-halcyon-space header ('' = everything).
import { all, get, run, now, json } from './db/index.js';
import { getSettings } from './settings.js';

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
  const taskLists = new Map(all('SELECT id, account_id, space FROM task_lists WHERE user_id = ?', userId).map((l) => [l.id, inherit(l)]));
  return { accounts, calendars, books, taskLists };
}

export function listSpaces(userId) {
  const m = spaceMap(userId);
  return [...new Set([...m.accounts.values(), ...m.calendars.values(), ...m.books.values(), ...m.taskLists.values()].filter(Boolean))].sort((a, b) => a.localeCompare(b));
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
  const accountIds = pick(m.accounts), calendarIds = pick(m.calendars), bookIds = pick(m.books), taskListIds = pick(m.taskLists);
  const owners = new Set([...accountIds.map((id) => `a:${id}`), ...calendarIds.map((id) => `c:${id}`), ...bookIds.map((id) => `b:${id}`), `s:${space}`, 's:']);
  return { space, accountIds, calendarIds, bookIds, taskListIds, owners };
}

/** SQL fragment restricting a column to ids in the scope ('1' when unscoped, '0' when the scope has none). */
export function inIds(column, ids) {
  if (!ids) return '1';
  return ids.length ? `${column} IN (${ids.map(Number).join(',')})` : '0';
}

const DEFAULT_SQL = {
  accountId: "SELECT id FROM accounts WHERE id = ? AND user_id = ? AND mail != 0 AND COALESCE(kind, 'mail') != 'archive'",
  calendarId: 'SELECT id FROM calendars WHERE id = ? AND user_id = ? AND readonly = 0',
  bookId: 'SELECT id FROM address_books WHERE id = ? AND user_id = ? AND readonly = 0',
  taskListId: 'SELECT id FROM task_lists WHERE id = ? AND user_id = ? AND readonly = 0',
};
/** The default chosen for a space (Settings → Spaces): kind 'accountId' | 'calendarId' | 'bookId' | 'taskListId'; null if none (or gone). */
export function spaceDefault(userId, space, kind) {
  const id = Number(getSettings(userId).defaults?.[cleanSpace(space)]?.[kind]);
  return id && get(DEFAULT_SQL[kind], id, userId) ? id : null;
}

/**
 * A space renamed (merged into another, when that name exists) or removed (to = ''): what was in it — accounts,
 * calendars, address books, calendar sources, what the assistant knows for it, its defaults — moves along / becomes
 * shared. Nothing is deleted.
 */
export function renameSpace(userId, from, to) {
  from = cleanSpace(from); to = cleanSpace(to);
  if (!from || from === to) return;
  run('UPDATE accounts SET space = ? WHERE user_id = ? AND space = ?', to, userId, from);
  for (const t of ['calendars', 'address_books', 'task_lists']) {
    // Removed: one that syncs from an account follows the account again; others become shared.
    run(`UPDATE ${t} SET space = ${to ? '?' : "CASE WHEN account_id IS NULL THEN '' ELSE NULL END"} WHERE user_id = ? AND space = ?`, ...(to ? [to] : []), userId, from);
  }
  run('UPDATE calendar_sources SET space = ? WHERE user_id = ? AND space = ?', to, userId, from);
  run('UPDATE facts SET owner = ? WHERE user_id = ? AND owner = ?', `s:${to}`, userId, `s:${from}`);
  run('UPDATE memory SET owner = ? WHERE user_id = ? AND owner = ?', `s:${to}`, userId, `s:${from}`);
  const s = json(get('SELECT settings_json FROM users WHERE id = ?', userId)?.settings_json, {});
  if (s.defaults?.[from]) {
    if (to && !s.defaults[to]) s.defaults[to] = s.defaults[from];
    delete s.defaults[from];
    run('UPDATE users SET settings_json = ? WHERE id = ?', JSON.stringify(s), userId);
  }
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
    // The account's own book, else the default, else a synced one (the server has it) — never a hidden one.
    const book = ids.length && get(`SELECT * FROM address_books WHERE id IN (${ids.join(',')}) AND readonly = 0 AND COALESCE(hidden, 0) = 0
      ORDER BY account_id = ? DESC, is_default DESC, source = 'carddav' DESC, id LIMIT 1`, acc.id);
    if (book) return book;
    const r = run("INSERT INTO address_books (user_id, name, source, space, created_at) VALUES (?, ?, 'local', ?, ?)", userId, `Contacts (${space})`, space, now());
    return get('SELECT * FROM address_books WHERE id = ?', r.lastInsertRowid);
  }
  return get("SELECT * FROM address_books WHERE user_id = ? AND readonly = 0 ORDER BY COALESCE(hidden, 0), is_default DESC, source = 'carddav' DESC, id LIMIT 1", userId);
}

/** Calendar for events coming from an account (e.g. accepted invitations): same account, else same space, else default. */
export function calendarForAccount(userId, accountId) {
  const m = spaceMap(userId);
  const space = m.accounts.get(Number(accountId)) ?? '';
  const ids = [...m.calendars].filter(([, s]) => s === space).map(([id]) => id);
  return (ids.length && get(`SELECT * FROM calendars WHERE id IN (${ids.join(',')}) AND readonly = 0 AND enabled = 1 ORDER BY account_id = ? DESC, is_default DESC, id LIMIT 1`, Number(accountId)))
    || get('SELECT * FROM calendars WHERE user_id = ? AND is_default = 1', userId);
}
