import { get, all, run, now, json, update } from './db/index.js';
import { encrypt } from './util/crypto.js';

const COLORS = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#db2777', '#0891b2', '#4b5563'];

export const userAccounts = (userId) => all('SELECT * FROM accounts WHERE user_id = ? ORDER BY sort_order, id', userId);
export const userAccount = (userId, id) => get('SELECT * FROM accounts WHERE id = ? AND user_id = ?', id, userId);

export function serializeAccount(a) {
  return {
    id: a.id, kind: a.kind || 'mail', name: a.name, email: a.email, displayName: a.display_name, color: a.color,
    imap: { host: a.imap_host, port: a.imap_port, secure: !!a.imap_secure, user: a.imap_user },
    smtp: { host: a.smtp_host, port: a.smtp_port, secure: !!a.smtp_secure, user: a.smtp_user },
    authType: a.auth_type, signatureHtml: a.signature_html, syncEnabled: !!a.sync_enabled, syncState: a.sync_state,
    syncError: a.sync_error, lastSyncAt: a.last_sync_at, caldavUrl: a.caldav_url, carddavUrl: a.carddav_url, davUser: a.dav_user,
    aliases: json(a.aliases_json, []), hasPassword: !!a.imap_pass_enc, sortOrder: a.sort_order, space: a.space || '',
    syncHistory: a.sync_history || '90', inviteCalendarId: a.invite_calendar_id || null,
    aboutMe: a.about_me || '', learnedAbout: a.learned_about || '', learnedAboutAt: a.learned_about_at || null, contextMode: a.context_mode || '',
    autoReplyOn: (() => { try { const c = JSON.parse(a.auto_reply_json || '{}'); return !!c.enabled && (!c.end || c.end > Date.now()); } catch { return false; } })(),
  };
}

/** Maps API input to DB columns; secrets are encrypted. Undefined fields are left untouched. */
export function accountFields(b) {
  const f = {
    name: b.name, email: b.email?.trim(), display_name: b.displayName, color: b.color,
    imap_host: b.imap?.host, imap_port: b.imap?.port && Number(b.imap.port), imap_secure: b.imap?.secure === undefined ? undefined : (b.imap.secure ? 1 : 0), imap_user: b.imap?.user,
    smtp_host: b.smtp?.host, smtp_port: b.smtp?.port && Number(b.smtp.port), smtp_secure: b.smtp?.secure === undefined ? undefined : (b.smtp.secure ? 1 : 0), smtp_user: b.smtp?.user,
    signature_html: b.signatureHtml, sync_enabled: b.syncEnabled === undefined ? undefined : (b.syncEnabled ? 1 : 0),
    caldav_url: b.caldavUrl, carddav_url: b.carddavUrl, dav_user: b.davUser, aliases_json: b.aliases && JSON.stringify(b.aliases),
    sort_order: b.sortOrder, space: b.space === undefined ? undefined : String(b.space).trim().slice(0, 40),
    // How far back mail is downloaded: '90' | '365' | 'all' (days).
    sync_history: b.syncHistory === undefined ? undefined : (['90', '365', 'all'].includes(String(b.syncHistory)) ? String(b.syncHistory) : '90'),
    // Calendar for accepted invitations (null = automatic).
    invite_calendar_id: b.inviteCalendarId === undefined ? undefined : (Number(b.inviteCalendarId) || null),
    // Who the user is in this account (work, private, business) — used for this account's mail instead of all.
    about_me: b.aboutMe === undefined ? undefined : String(b.aboutMe).slice(0, 2000),
    context_mode: b.contextMode === undefined ? undefined : (['account', 'global'].includes(b.contextMode) ? b.contextMode : null),
  };
  if (b.imap?.password) f.imap_pass_enc = encrypt(b.imap.password);
  if (b.smtp?.password) f.smtp_pass_enc = encrypt(b.smtp.password);
  if (b.davPassword) f.dav_pass_enc = encrypt(b.davPassword);
  return f;
}

export const ACCOUNT_COLS = ['name', 'email', 'display_name', 'color', 'imap_host', 'imap_port', 'imap_secure', 'imap_user', 'imap_pass_enc', 'smtp_host', 'smtp_port',
  'smtp_secure', 'smtp_user', 'smtp_pass_enc', 'signature_html', 'sync_enabled', 'caldav_url', 'carddav_url', 'dav_user', 'dav_pass_enc', 'aliases_json', 'sort_order', 'auth_type', 'oauth_enc', 'space', 'sync_history', 'invite_calendar_id', 'about_me', 'context_mode'];

export function createAccount(userId, b, extra = {}) {
  const n = all('SELECT id FROM accounts WHERE user_id = ?', userId).length;
  const r = run('INSERT INTO accounts (user_id, email, color, sort_order, created_at) VALUES (?, ?, ?, ?, ?)', userId, b.email, COLORS[n % COLORS.length], n, now());
  update('accounts', r.lastInsertRowid, { ...accountFields(b), ...extra }, ACCOUNT_COLS);
  return get('SELECT * FROM accounts WHERE id = ?', r.lastInsertRowid);
}
