// "Sign in with Halcyon" for a companion app (Inkwell) set up by the same administrator: HALCYON_SSO_SECRET on both, its
// callback in HALCYON_SSO_REDIRECTS. An authorization-code exchange: the browser only carries a one-time code, the app
// trades it for the login server to server. The same secret lets the app read who is in which shared space, nothing else.
import crypto from 'node:crypto';
import { all, get, now } from '../db/index.js';
import { config } from '../config.js';
import { userFromRequest, sessionFromRequest } from '../auth.js';
import { membersOf } from '../shared.js';

const CODE_MS = 60e3;
const codes = new Map();

function trusted(req) {
  const a = Buffer.from(crypto.createHash('sha256').update(String(req.headers.authorization || '')).digest());
  const b = Buffer.from(crypto.createHash('sha256').update(`Bearer ${config.ssoSecret}`).digest());
  return !!config.ssoSecret && crypto.timingSafeEqual(a, b);
}

export default async function ssoRoutes(app) {
  app.get('/api/sso/authorize', async (req, reply) => {
    const { redirect_uri: back, state } = req.query;
    // Never redirect anywhere that was not configured: a code sent elsewhere would be a stolen login.
    if (!config.ssoSecret || !config.ssoRedirects.includes(back) || !state) return reply.code(400).send({ error: 'This application is not set up for Halcyon sign-in' });
    const u = userFromRequest(req);
    if (!u) return reply.redirect(`/?sso=${encodeURIComponent(req.url)}`);
    if (sessionFromRequest(req)?.read_only) return reply.code(403).send({ error: 'A read-only session cannot sign in elsewhere' });
    for (const [k, c] of codes) if (c.at + CODE_MS < now()) codes.delete(k);
    const code = crypto.randomBytes(32).toString('base64url');
    codes.set(code, { uid: u.id, back, at: now() });
    const to = new URL(back);
    to.searchParams.set('code', code);
    to.searchParams.set('state', String(state));
    return reply.redirect(to.href);
  });

  app.post('/api/sso/token', async (req, reply) => {
    if (!trusted(req)) return reply.code(401).send({ error: 'Not allowed' });
    const code = String(req.body?.code || ''), c = codes.get(code);
    codes.delete(code); // one use, also when it fails
    if (!c || c.at + CODE_MS < now() || c.back !== req.body?.redirect_uri) return reply.code(400).send({ error: 'This sign-in has expired, try again' });
    const u = get("SELECT id, email, name FROM users WHERE id = ? AND COALESCE(kind, 'person') = 'person'", c.uid);
    return u ? { sub: String(u.id), email: u.email, name: u.name } : reply.code(400).send({ error: 'No such user' });
  });

  app.post('/api/sso/spaces', async (req, reply) => {
    if (!trusted(req)) return reply.code(401).send({ error: 'Not allowed' });
    return all("SELECT id, name FROM users WHERE kind = 'shared' ORDER BY id").map((s) => ({ id: String(s.id), name: s.name, members: membersOf(s.id).map((m) => ({ sub: String(m.id), role: m.role })) }));
  });
}
