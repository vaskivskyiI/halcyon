// What the AI knows about the people the user writes with, and about the user: built in the background from the mail
// itself (and the remembered facts), used by analysis, drafting and the assistant, and editable by the user.
import { get, all, run, json, now } from '../db/index.js';
import { getSettings, saveSettings } from '../settings.js';
import { chatJSON, chat } from './router.js';
import { registerHandler, enqueue } from './queue.js';
import { userAccounts } from '../accounts.js';
import * as P from './prompts.js';

const skip = (msg) => Object.assign(new Error(msg), { code: 'SKIP' });
const NOREPLY = /(^|[-_.+])(no-?reply|donotreply|notifications?|mailer-daemon|bounces?|newsletter|news|info|marketing|support|billing|alerts?)([-_.+@]|$)/i;
const own = (userId) => new Set(userAccounts(userId).flatMap((a) => [a.email, ...json(a.aliases_json, []).map((x) => x?.address || x)]).filter(Boolean).map((x) => String(x).toLowerCase()));
const sentFolderIds = (userId) => all("SELECT f.id FROM folders f JOIN accounts a ON a.id = f.account_id WHERE a.user_id = ? AND f.special_use = '\\Sent'", userId).map((r) => r.id);

/** Mail exchanged with one person (theirs to the user and the user's to them), newest first. */
function exchanged(userId, email, limit = 30) {
  const received = all(`SELECT id, date, subject, body_text, from_addr, 0 AS mine FROM messages WHERE user_id = ? AND from_addr = ? ORDER BY date DESC LIMIT ?`, userId, email, limit);
  const sent = sentFolderIds(userId);
  const mine = sent.length ? all(`SELECT id, date, subject, body_text, from_addr, 1 AS mine FROM messages WHERE folder_id IN (${sent.join(',')}) AND (lower(to_json) LIKE ? OR lower(cc_json) LIKE ?)
    ORDER BY date DESC LIMIT ?`, `%"${email}"%`, `%"${email}"%`, limit) : [];
  return [...received, ...mine].sort((a, b) => b.date - a.date);
}

/** Background job (ref = email): the profile of one correspondent. */
export async function profileJob(userId, email) {
  email = String(email).toLowerCase();
  const msgs = exchanged(userId, email, 30);
  if (msgs.length < 2) throw skip('too little mail with this person');
  const settings = getSettings(userId);
  const tz = settings.calendar.timezone;
  const name = get('SELECT from_name FROM messages WHERE user_id = ? AND from_addr = ? AND from_name != \'\' ORDER BY date DESC LIMIT 1', userId, email)?.from_name || '';
  // The user's own mails show greeting, sign-off and register in full (start and end); theirs mostly the content.
  const body = (t, mine) => {
    const s = P.stripQuoted(t || '').trim();
    if (!mine || s.length < 700) return s.slice(0, 600);
    return `${s.slice(0, 350)}\n[…]\n${s.slice(-250)}`;
  };
  const transcript = msgs.slice(0, 24).reverse().map((m) => `[${P.localStamp(m.date, tz).slice(0, 10)}] ${m.mine ? 'USER → them' : 'them → USER'} · ${m.subject || '(no subject)'}\n${body(m.body_text, m.mine)}`).join('\n\n');
  const facts = (name
    ? all('SELECT text FROM facts WHERE user_id = ? AND (lower(text) LIKE ? OR lower(text) LIKE ?) ORDER BY created_at DESC LIMIT 10', userId, `%${email}%`, `%${name.toLowerCase()}%`)
    : all('SELECT text FROM facts WHERE user_id = ? AND lower(text) LIKE ? ORDER BY created_at DESC LIMIT 10', userId, `%${email}%`)).map((f) => f.text);
  const prev = get('SELECT profile_json, user_notes FROM contact_profiles WHERE user_id = ? AND email = ?', userId, email);
  const { data } = await chatJSON(userId, 'background', {
    ...P.contactProfilePrompt({ ctx: P.userContext(get('SELECT * FROM users WHERE id = ?', userId), settings, userAccounts(userId)), name, email, transcript, facts, notes: prev?.user_notes || '',
      language: P.LANG_NAMES[settings.ui.language] || 'English' }),
    temperature: 0.2, maxTokens: 700,
  });
  if (!data || typeof data !== 'object') throw new Error('no profile returned');
  const clean = (v, n) => String(v || '').trim().slice(0, n);
  const profile = {
    who: clean(data.who, 240), relationship: clean(data.relationship, 40), organisation: clean(data.organisation, 120),
    topics: (Array.isArray(data.topics) ? data.topics : []).map((t) => clean(t, 60)).filter(Boolean).slice(0, 6),
    language: clean(data.language, 20),
    userWriting: clean(data.user_writing, 400), theirStyle: clean(data.their_style, 200),
    notes: (Array.isArray(data.notes) ? data.notes : []).map((t) => clean(t, 200)).filter(Boolean).slice(0, 5),
  };
  const count = msgs.length;
  run(`INSERT INTO contact_profiles (user_id, email, name, profile_json, msg_count, built_count, last_message_at, built_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, email) DO UPDATE SET name = excluded.name, profile_json = excluded.profile_json, msg_count = excluded.msg_count, built_count = excluded.built_count,
    last_message_at = excluded.last_message_at, built_at = excluded.built_at`, userId, email, name, JSON.stringify(profile), count, count, msgs[0].date, now());
  return profile;
}
registerHandler('profile', profileJob);

