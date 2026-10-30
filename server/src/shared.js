// Shared spaces: a business mailbox (with a calendar, contacts and tasks) used by several people, each with their own
// login. The shared data belongs to a user of kind 'shared' that nobody signs in as; members act as it (the
// halcyon_as cookie, checked in auth.js) — so it is synced and analysed once, the AI learns only from the shared
// data, and nothing of a member's private accounts is ever in it (they belong to another user).
// Moving an account / calendar / address book in or out keeps everything already computed for it (no re-analysis).
import crypto from 'node:crypto';
import { get, all, run, tx, json, now } from './db/index.js';
import { createUser } from './auth.js';
import { getSettings, saveSettings } from './settings.js';
import { notify } from './util/events.js';
import { logger } from './util/log.js';

const log = logger('shared');

export const isShared = (userId) => get("SELECT kind FROM users WHERE id = ?", userId)?.kind === 'shared';
export const membership = (sharedId, userId) => get('SELECT role FROM shared_members WHERE shared_id = ? AND user_id = ?', sharedId, userId)?.role || null;
/** Shared spaces the user belongs to. */
export const sharedOf = (userId) => all(`SELECT u.id, u.name, m.role FROM shared_members m JOIN users u ON u.id = m.shared_id
  WHERE m.user_id = ? AND u.kind = 'shared' ORDER BY u.name`, userId);
/** The shared spaces shown with the person's own mail: ui.showShared, without those set aside in ui.hiddenShared. */
export function mergedOf(userId) {
  const { showShared, hiddenShared } = getSettings(userId).ui;
  return showShared ? sharedOf(userId).filter((s) => !hiddenShared.map(Number).includes(s.id)) : [];
}
export const membersOf = (sharedId) => all(`SELECT u.id, u.name, u.email, m.role FROM shared_members m JOIN users u ON u.id = m.user_id
  WHERE m.shared_id = ? ORDER BY m.role = 'owner' DESC, u.name`, sharedId);

// Settings that describe a person (their role, how they write) are not copied into a shared space.
const PERSONAL_AI = ['aboutMe', 'learnedAboutMe', 'learnedAboutMeAt', 'writingStyle', 'learnedStyle', 'learnedStyleAt'];

/** Creates a shared space owned by `userId`, with the creator's AI providers and AI/calendar settings (not personal ones). */
export function createShared(userId, name) {
  name = String(name || '').trim().slice(0, 60);
  if (!name) throw new Error('Give the shared space a name');
  const u = createUser({ email: `shared-${crypto.randomBytes(6).toString('hex')}@shared.halcyon.local`, name });
  run("UPDATE users SET kind = 'shared' WHERE id = ?", u.id);
  run("INSERT INTO shared_members (shared_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)", u.id, userId, now());
  // The same AI: copy the providers (keys stay encrypted, never shown) and point the routes at the copies.
  const cols = all("SELECT name FROM pragma_table_info('ai_providers')").map((c) => c.name).filter((c) => !['id', 'user_id'].includes(c));
  const ids = new Map();
  for (const p of all('SELECT * FROM ai_providers WHERE user_id = ?', userId)) {
    const r = run(`INSERT INTO ai_providers (user_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`, u.id, ...cols.map((c) => p[c]));
    ids.set(p.id, Number(r.lastInsertRowid));
  }
  const s = getSettings(userId);
  const ai = { ...s.ai };
  for (const k of PERSONAL_AI) delete ai[k];
  ai.routes = Object.fromEntries(Object.entries(s.ai.routes || {}).map(([k, v]) => [k, v && ids.has(v.providerId) ? { ...v, providerId: ids.get(v.providerId) } : v]));
  saveSettings(u.id, { ai, calendar: s.calendar, mail: { ...s.mail, defaultAccountId: null } });
  return { id: u.id, name };
}

export function addMember(sharedId, email) {
  const u = get("SELECT id, kind FROM users WHERE email = ?", String(email || '').toLowerCase().trim());
  if (!u || u.kind === 'shared') throw new Error('No Halcyon user with this email on this server (an administrator can add them in Settings → Users)');
  run("INSERT OR IGNORE INTO shared_members (shared_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)", sharedId, u.id, now());
  notify(u.id, 'shared:changed', {});
  return u.id;
}

