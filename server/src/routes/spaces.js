import { get, all, run } from '../db/index.js';
import { requireUser } from '../auth.js';
import { httpError } from './util.js';
import { listSpaces, spaceMap, cleanSpace, renameSpace } from '../spaces.js';
import { notify } from '../util/events.js';

const TABLES = { account: 'accounts', calendar: 'calendars', addressBook: 'address_books', taskList: 'task_lists' };

const host = (u) => { try { return new URL(u).host; } catch { return ''; } };
/** Where a calendar / address book / task list comes from (rows joined with their account's email and source). */
export function originOf(x) {
  if (x.email) return `${x.email} · ${x.source === 'caldav' || x.source === 'carddav' ? 'synced' : 'from this account'}`;
  if (x.sourceName || x.sourceUrl) return `${x.sourceName || host(x.sourceUrl)} · ${x.readonly ? 'read-only' : 'synced'}`;
  if (x.url) return `${host(x.url)} · ${x.readonly ? 'subscribed (read-only)' : 'synced'}`;
  return 'Kept in Halcyon only (on no other server)';
}

export default async function spaceRoutes(app) {
  app.addHook('preHandler', requireUser);

  // Everything that can be assigned to a space, with its own and its effective space.
  app.get('/api/spaces', async (req) => {
    const u = req.user.id, m = spaceMap(u);
    return {
      spaces: listSpaces(u),
      accounts: all("SELECT id, email, name, color, space, COALESCE(kind, 'mail') AS kind, mail != 0 AS mail, caldav_url IS NOT NULL AS calendar, carddav_url IS NOT NULL AS contacts FROM accounts WHERE user_id = ? ORDER BY sort_order, id", u)
        .map((a) => ({ ...a, mail: !!a.mail, calendar: !!a.calendar, contacts: !!a.contacts, space: a.space || '' })),
      // Where each calendar / address book comes from, so equally named ones ("Calendar", "Contacts") can be told apart.
      calendars: all(`SELECT c.id, c.name, c.color, c.account_id AS accountId, c.space AS ownSpace, c.source, c.url, c.readonly, c.is_default AS isDefault, a.email, s.name AS sourceName, s.url AS sourceUrl
        FROM calendars c LEFT JOIN accounts a ON a.id = c.account_id LEFT JOIN calendar_sources s ON s.id = c.source_id WHERE c.user_id = ? ORDER BY c.name`, u)
        .map((c) => ({ ...c, origin: originOf(c), space: m.calendars.get(c.id) ?? '' })),
      addressBooks: all(`SELECT b.id, b.name, b.account_id AS accountId, b.space AS ownSpace, b.source, b.url, b.readonly, b.is_default AS isDefault, a.email
        FROM address_books b LEFT JOIN accounts a ON a.id = b.account_id WHERE b.user_id = ? ORDER BY b.name`, u)
        .map((b) => ({ ...b, origin: originOf(b), space: m.books.get(b.id) ?? '' })),
      taskLists: all(`SELECT l.id, l.name, l.color, l.account_id AS accountId, l.space AS ownSpace, l.source, l.url, l.readonly, l.is_default AS isDefault, a.email
        FROM task_lists l LEFT JOIN accounts a ON a.id = l.account_id WHERE l.user_id = ? ORDER BY l.name`, u)
        .map((l) => ({ ...l, origin: originOf(l), space: m.taskLists.get(l.id) ?? '' })),
      counts: Object.fromEntries(listSpaces(u).map((s) => [s, {
        accounts: [...m.accounts.values()].filter((x) => x === s).length, calendars: [...m.calendars.values()].filter((x) => x === s).length, books: [...m.books.values()].filter((x) => x === s).length,
        taskLists: [...m.taskLists.values()].filter((x) => x === s).length,
      }])),
    };
  });

  // A space renamed (into an existing one = merged) or removed ({ to: '' }: everything in it becomes shared).
  app.post('/api/spaces/rename', async (req, reply) => {
    const from = cleanSpace(req.body?.from), to = cleanSpace(req.body?.to);
    if (!from) return httpError(reply, 400, 'Which space?');
    renameSpace(req.user.id, from, to);
    notify(req.user.id, 'spaces:changed', {});
    return { ok: true, spaces: listSpaces(req.user.id) };
  });

  // body: { type: 'account' | 'calendar' | 'addressBook', id, space } — space null on calendars/books = inherit from account.
  app.patch('/api/spaces/assign', async (req, reply) => {
    const { type, id, space } = req.body || {};
    const table = TABLES[type];
    if (!table || !get(`SELECT id FROM ${table} WHERE id = ? AND user_id = ?`, Number(id), req.user.id)) return httpError(reply, 404, 'Not found');
    const value = space === null && type !== 'account' ? null : cleanSpace(space);
    run(`UPDATE ${table} SET space = ? WHERE id = ? AND user_id = ?`, value, Number(id), req.user.id);
    notify(req.user.id, 'spaces:changed', {});
    return { ok: true };
  });
}