/** New mail with someone: count it, and (re)build their profile when it is missing or out of date. */
export function noteCorrespondence(userId, addresses, date = now()) {
  const s = getSettings(userId).ai;
  if (!s.enabled || s.contactProfiles === false) return;
  const mine = own(userId);
  for (const a of new Set((addresses || []).map((x) => String(x || '').toLowerCase()).filter((x) => x.includes('@') && !mine.has(x) && !NOREPLY.test(x)))) {
    run(`INSERT INTO contact_profiles (user_id, email, msg_count, last_message_at) VALUES (?, ?, 1, ?)
      ON CONFLICT(user_id, email) DO UPDATE SET msg_count = msg_count + 1, last_message_at = MAX(COALESCE(last_message_at, 0), excluded.last_message_at)`, userId, a, date);
    const p = get('SELECT msg_count, built_count, built_at FROM contact_profiles WHERE user_id = ? AND email = ?', userId, a);
    const missing = !p.built_at && p.msg_count >= 2;
    const stale = p.built_at && (p.msg_count - (p.built_count || 0) >= 5 || (now() - p.built_at > 30 * 864e5 && p.msg_count > (p.built_count || 0)));
    // Low priority and a little later: never ahead of analysing new mail.
    if (missing || stale) enqueue(userId, 'profile', a, 3, { delayMs: 5 * 60e3 });
  }
}

/** The profile as stored (null when none), with the user's own notes. */
export function contactProfile(userId, email) {
  const r = get('SELECT * FROM contact_profiles WHERE user_id = ? AND email = ?', userId, String(email || '').toLowerCase());
  if (!r) return null;
  return { email: r.email, name: r.name, profile: json(r.profile_json, null), notes: r.user_notes || '', messages: r.msg_count, builtAt: r.built_at };
}

/** Short text for prompts: who the person is, what is discussed, how the user writes to them; the user's notes first. */
export function profileText(userId, email, { writing = false } = {}) {
  const c = contactProfile(userId, email);
  if (!c || (!c.profile && !c.notes)) return '';
  const p = c.profile || {};
  const parts = [];
  if (c.notes) parts.push(`The user's own notes about them (authoritative): ${c.notes}`);
  if (p.who) parts.push(`Who: ${p.who}`);
  if (p.topics?.length) parts.push(`Usually about: ${p.topics.join(', ')}`);
  if (p.notes?.length) parts.push(`Worth knowing: ${p.notes.join('; ')}`);
  if (writing && p.userWriting) parts.push(`How the user writes to them: ${p.userWriting}`);
  if (writing && p.language) parts.push(`Language used with them: ${p.language}`);
  return `${c.name || c.email} <${c.email}> — ${parts.join(' · ')}`;
}