export function removeMember(sharedId, userId) {
  if (membership(sharedId, userId) === 'owner' && get("SELECT COUNT(*) AS n FROM shared_members WHERE shared_id = ? AND role = 'owner'", sharedId).n === 1) {
    throw new Error('The owner cannot leave while others remain — make someone else owner first, or move everything out and delete the space');
  }
  run('DELETE FROM shared_members WHERE shared_id = ? AND user_id = ?', sharedId, userId);
  notify(userId, 'shared:changed', {});
}

/** Deletes an empty shared space (nothing may be lost by accident). */
export function deleteShared(sharedId) {
  const used = get('SELECT (SELECT COUNT(*) FROM accounts WHERE user_id = ?) + (SELECT COUNT(*) FROM tasks WHERE user_id = ?) + (SELECT COUNT(*) FROM events e JOIN calendars c ON c.id = e.calendar_id WHERE c.user_id = ? AND e.deleted = 0) + (SELECT COUNT(*) FROM contacts WHERE user_id = ? AND deleted = 0) AS n', sharedId, sharedId, sharedId, sharedId).n;
  if (used) throw new Error('Move the account, calendar, contacts and tasks out first — the space still contains them');
  const members = membersOf(sharedId);
  run("DELETE FROM users WHERE id = ? AND kind = 'shared'", sharedId);
  for (const m of members) notify(m.id, 'shared:changed', {});
}

// ---- moving data between a person and a shared space

const idsOf = (rows) => rows.map((r) => r.id);
const inList = (ids) => (ids.length ? ids.map(Number).join(',') : '0');

/** Labels used on the moved messages: the same names in the target user's labels. */
function remapLabels(from, to, msgIds) {
  const rows = all(`SELECT id, labels_json FROM messages WHERE id IN (${inList(msgIds)}) AND labels_json IS NOT NULL AND labels_json != '[]'`);
  if (!rows.length) return;
  const map = new Map();
  const target = (labelId) => {
    if (map.has(labelId)) return map.get(labelId);
    const l = get('SELECT name, color FROM labels WHERE id = ? AND user_id = ?', labelId, from);
    const id = !l ? null : get('SELECT id FROM labels WHERE user_id = ? AND name = ?', to, l.name)?.id
      ?? Number(run('INSERT INTO labels (user_id, name, color) VALUES (?, ?, ?)', to, l.name, l.color).lastInsertRowid);
    map.set(labelId, id);
    return id;
  };
  for (const r of rows) run('UPDATE messages SET labels_json = ? WHERE id = ?', JSON.stringify(json(r.labels_json, []).map(target).filter(Boolean)), r.id);
}

/** Memory (search / assistant index) and facts that belong to a moved item (owner key 'a:<id>', 'c:<id>', 'b:<id>'). */
function moveMemory(from, to, owner) {
  run('UPDATE OR IGNORE memory SET user_id = ? WHERE user_id = ? AND owner = ?', to, from, owner);
  run('DELETE FROM memory WHERE user_id = ? AND owner = ?', from, owner);
  run('UPDATE facts SET user_id = ? WHERE user_id = ? AND owner = ?', to, from, owner);
}

function moveCalendarRows(from, to, calIds) {
  if (!calIds.length) return;
  for (const c of all(`SELECT * FROM calendars WHERE id IN (${inList(calIds)})`)) {
    if (c.source_id) run('UPDATE calendar_sources SET user_id = ? WHERE id = ? AND user_id = ?', to, c.source_id, from);
    moveMemory(from, to, `c:${c.id}`);
  }
  run(`UPDATE calendars SET user_id = ?, space = NULL, is_default = 0 WHERE id IN (${inList(calIds)}) AND user_id = ?`, to, from);
}

