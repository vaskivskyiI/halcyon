import { get, all, run, json } from './db/index.js';
import { rezone } from './util/time.js';

export const DEFAULT_SETTINGS = {
  ui: { theme: 'system', density: 'comfortable', readingPane: 'right', conversationView: true, language: 'en', weekStart: 1, timeFormat: '24h' },
  mail: {
    undoSendSeconds: 10, loadRemoteImages: false, markReadAfterMs: 1500, focusedInbox: true,
    defaultAccountId: null, replyAllDefault: false, composeFormat: 'html', autoCollectContacts: true,
  },
  calendar: { defaultDurationMin: 30, defaultReminderMin: 15, workStart: '08:00', workEnd: '17:00', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, tzAuto: true },
  // tzAuto: the web client keeps `timezone` equal to the browser's zone (a server in a container usually runs in UTC).
  notifications: { newMail: true, onlyImportant: false, reminders: true },
  ai: {
    enabled: true,
    // Each route: { providerId, model }. null providerId → first enabled provider.
    routes: { background: null, compose: null, chat: null, embeddings: null },
    autoAnalyze: true,            // analyze each new message in the background
    analyzeDays: 30,              // only messages newer than this are auto-analyzed
    analyzeFolders: 'inbox',      // 'inbox' | 'all'
    smartReplies: true,
    threadSummaries: true,
    embeddings: true,             // semantic search index
    dailyBrief: true,
    briefTime: '07:00',
    replyLanguage: 'auto',
    writingStyle: '',             // free text about the user's tone, used in compose
    learnStyle: true,             // learn how the user writes from sent mail (weekly)
    learnedStyle: '',             // generated description (see ai/tasks.js learnStyleJob)
    learnedStyleAt: 0,
    aboutMe: '',                  // context given to the assistant (role, company, ...)
    maxConcurrency: 2,
    privacyMode: false,           // when true, only local providers (ollama / custom base URLs on LAN) are used
  },
};

function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    out[k] = typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k]) ? deepMerge(base[k], over[k]) : over[k];
  }
  return out;
}

export function getSettings(userId) {
  const row = get('SELECT settings_json FROM users WHERE id = ?', userId);
  return deepMerge(DEFAULT_SETTINGS, json(row?.settings_json, {}));
}

export function saveSettings(userId, patch) {
  const merged = deepMerge(getSettings(userId), patch);
  run('UPDATE users SET settings_json = ? WHERE id = ?', JSON.stringify(merged), userId);
  return merged;
}

const validZone = (tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };

/**
 * Times the server read in the old zone keep their wall-clock reading in the new one: events and deadlines the AI
 * read from mail, and task due times the server worked out ("tomorrow at 10", a date in an email). Times the user
 * picked in the browser are absolute and stay as they are.
 */
export function timezoneChanged(userId, from, to) {
  if (!from || !to || from === to || !validZone(from) || !validZone(to)) return;
  const shift = (t) => rezone(t, from, to);
  const rows = all(`SELECT i.message_id, i.events_json, i.expires_at FROM ai_insights i JOIN messages m ON m.id = i.message_id
    WHERE m.user_id = ? AND (i.events_json NOT IN ('', '[]') OR i.expires_at IS NOT NULL)`, userId);
  for (const r of rows) {
    const events = json(r.events_json, []).map((e) => {
      const s = Date.parse(e.start), en = Date.parse(e.end);
      return Number.isNaN(s) ? e : { ...e, start: new Date(shift(s)).toISOString(), end: Number.isNaN(en) ? e.end : new Date(shift(en)).toISOString() };
    });
    run('UPDATE ai_insights SET events_json = ?, expires_at = ? WHERE message_id = ?', JSON.stringify(events), r.expires_at && shift(r.expires_at), r.message_id);
  }
  // Open tasks: due read by the server in the old zone, and older tasks from mail that were never edited.
  for (const t of all(`SELECT id, due FROM tasks WHERE user_id = ? AND done = 0 AND due IS NOT NULL
    AND (due_tz = ? OR (due_tz IS NULL AND source_message_id IS NOT NULL AND updated_at = created_at))`, userId, from)) {
    run('UPDATE tasks SET due = ?, due_tz = ? WHERE id = ?', shift(t.due), to, t.id);
  }
}

// The browser tells its zone with every request (x-halcyon-tz): with "use this device's time zone" on, the server
// follows it at once — also for a tab opened before an update, or another device.
const seenZone = new Map();
export function noteClientTimezone(userId, tz) {
  if (!tz || seenZone.get(userId) === tz || !validZone(tz)) return;
  seenZone.set(userId, tz);
  const s = getSettings(userId);
  if (s.calendar.tzAuto === false || s.calendar.timezone === tz) return;
  saveSettings(userId, { calendar: { timezone: tz } });
  timezoneChanged(userId, s.calendar.timezone, tz);
}
