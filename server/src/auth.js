import { get, run, all, now } from './db/index.js';
import { hashPassword, verifyPassword, randomToken } from './util/crypto.js';
import { config } from './config.js';
import { ensureDefaults } from './bootstrap.js';
import { noteClientTimezone } from './settings.js';

const SESSION_DAYS = 30;
const COOKIE = 'halcyon_session';

export function createUser({ email, name, password, isAdmin = false }) {
  const r = run('INSERT INTO users (email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)',
    email.toLowerCase().trim(), name || email, password ? hashPassword(password) : null, isAdmin ? 1 : 0, now());
  ensureDefaults(r.lastInsertRowid);
  return get('SELECT * FROM users WHERE id = ?', r.lastInsertRowid);
}

export function publicUser(u) {
  return u && { id: u.id, email: u.email, name: u.name, isAdmin: !!u.is_admin };
}

function createSession(reply, userId, ua, readOnly = false) {
  const token = randomToken();
  run('INSERT INTO sessions (token, user_id, created_at, expires_at, user_agent, read_only) VALUES (?, ?, ?, ?, ?, ?)',
    token, userId, now(), now() + SESSION_DAYS * 864e5, ua || '', readOnly ? 1 : 0);
  reply.setCookie(COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.secureCookies, maxAge: SESSION_DAYS * 86400 });
  return token;
}

const isLoopback = (ip) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);

const tokenOf = (req) => req.cookies?.[COOKIE] || (req.headers.authorization || '').replace(/^Bearer /, '');

/** The session of this request (null for none / expired, and for the single-user desktop without a session). */
export function sessionFromRequest(req) {
  const token = tokenOf(req);
  const s = token && get('SELECT * FROM sessions WHERE token = ?', token);
  return s && s.expires_at > now() ? s : null;
}

/**
 * Read-only session: nothing may change — no mail action, no sending, no settings, no AI work started. Only reading
 * (GET) passes, without the GETs that start something; signing out and signing in again (normally) stay possible.
 */
export function readOnlyBlocks(req) {
  const path = req.url.split('?')[0];
  if (['/api/auth/logout', '/api/auth/login', '/api/auth/read-only', '/api/shared/leave'].includes(path) || /^\/api\/shared\/\d+\/enter$/.test(path)) return false;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  return /^\/api\/oauth\//.test(path) || req.query?.wait === '1' || req.query?.refresh === '1';
}

export function userFromRequest(req) {
  // Never from the query string: URLs end up in proxy logs, browser history and Referer headers.
  const token = tokenOf(req);
  if (token) {
    const s = get('SELECT * FROM sessions WHERE token = ?', token);
    if (s && s.expires_at > now()) return get('SELECT * FROM users WHERE id = ?', s.user_id);
  }
  const desktopOk = !config.desktopToken || req.cookies?.halcyon_desktop === config.desktopToken || req.headers['x-halcyon-desktop'] === config.desktopToken;
  if (config.singleUser && isLoopback(req.ip) && desktopOk) {
    let u = get('SELECT * FROM users ORDER BY id LIMIT 1');
    if (!u) u = createUser({ email: 'me@localhost', name: 'Me', isAdmin: true });
    return u;
  }
  return null;
}

export const AS_COOKIE = 'halcyon_as';
const PERSON_ONLY = /^\/api\/(auth|admin|shared|mcp-tokens|integrations)(\/|$|\?)/;
// A shared space is set up once, by its owners, for everyone in it: its accounts (signature, auto-reply), AI providers
// and what the AI learned or was told, mail rules, categories, quick steps and read-only calendar servers. Members use
// them (sync, test a connection) but do not change them. Settings: see routes/settings.js (personal keys stay free).
const OWNER_ONLY = /^\/api\/(accounts(?!\/[^/]+\/(sync|test)\b)|ai\/(providers|rules|preferences|about-me|style|memory)|rules|custom-categories|quick-steps|calendar-sources|archives|spaces\/(assign|rename))(\/|$|\?)/;
export const ownerOnlyMessage = 'Only an owner of the shared space can change this — it is set once for everyone in the space';

/**
 * A login with no mail or calendar of its own that belongs to shared spaces works in one of them unless it chose its
 * own space (cookie "0"): the space is its home, with the space's calendars, task lists and address books as defaults.
 */