function moveBookRows(from, to, bookIds) {
  if (!bookIds.length) return;
  run(`UPDATE contact_emails SET user_id = ? WHERE contact_id IN (SELECT id FROM contacts WHERE address_book_id IN (${inList(bookIds)}))`, to);
  run(`UPDATE contacts SET user_id = ? WHERE address_book_id IN (${inList(bookIds)}) AND user_id = ?`, to, from);
  for (const id of bookIds) moveMemory(from, to, `b:${id}`);
  run(`UPDATE address_books SET user_id = ?, space = NULL WHERE id IN (${inList(bookIds)}) AND user_id = ?`, to, from);
}

/** Both sides keep a default calendar / address book; an empty default of the target makes way for the moved one. */
function fixDefaults(from, to) {
  for (const uid of [from, to]) {
    if (!get('SELECT id FROM calendars WHERE user_id = ? AND is_default = 1', uid)) {
      const c = get('SELECT id FROM calendars WHERE user_id = ? AND readonly = 0 ORDER BY id', uid);
      if (c) run('UPDATE calendars SET is_default = 1 WHERE id = ?', c.id);
      else run("INSERT INTO calendars (user_id, name, color, source, is_default, created_at) VALUES (?, 'Calendar', '#3b82f6', 'local', 1, ?)", uid, now());
    }
    if (!get('SELECT id FROM address_books WHERE user_id = ?', uid)) run("INSERT INTO address_books (user_id, name, source, created_at) VALUES (?, 'Contacts', 'local', ?)", uid, now());
  }
  // The shared space's own empty starter calendar / address book are dropped once real ones are there.
  for (const uid of [from, to].filter(isShared)) {
    const cals = all('SELECT c.id, c.is_default, c.source, (SELECT COUNT(*) FROM events WHERE calendar_id = c.id) AS n FROM calendars c WHERE c.user_id = ?', uid);
    const starter = cals.find((c) => c.source === 'local' && !c.n && c.is_default);
    if (starter && cals.length > 1) {
      run('DELETE FROM calendars WHERE id = ?', starter.id);
      run('UPDATE calendars SET is_default = 1 WHERE id = (SELECT id FROM calendars WHERE user_id = ? AND readonly = 0 ORDER BY id LIMIT 1)', uid);
    }
    const books = all("SELECT b.id, b.source, (SELECT COUNT(*) FROM contacts WHERE address_book_id = b.id) AS n FROM address_books b WHERE b.user_id = ?", uid);
    const emptyBook = books.find((b) => b.source === 'local' && !b.n);
    if (emptyBook && books.length > 1) run('DELETE FROM address_books WHERE id = ?', emptyBook.id);
  }
}

/**
 * Moves a mail account with everything belonging to it — folders, messages, AI analysis, conversation summaries,
 * search index, drafts, outbox, rules, the tasks created from its mail, and the calendars / address books it syncs —
 * from one user to another.
 */
