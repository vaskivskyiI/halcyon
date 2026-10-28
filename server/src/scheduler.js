// Periodic housekeeping: outbox delivery, snooze wake-ups, event reminders, daily brief precomputation, DAV sync.
import { db, all, get, run, json, now } from './db/index.js';
import { processOutbox, syncDraftsToServer } from './mail/send.js';
import { regroupConversations } from './mail/store.js';
import { wakeSnoozed } from './mail/actions.js';
import { listRange } from './calendar/repo.js';
import { syncCalDav } from './calendar/caldav.js';
import { dropStarters } from './bootstrap.js';
import { syncCardDav } from './contacts/carddav.js';
import { enqueue } from './ai/queue.js';
import { backfillAnalysis, purgeMemory } from './mail/pipeline.js';
import { listSpaces } from './spaces.js';
import { expireInsights, reanalyzeOpen } from './ai/tasks.js';
import { seedCorrespondents, scheduleProfiles } from './ai/profiles.js';
import { getSettings } from './settings.js';
import { notify } from './util/events.js';
import { logger } from './util/log.js';
import { markRepliedHistory } from './ai/open-items.js';
import { syncLinked } from './calendar/linked.js';
import { cleanUploads } from './mail/uploads.js';
import { notifyUser } from './notifications.js';

const log = logger('scheduler');
const davBusy = new Map();
/** The last calendar / contacts sync of each account: { at, calendars, books, error } (shown in the problems panel). */
export const davStatus = new Map();

/**
 * Calendars and contacts of an account from its CalDAV / CardDAV server. Returns { calendars, books, error }: how many
 * were found (none found is reported too — a wrong address often answers with an empty list, not an error).
 */
export function syncDav(account) {
  if (davBusy.has(account.id)) return davBusy.get(account.id);
  const run = (async () => {
    const out = { at: Date.now(), calendars: null, books: null, error: null };
    try {
      if (account.caldav_url) {
        try { out.calendars = (await syncCalDav(account))?.calendars ?? 0; } catch (e) { out.error = `Calendars (CalDAV): ${davReason(e)}`; }
      }
      if (account.carddav_url) {
        try { out.books = (await syncCardDav(account))?.books ?? 0; } catch (e) { out.error = [out.error, `Contacts (CardDAV): ${davReason(e)}`].filter(Boolean).join(' · '); }
      }
      if (!out.error && out.calendars === 0) out.error = 'Calendars (CalDAV): the server lists no calendars at this address — check the URL (e.g. https://cloud.example.com/remote.php/dav) and the DAV username';
      if (!out.error && out.books === 0) out.error = 'Contacts (CardDAV): the server lists no address books at this address — check the URL and the DAV username';
      if (out.error) {
        log.warn(`DAV sync ${account.email}: ${out.error}`);
        notify(account.user_id, 'dav:error', { accountId: account.id, error: out.error });
      }
      if (out.calendars || out.books) dropStarters(account.user_id);
      notify(account.user_id, 'calendar:changed', {});
      notify(account.user_id, 'contacts:changed', {});
    } finally {
      davStatus.set(account.id, out);
      davBusy.delete(account.id);
    }
    return out;
  })();
  davBusy.set(account.id, run);
  return run;
}

// What the user can act on: wrong password, wrong address, server not reachable.
function davReason(e) {
  const m = String(e?.message || e);
  if (/401|unauthori[sz]ed|invalid credentials/i.test(m)) return 'the server refused the username or password (set the DAV username / password if they differ from the mail login)';
  if (/404|not found/i.test(m)) return `nothing found at this address (${m})`;
  const cause = `${e.cause?.code || ''} ${e.cause?.message || ''}`;
  if (/self.signed|unable to verify|CERT_|leaf signature/i.test(`${m} ${cause}`)) return `the server's certificate is not trusted (${e.cause?.code || e.cause?.message || m}) — add its certificate authority in the account, or choose not to check it`;
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|certificate/i.test(m)) return `the server could not be reached (${e.cause?.code || m})`;
  return m;
}

function checkReminders() {
  const t = now();
  for (const u of all('SELECT id FROM users')) {
    if (!getSettings(u.id).notifications.reminders) continue;
    const upcoming = listRange(u.id, t - 60e3, t + 24 * 3600e3, null, { includeInfo: false });
    for (const e of upcoming) {
      if (e.status === 'cancelled') continue;
      for (const min of e.reminders || []) {
        const fireAt = e.start - min * 60e3;
        if (fireAt <= t && fireAt > t - 10 * 60e3) {
          const key = e.occurrence || e.start;
          if (get('SELECT 1 AS x FROM reminders_sent WHERE event_id = ? AND occurrence = ?', e.id, key * 1000 + min)) continue;
          run('INSERT OR IGNORE INTO reminders_sent (event_id, occurrence) VALUES (?, ?)', e.id, key * 1000 + min);
          notify(u.id, 'reminder', { eventId: e.id, title: e.title, start: e.start, location: e.location, onlineMeeting: e.onlineMeeting });
          notifyUser(u.id, 'reminder', { title: e.title, body: `${new Date(e.start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: getSettings(u.id).calendar.timezone })}${e.location ? ` · ${e.location}` : ''}`, url: '#/calendar', tag: `rem-e${e.id}-${e.start}` });
        }
      }
    }
    // Task due reminders
    for (const task of all('SELECT * FROM tasks WHERE user_id = ? AND done = 0 AND due BETWEEN ? AND ?', u.id, t - 60e3, t)) {
      notify(u.id, 'reminder', { taskId: task.id, title: task.title, start: task.due });
      notifyUser(u.id, 'reminder', { title: task.title, body: 'Task due now', url: '#/tasks', tag: `rem-t${task.id}` });
    }
  }
}