const homes = new Map(); // person id -> { id, at }
export function homeSpace(personId) {
  const c = homes.get(personId);
  if (c && now() - c.at < 30e3) return c.id;
  const id = get(`SELECT m.shared_id AS id FROM shared_members m JOIN users u ON u.id = m.shared_id AND u.kind = 'shared'
    WHERE m.user_id = ? AND NOT EXISTS (SELECT 1 FROM accounts WHERE user_id = ?) AND NOT EXISTS (SELECT 1 FROM calendar_sources WHERE user_id = ?)
    ORDER BY m.role = 'owner' DESC, u.name, u.id LIMIT 1`, personId, personId, personId)?.id || 0;
  homes.set(personId, { id, at: now() });
  return id;
}
export const forgetHome = (personId) => (personId ? homes.delete(personId) : homes.clear());

/** The shared-space user this request acts as: a user row, null (acting as oneself) or false (not a member). */
export function actingAs(req, person, path = req.url) {
  // Per request (header; on GET also ?as= — images and downloads cannot send headers), else the space entered (cookie),
  // else the home space of a login that has only shared spaces.
  const cookie = req.cookies?.[AS_COOKIE];
  const id = Number(req.headers['x-halcyon-as'] || (req.method === 'GET' && req.query?.as) || (cookie === undefined ? homeSpace(person.id) : cookie)) || 0;
  if (!id || id === person.id || PERSON_ONLY.test(path)) return null;
  const m = get(`SELECT u.*, m.role AS member_role FROM shared_members m JOIN users u ON u.id = m.shared_id WHERE m.shared_id = ? AND m.user_id = ? AND u.kind = 'shared'`, id, person.id);
  return m || false;
}

// Fastify preHandler: attaches req.user or rejects.
export async function requireUser(req, reply) {
  const u = userFromRequest(req);
  if (!u) return reply.code(401).send({ error: 'Not authenticated' });
  req.user = u;
  // Working in a shared space (shared.js): the request acts as the space's own user — only for members. Signing in,
  // passwords, user administration and managing shared spaces always act as the person.
  const as = actingAs(req, u);
  if (as) {
    req.person = u; req.user = as; req.spaceRole = as.member_role;
    if (req.method !== 'GET' && as.member_role !== 'owner' && OWNER_ONLY.test(req.url)) return reply.code(403).send({ error: ownerOnlyMessage, code: 'owner-only' });
  } else if (as === false) return reply.code(403).send({ error: 'You are not a member of this shared space', code: 'not-member' });
  const tz = req.headers['x-halcyon-tz'];
  if (tz && !req.readOnly) { try { noteClientTimezone(u.id, decodeURIComponent(String(tz))); } catch { /* ignore a bad header */ } }
}

// Simple in-memory login throttling per IP.
const attempts = new Map();
function throttled(ip) {
  const a = attempts.get(ip) || { n: 0, t: now() };
  if (now() - a.t > 15 * 60e3) { a.n = 0; a.t = now(); }
  attempts.set(ip, a);
  return a;
}