export function moveAccount(from, to, accountId, { calendars = false, contacts = false } = {}) {
  const acc = get('SELECT * FROM accounts WHERE id = ? AND user_id = ?', accountId, from);
  if (!acc) throw new Error('Account not found');
  tx(() => {
    // Calendars / contacts synced through this account that are not to be shared stay with the person as their own
    // copy; they are no longer synced (their sync runs with the account's login, which now belongs to the space).
    if (!calendars) {
      run("UPDATE calendars SET account_id = NULL, source = 'local', url = NULL, readonly = 0 WHERE account_id = ? AND user_id = ?", acc.id, from);
      run('UPDATE accounts SET caldav_url = NULL WHERE id = ?', acc.id);
    }
    if (!contacts) {
      run("UPDATE address_books SET account_id = NULL, source = 'local', url = NULL, readonly = 0 WHERE account_id = ? AND user_id = ?", acc.id, from);
      run('UPDATE accounts SET carddav_url = NULL WHERE id = ?', acc.id);
    }
    const msgIds = idsOf(all('SELECT id FROM messages WHERE account_id = ?', acc.id));
    const list = inList(msgIds);
    remapLabels(from, to, msgIds);
    run('UPDATE messages SET user_id = ? WHERE account_id = ?', to, acc.id);
    // Conversation summaries go along when the whole conversation does; otherwise they are made again.
    for (const t of all(`SELECT DISTINCT thread_id FROM messages WHERE account_id = ? AND thread_id IS NOT NULL`, acc.id)) {
      const rest = get('SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND thread_id = ?', from, t.thread_id).n;
      if (rest) run('DELETE FROM thread_summaries WHERE user_id = ? AND thread_id = ?', from, t.thread_id);
      else run('UPDATE OR REPLACE thread_summaries SET user_id = ? WHERE user_id = ? AND thread_id = ?', to, from, t.thread_id);
    }
    moveMemory(from, to, `a:${acc.id}`);
    run(`UPDATE ai_feedback SET user_id = ? WHERE user_id = ? AND message_id IN (${list})`, to, from);
    run(`UPDATE ai_approvals SET user_id = ? WHERE user_id = ? AND message_id IN (${list})`, to, from);
    run(`UPDATE tasks SET user_id = ? WHERE user_id = ? AND source_message_id IN (${list})`, to, from);
    // Queued AI work for these messages: done again for the new owner (finished work is kept).
    run(`DELETE FROM ai_jobs WHERE user_id = ? AND type IN ('analyze', 'embed', 'memory', 'draft') AND ref_id IN (${msgIds.map((id) => `'${id}'`).join(',') || "''"})`, from);
    run('UPDATE drafts SET user_id = ? WHERE account_id = ? AND user_id = ?', to, acc.id, from);
    run('UPDATE outbox SET user_id = ? WHERE account_id = ? AND user_id = ?', to, acc.id, from);
    run('UPDATE rules SET user_id = ? WHERE account_id = ? AND user_id = ?', to, acc.id, from);
    moveCalendarRows(from, to, idsOf(all('SELECT id FROM calendars WHERE account_id = ? AND user_id = ?', acc.id, from)));
    moveBookRows(from, to, idsOf(all('SELECT id FROM address_books WHERE account_id = ? AND user_id = ?', acc.id, from)));
    run("UPDATE accounts SET user_id = ?, space = '' WHERE id = ?", to, acc.id);
    const s = getSettings(from);
    if (s.mail.defaultAccountId === acc.id) saveSettings(from, { mail: { defaultAccountId: null } });
    fixDefaults(from, to);
  });
  log.info(`account ${accountId} moved ${from} → ${to}`);
  return afterMove(from, to, accountId);
}

export function moveCalendar(from, to, calendarId) {
  const c = get('SELECT * FROM calendars WHERE id = ? AND user_id = ?', calendarId, from);
  if (!c) throw new Error('Calendar not found');
  if (c.account_id) throw new Error('This calendar belongs to a mail account — it moves together with that account');
  tx(() => { moveCalendarRows(from, to, [c.id]); fixDefaults(from, to); });
  return afterMove(from, to);
}

export function moveAddressBook(from, to, bookId) {
  const b = get('SELECT * FROM address_books WHERE id = ? AND user_id = ?', bookId, from);
  if (!b) throw new Error('Address book not found');
  if (b.account_id) throw new Error('This address book belongs to a mail account — it moves together with that account');
  tx(() => { moveBookRows(from, to, [b.id]); fixDefaults(from, to); });
  return afterMove(from, to);
}

export function moveTasks(from, to, taskIds) {
  return run(`UPDATE tasks SET user_id = ? WHERE user_id = ? AND id IN (${inList(taskIds)})`, to, from).changes;
}

// The account's sync now ingests for the new owner; both sides refresh; anything still to analyse is queued.
async function afterMove(from, to, accountId = null) {
  const { syncManager } = await import('./mail/sync.js');
  const { backfillAnalysis } = await import('./mail/pipeline.js');
  if (accountId && get('SELECT sync_enabled FROM accounts WHERE id = ?', accountId)?.sync_enabled) await syncManager.restart(accountId);
  for (const uid of [from, to]) notify(uid, 'spaces:changed', {});
  for (const m of [...new Set([from, to].flatMap((uid) => (isShared(uid) ? membersOf(uid).map((x) => x.id) : [uid])))]) notify(m, 'shared:changed', {});
  setImmediate(() => { try { backfillAnalysis(to); } catch (e) { log.warn(e.message); } });
  return { ok: true };
}
