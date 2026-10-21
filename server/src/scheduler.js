// Periodic housekeeping: outbox delivery, snooze wake-ups, event reminders, daily brief precomputation, DAV sync.
import { db, all, get, run, json, now } from './db/index.js';
import { processOutbox, syncDraftsToServer } from './mail/send.js';
import { regroupConversations } from './mail/store.js';
import { wakeSnoozed } from './mail/actions.js';
import { listRange } from './calendar/repo.js';
import { syncCalDav } from './calendar/caldav.js';
import { syncCardDav } from './contacts/carddav.js';
import { enqueue } from './ai/queue.js';
import { backfillAnalysis, purgeMemory } from './mail/pipeline.js';
import { listSpaces } from './spaces.js';
import { expireInsights } from './ai/tasks.js';
import { getSettings } from './settings.js';
import { notify } from './util/events.js';
import { logger } from './util/log.js';

const log = logger('scheduler');
const davBusy = new Set();

export async function syncDav(account) {
  if (davBusy.has(account.id)) return;
  davBusy.add(account.id);
  try {
    if (account.caldav_url) await syncCalDav(account);
    if (account.carddav_url) await syncCardDav(account);
    notify(account.user_id, 'calendar:changed', {});
    notify(account.user_id, 'contacts:changed', {});
  } catch (e) {
    log.warn(`DAV sync ${account.email}: ${e.message}`);
    notify(account.user_id, 'dav:error', { accountId: account.id, error: e.message });
  } finally { davBusy.delete(account.id); }
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
        }
      }
    }
    // Task due reminders
    for (const task of all('SELECT * FROM tasks WHERE user_id = ? AND done = 0 AND due BETWEEN ? AND ?', u.id, t - 60e3, t)) {
      notify(u.id, 'reminder', { taskId: task.id, title: task.title, start: task.due });
    }
  }
}

// Writing style learned from sent mail: refreshed weekly.
function scheduleStyle() {
  for (const u of all('SELECT id FROM users')) {
    const s = getSettings(u.id).ai;
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
  setInterval(() => { try { db.pragma('optimize'); } catch (e) { log.error(e); } }, 6 * 3600e3).unref();
  setInterval(backfillAll, 15 * 60e3).unref();
  setInterval(() => { try { purgeMemory(); run('DELETE FROM insight_archive WHERE created_at < ?', now() - 7 * 864e5); } catch (e) { log.error(e); } }, 3600e3).unref();
  setInterval(() => { try { expireInsights(); } catch (e) { log.error(e); } }, 2 * 60e3).unref();
  setTimeout(() => { try { scheduleStyle(); } catch (e) { log.error(e); } }, 60e3).unref();
  setInterval(() => { try { scheduleStyle(); } catch (e) { log.error(e); } }, 6 * 3600e3).unref();
  setInterval(davAll, 10 * 60e3).unref();
  // Clean up old reminder markers.
  setInterval(() => run('DELETE FROM reminders_sent WHERE occurrence < ?', (now() - 7 * 864e5) * 1000), 3600e3).unref();
}
