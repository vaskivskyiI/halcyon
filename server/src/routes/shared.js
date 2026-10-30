// Shared spaces (see shared.js): create, members, moving an account / calendar / address book / tasks in and out, and
// entering one (the halcyon_as cookie). Always act as the person (auth.js PERSON_ONLY).
import { requireUser, AS_COOKIE } from '../auth.js';
import { get, all } from '../db/index.js';
import { httpError } from './util.js';
import { config } from '../config.js';
import * as S from '../shared.js';

export default async function sharedRoutes(app) {
  app.addHook('preHandler', requireUser);
  const member = (req, reply, owner = false) => {
    const id = Number(req.params.id);
    const role = S.membership(id, req.user.id);
    if (!role || (owner && role !== 'owner')) { httpError(reply, 403, owner ? 'Only the owner of the shared space can do this' : 'You are not a member of this shared space'); return null; }
    return id;
  };
  const guard = async (reply, fn) => { try { return await fn(); } catch (e) { return httpError(reply, 400, e.message); } };

  app.get('/api/shared', async (req) => S.sharedOf(req.user.id).map((s) => ({
    ...s,
    members: S.membersOf(s.id).map((m) => ({ id: m.id, name: m.name, email: m.email, role: m.role, you: m.id === req.user.id })),
    accounts: all('SELECT id, email, name FROM accounts WHERE user_id = ? ORDER BY sort_order, id', s.id),
    calendars: all("SELECT c.id, c.name, c.account_id AS accountId, c.source, (SELECT COUNT(*) FROM events e WHERE e.calendar_id = c.id AND e.deleted = 0) AS items FROM calendars c WHERE c.user_id = ? ORDER BY c.id", s.id),
    addressBooks: all("SELECT b.id, b.name, b.account_id AS accountId, b.source, (SELECT COUNT(*) FROM contacts x WHERE x.address_book_id = b.id AND x.deleted = 0) AS items FROM address_books b WHERE b.user_id = ? ORDER BY b.id", s.id),
    taskLists: all('SELECT l.id, l.name, l.account_id AS accountId, l.source, (SELECT COUNT(*) FROM tasks t WHERE t.list_id = l.id AND t.done = 0) AS items FROM task_lists l WHERE l.user_id = ? ORDER BY l.id', s.id),
    tasks: get('SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND done = 0', s.id).n,
    unread: get(`SELECT COUNT(DISTINCT m.thread_id) AS n FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.user_id = ? AND f.special_use = '\\Inbox' AND m.is_read = 0 AND m.snoozed_until IS NULL`, s.id).n,
  })));

  app.post('/api/shared', async (req, reply) => guard(reply, () => S.createShared(req.user.id, req.body?.name)));
  app.delete('/api/shared/:id', async (req, reply) => { const id = member(req, reply, true); return id && guard(reply, () => { S.deleteShared(id); return { ok: true }; }); });

  // Working in a shared space (or back in one's own mail): the choice is kept per browser.
  app.post('/api/shared/:id/enter', async (req, reply) => {
    const id = member(req, reply);
    if (!id) return undefined;
    reply.setCookie(AS_COOKIE, String(id), { path: '/', httpOnly: true, sameSite: 'lax', secure: config.secureCookies, maxAge: 30 * 86400 });
    return { ok: true };
  });
  app.post('/api/shared/leave', async (req, reply) => { reply.clearCookie(AS_COOKIE, { path: '/' }); return { ok: true }; });

  app.post('/api/shared/:id/members', async (req, reply) => { const id = member(req, reply, true); return id && guard(reply, () => ({ id: S.addMember(id, req.body?.email) })); });
  app.delete('/api/shared/:id/members/:userId', async (req, reply) => {
    const uid = Number(req.params.userId);
    const id = member(req, reply, uid !== req.user.id); // anyone may leave; removing others is for the owner
    return id && guard(reply, () => { S.removeMember(id, uid); return { ok: true }; });
  });

  // Bring one's own account / calendar / address book / tasks into the shared space (any member), or take them back out
  // into one's own (owner).
  app.post('/api/shared/:id/move-in', async (req, reply) => {
    const id = member(req, reply);
    const b = req.body || {};
    return id && guard(reply, () => {
      // Only what was chosen: the account's synced calendars / contacts go along only when asked for.
      if (b.accountId) return S.moveAccount(req.user.id, id, Number(b.accountId), { calendars: b.withCalendars === true, contacts: b.withContacts === true });
      if (b.calendarId) return S.moveCalendar(req.user.id, id, Number(b.calendarId));
      if (b.addressBookId) return S.moveAddressBook(req.user.id, id, Number(b.addressBookId));
      if (b.taskListId) return S.moveTaskList(req.user.id, id, Number(b.taskListId));
      if (Array.isArray(b.taskIds)) return { moved: S.moveTasks(req.user.id, id, b.taskIds) };
      throw new Error('Nothing to move');
    });
  });
  app.post('/api/shared/:id/move-out', async (req, reply) => {
    const id = member(req, reply, true);
    const b = req.body || {};
    return id && guard(reply, () => {
      if (b.accountId) return S.moveAccount(id, req.user.id, Number(b.accountId), { calendars: true, contacts: true });
      if (b.calendarId) return S.moveCalendar(id, req.user.id, Number(b.calendarId));
      if (b.addressBookId) return S.moveAddressBook(id, req.user.id, Number(b.addressBookId));
      if (b.taskListId) return S.moveTaskList(id, req.user.id, Number(b.taskListId));
      throw new Error('Nothing to move');
    });
  });
}