// Writing style learned from sent mail: refreshed weekly.
function scheduleStyle() {
  for (const u of all('SELECT id FROM users')) {
    const s = getSettings(u.id).ai;
    // What the AI knows about the people the user writes with, and about the user (ai/profiles.js).
    if (s.enabled) {
      try { seedCorrespondents(u.id); scheduleProfiles(u.id); } catch (e) { log.error(e); }
      if (s.learnAboutMe !== false && now() - (s.learnedAboutMeAt || 0) > 30 * 864e5
        && !get("SELECT 1 AS x FROM ai_jobs WHERE user_id = ? AND type = 'aboutme' AND (status IN ('queued', 'running') OR updated_at > ?)", u.id, now() - 864e5)) {
        enqueue(u.id, 'aboutme', 'aboutme', 3, { force: true });
      }
    }
    if (!s.enabled || !s.learnStyle || now() - (s.learnedStyleAt || 0) < 7 * 864e5) continue;
    // At most one attempt a day (e.g. while there is too little sent mail to learn from).
    if (get("SELECT 1 AS x FROM ai_jobs WHERE user_id = ? AND type = 'style' AND (status IN ('queued', 'running') OR updated_at > ?)", u.id, now() - 864e5)) continue;
    enqueue(u.id, 'style', 'style', 4, { force: true });
  }
}

function scheduleBriefs() {
  const d = new Date();
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = d.toISOString().slice(0, 10);
  for (const u of all('SELECT id FROM users')) {
    const s = getSettings(u.id);
    if (!s.ai.enabled || !s.ai.dailyBrief) continue;
    // Generate ahead of brief time (30 min earlier) so it is ready when the user opens the app.
    const [h, m] = s.ai.briefTime.split(':').map(Number);
    const target = new Date(d); target.setHours(h, m - 30, 0, 0);
    // One brief for everything and one per space (e.g. a Work-only brief).
    for (const key of [day, ...listSpaces(u.id).map((sp) => `${day}@${sp}`)]) {
      if (d >= target && !get('SELECT 1 AS x FROM briefs WHERE user_id = ? AND day = ?', u.id, key)) enqueue(u.id, 'brief', key, 60);
    }
  }
  return hhmm;
}

export function startScheduler() {
  setInterval(() => processOutbox().catch((e) => log.error(e)), 2000).unref();
  setInterval(() => syncDraftsToServer().catch((e) => log.error(e)), 30e3).unref();
  setInterval(() => { try { wakeSnoozed(); checkReminders(); scheduleBriefs(); } catch (e) { log.error(e); } }, 30e3).unref();
  const davAll = () => { for (const a of all('SELECT * FROM accounts WHERE caldav_url IS NOT NULL OR carddav_url IS NOT NULL')) syncDav(a); };
  setTimeout(davAll, 5e3).unref();
  // Catch up on mail that was never queued for AI (e.g. arrived while AI was off); cheap when nothing is missing.
  const backfillAll = () => { for (const u of all('SELECT id FROM users')) { try { backfillAnalysis(u.id); } catch (e) { log.error(e); } } };
  setTimeout(backfillAll, 15e3).unref();
  setTimeout(() => regroupConversations().catch((e) => log.error(e)), 20e3).unref();
  setTimeout(() => { try { markRepliedHistory(); } catch (e) { log.error(e); } }, 40e3).unref();
  setTimeout(() => { try { reanalyzeOpen(); } catch (e) { log.error(e); } }, 50e3).unref();
  setInterval(() => { try { db.pragma('optimize'); } catch (e) { log.error(e); } }, 6 * 3600e3).unref();
  setInterval(backfillAll, 15 * 60e3).unref();
  setInterval(() => { try { purgeMemory(); run('DELETE FROM insight_archive WHERE created_at < ?', now() - 7 * 864e5); } catch (e) { log.error(e); } }, 3600e3).unref();
  setInterval(() => { try { expireInsights(); } catch (e) { log.error(e); } }, 2 * 60e3).unref();
  setInterval(() => { try { cleanUploads(); } catch (e) { log.error(e); } }, 864e5).unref();
  // Linked event copies follow their originals (subscriptions and server calendars change them in the background).
  setInterval(() => { try { syncLinked(); } catch (e) { log.error(e); } }, 60e3).unref();
  setTimeout(() => { try { scheduleStyle(); } catch (e) { log.error(e); } }, 60e3).unref();
  setInterval(() => { try { scheduleStyle(); } catch (e) { log.error(e); } }, 6 * 3600e3).unref();
  setInterval(davAll, 10 * 60e3).unref();
  // Clean up old reminder markers.
  setInterval(() => run('DELETE FROM reminders_sent WHERE occurrence < ?', (now() - 7 * 864e5) * 1000), 3600e3).unref();
}
