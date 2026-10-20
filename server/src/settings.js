import { get, run, json } from './db/index.js';

export const DEFAULT_SETTINGS = {
  ui: { theme: 'system', density: 'comfortable', readingPane: 'right', conversationView: true, language: 'en', weekStart: 1, timeFormat: '24h' },
  mail: {
    undoSendSeconds: 10, loadRemoteImages: false, markReadAfterMs: 1500, focusedInbox: true,
    defaultAccountId: null, replyAllDefault: false, composeFormat: 'html', autoCollectContacts: true,
  },
  calendar: { defaultDurationMin: 30, defaultReminderMin: 15, workStart: '08:00', workEnd: '17:00', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
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
