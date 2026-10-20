import { get, all, run } from '../db/index.js';
import { requireUser } from '../auth.js';
import { httpError } from './util.js';
import { listSpaces, spaceMap, cleanSpace } from '../spaces.js';
import { notify } from '../util/events.js';

const TABLES = { account: 'accounts', calendar: 'calendars', addressBook: 'address_books' };

export default async function spaceRoutes(app) {
  app.addHook('preHandler', requireUser);

  // Everything that can be assigned to a space, with its own and its effective space.
  app.get('/api/spaces', async (req) => {
    const u = req.user.id, m = spaceMap(u);
    return {
      spaces: listSpaces(u),
      accounts: all('SELECT id, email, name, color, space FROM accounts WHERE user_id = ? ORDER BY sort_order, id', u).map((a) => ({ ...a, space: a.space || '' })),
      calendars: all('SELECT id, name, color, account_id AS accountId, space AS ownSpace FROM calendars WHERE user_id = ? ORDER BY name', u).map((c) => ({ ...c, space: m.calendars.get(c.id) ?? '' })),
      addressBooks: all('SELECT id, name, account_id AS accountId, space AS ownSpace FROM address_books WHERE user_id = ? ORDER BY name', u).map((b) => ({ ...b, space: m.books.get(b.id) ?? '' })),
    };
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
