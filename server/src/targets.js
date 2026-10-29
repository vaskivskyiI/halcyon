// Where things made from an email go: the calendar, task list and address book of the email's space (the space of the
// account it arrived in) — the defaults chosen for that space in Settings → Spaces first, else ones of that space.
import { get } from './db/index.js';
import { spaceMap, spaceDefault, calendarForAccount, addressBookForAccount } from './spaces.js';
import { defaultTaskList, ensureTaskLists } from './calendar/todos.js';

export function targetsForMessage(userId, messageId) {
  const m = get('SELECT account_id FROM messages WHERE id = ? AND user_id = ?', Number(messageId), userId);
  if (!m) return null;
  const space = spaceMap(userId).accounts.get(m.account_id) ?? '';
  ensureTaskLists(userId);
  return {
    space,
    calendarId: spaceDefault(userId, space, 'calendarId') || calendarForAccount(userId, m.account_id)?.id || null,
    taskListId: defaultTaskList(userId, space)?.id || null,
    bookId: spaceDefault(userId, space, 'bookId') || addressBookForAccount(userId, m.account_id)?.id || null,
  };
}