/** Profiles of the people a question mentions (by name or address), for the assistant. */
export function profilesMentioned(userId, text, limit = 3) {
  const q = String(text || '').toLowerCase();
  if (q.length < 3) return [];
  const rows = all("SELECT email, name FROM contact_profiles WHERE user_id = ? AND (profile_json IS NOT NULL OR user_notes IS NOT NULL) ORDER BY msg_count DESC LIMIT 500", userId);
  const hit = rows.filter((r) => q.includes(r.email) || (r.name && r.name.split(/\s+/).filter((w) => w.length >= 3).some((w) => new RegExp(`(^|[^\\p{L}])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u').test(q))));
  return hit.slice(0, limit).map((r) => profileText(userId, r.email, { writing: true })).filter(Boolean);
}

export function setProfileNotes(userId, email, notes) {
  run(`INSERT INTO contact_profiles (user_id, email, user_notes) VALUES (?, ?, ?) ON CONFLICT(user_id, email) DO UPDATE SET user_notes = excluded.user_notes`,
    userId, String(email).toLowerCase(), String(notes || '').trim().slice(0, 2000) || null);
}

/** Weekly: profiles for the people the user writes with most that do not have one yet (or are out of date). */
export function scheduleProfiles(userId, max = 15) {
  const s = getSettings(userId).ai;
  if (!s.enabled || s.contactProfiles === false) return 0;
  const rows = all(`SELECT email FROM contact_profiles WHERE user_id = ? AND msg_count >= 3 AND (built_at IS NULL OR (msg_count - COALESCE(built_count, 0) >= 3))
    ORDER BY msg_count DESC LIMIT ?`, userId, max);
  for (const r of rows) enqueue(userId, 'profile', r.email, 2);
  return rows.length;
}

/** One-time seeding: counts per correspondent from mail already stored (so profiles can start for existing mail). */
export function seedCorrespondents(userId) {
  if (get('SELECT 1 AS x FROM contact_profiles WHERE user_id = ? LIMIT 1', userId)) return;
  const mine = own(userId);
  const counts = new Map();
  for (const r of all("SELECT from_addr AS a, COUNT(*) AS n, MAX(date) AS d FROM messages WHERE user_id = ? GROUP BY from_addr", userId)) counts.set(String(r.a || '').toLowerCase(), { n: r.n, d: r.d });
  const sent = sentFolderIds(userId);
  if (sent.length) {
    for (const r of all(`SELECT to_json, date FROM messages WHERE folder_id IN (${sent.join(',')}) ORDER BY date DESC LIMIT 3000`)) {
      for (const a of json(r.to_json, [])) { const k = String(a.address || '').toLowerCase(); const c = counts.get(k) || { n: 0, d: 0 }; counts.set(k, { n: c.n + 1, d: Math.max(c.d, r.date) }); }
    }
  }
  for (const [a, c] of counts) {
    if (!a.includes('@') || mine.has(a) || NOREPLY.test(a) || c.n < 2) continue;
    run('INSERT OR IGNORE INTO contact_profiles (user_id, email, msg_count, last_message_at) VALUES (?, ?, ?, ?)', userId, a, c.n, c.d);
  }
}

// ---- the user

/** Background job: what the user's mail shows about them (role, organisation, projects, people, languages). */
export async function aboutMeJob(userId) {
  const settings = getSettings(userId);
  const sent = sentFolderIds(userId);
  if (!sent.length) throw skip('no sent mail');
  const rows = all(`SELECT subject, body_text, to_json FROM messages WHERE folder_id IN (${sent.join(',')}) ORDER BY date DESC LIMIT 60`)
    .map((r) => ({ to: json(r.to_json, []).map((a) => a.name || a.address).slice(0, 3).join(', '), subject: r.subject, text: P.stripQuoted(r.body_text || '').slice(0, 400) }))
    .filter((r) => r.text.length > 30).slice(0, 35);
  if (rows.length < 5) throw skip('not enough sent mail yet');
  const facts = all('SELECT text FROM facts WHERE user_id = ? ORDER BY created_at DESC LIMIT 40', userId).map((f) => f.text);
  const user = get('SELECT * FROM users WHERE id = ?', userId);
  const res = await chat(userId, 'background', { ...P.aboutMePrompt({ name: user.name, samples: rows, facts, language: P.LANG_NAMES[settings.ui.language] || 'English' }), temperature: 0.2, maxTokens: 600 });
  saveSettings(userId, { ai: { learnedAboutMe: res.text.trim().slice(0, 2000), learnedAboutMeAt: now() } });
}
registerHandler('aboutme', aboutMeJob);