export default async function authRoutes(app) {
  app.get('/api/auth/status', async (req) => {
    const count = get('SELECT COUNT(*) AS n FROM users').n;
    const u = userFromRequest(req);
    const as = u && actingAs(req, u, '/api/me');
    return { needsSetup: count === 0 && !config.singleUser, suite: !!config.ssoSecret, user: publicUser(u), singleUser: config.singleUser, allowSignup: config.allowSignup, readOnly: !!sessionFromRequest(req)?.read_only,
      acting: as ? { id: as.id, name: as.name, role: as.member_role } : null };
  });

  app.post('/api/auth/setup', async (req, reply) => {
    if (get('SELECT COUNT(*) AS n FROM users').n > 0) return reply.code(400).send({ error: 'Already set up' });
    const { email, name, password } = req.body || {};
    if (!email || !password || password.length < 8) return reply.code(400).send({ error: 'Email and a password of at least 8 characters are required' });
    const u = createUser({ email, name, password, isAdmin: true });
    createSession(reply, u.id, req.headers['user-agent']);
    return { user: publicUser(u) };
  });

  app.post('/api/auth/signup', async (req, reply) => {
    if (!config.allowSignup) return reply.code(403).send({ error: 'Sign-up disabled' });
    const { email, name, password } = req.body || {};
    if (!email || !password || password.length < 8) return reply.code(400).send({ error: 'Email and a password of at least 8 characters are required' });
    if (get('SELECT id FROM users WHERE email = ?', email.toLowerCase())) return reply.code(400).send({ error: 'User exists' });
    const u = createUser({ email, name, password });
    createSession(reply, u.id, req.headers['user-agent']);
    return { user: publicUser(u) };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const t = throttled(req.ip);
    if (t.n >= 10) return reply.code(429).send({ error: 'Too many attempts, try again later' });
    const { email, password } = req.body || {};
    const u = get('SELECT * FROM users WHERE email = ?', String(email || '').toLowerCase().trim());
    if (!u || !u.password_hash || !verifyPassword(String(password || ''), u.password_hash)) {
      t.n++;
      return reply.code(401).send({ error: 'Invalid email or password' });
    }
    t.n = 0;
    const token = createSession(reply, u.id, req.headers['user-agent'], req.body?.readOnly === true);
    return { user: publicUser(u), token };
  });

  // Turns this session read-only. There is deliberately no way back from inside it: sign out and sign in again.
  app.post('/api/auth/read-only', async (req, reply) => {
    const s = sessionFromRequest(req);
    if (!s) return reply.code(400).send({ error: 'Only a signed-in browser session can be made read-only' });
    run('UPDATE sessions SET read_only = 1 WHERE token = ?', s.token);
    return { ok: true, readOnly: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies?.[COOKIE];
    if (token) run('DELETE FROM sessions WHERE token = ?', token);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/auth/password', { preHandler: requireUser }, async (req, reply) => {
    const { current, password } = req.body || {};
    if (req.user.password_hash && !verifyPassword(String(current || ''), req.user.password_hash)) return reply.code(400).send({ error: 'Current password is wrong' });
    if (!password || password.length < 8) return reply.code(400).send({ error: 'Password must be at least 8 characters' });
    run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), req.user.id);
    return { ok: true };
  });

  // Admin user management
  app.get('/api/admin/users', { preHandler: requireUser }, async (req, reply) => {
    if (!req.user.is_admin) return reply.code(403).send({ error: 'Admin only' });
    return all("SELECT id, email, name, is_admin, created_at FROM users WHERE COALESCE(kind, 'person') = 'person' ORDER BY id");
  });
  app.post('/api/admin/users', { preHandler: requireUser }, async (req, reply) => {
    if (!req.user.is_admin) return reply.code(403).send({ error: 'Admin only' });
    const { email, name, password, isAdmin } = req.body || {};
    if (!email || !password || password.length < 8) return reply.code(400).send({ error: 'Email and a password of at least 8 characters are required' });
    if (get('SELECT id FROM users WHERE email = ?', email.toLowerCase())) return reply.code(400).send({ error: 'User exists' });
    return publicUser(createUser({ email, name, password, isAdmin }));
  });
  const person = (id) => get("SELECT * FROM users WHERE id = ? AND COALESCE(kind, 'person') = 'person'", id);
  // Name, email, role. The server always keeps one administrator.
  app.patch('/api/admin/users/:id', { preHandler: requireUser }, async (req, reply) => {
    if (!req.user.is_admin) return reply.code(403).send({ error: 'Admin only' });
    const u = person(req.params.id);
    if (!u) return reply.code(404).send({ error: 'Not found' });
    const { name, isAdmin } = req.body || {};
    const email = req.body?.email === undefined ? u.email : String(req.body.email).toLowerCase().trim();
    if (!/^\S+@\S+$/.test(email)) return reply.code(400).send({ error: 'A valid email is required' });
    if (get('SELECT id FROM users WHERE email = ? AND id != ?', email, u.id)) return reply.code(400).send({ error: 'User exists' });
    if (u.is_admin && isAdmin === false && get("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND COALESCE(kind, 'person') = 'person'").n < 2) return reply.code(400).send({ error: 'The last administrator cannot lose that role' });
    run('UPDATE users SET email = ?, name = ?, is_admin = ? WHERE id = ?', email, name === undefined ? u.name : String(name).trim() || email, isAdmin === undefined ? u.is_admin : isAdmin ? 1 : 0, u.id);
    return publicUser(get('SELECT * FROM users WHERE id = ?', u.id));
  });
  // A new password for anyone, without the old one. Everyone signed in as that user is signed out (the admin's own
  // session stays): a reset is often about a lost device or a stolen password.
  app.post('/api/admin/users/:id/password', { preHandler: requireUser }, async (req, reply) => {
    if (!req.user.is_admin) return reply.code(403).send({ error: 'Admin only' });
    const u = person(req.params.id);
    if (!u) return reply.code(404).send({ error: 'Not found' });
    const { password } = req.body || {};
    if (!password || String(password).length < 8) return reply.code(400).send({ error: 'Password must be at least 8 characters' });
    run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(String(password)), u.id);
    run('DELETE FROM sessions WHERE user_id = ? AND token != ?', u.id, sessionFromRequest(req)?.token || '');
    return { ok: true };
  });
  app.delete('/api/admin/users/:id', { preHandler: requireUser }, async (req, reply) => {
    if (!req.user.is_admin) return reply.code(403).send({ error: 'Admin only' });
    if (Number(req.params.id) === req.user.id) return reply.code(400).send({ error: 'Cannot delete yourself' });
    run('DELETE FROM users WHERE id = ?', req.params.id);
    return { ok: true };
  });
}
