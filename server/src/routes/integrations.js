import { requireUser } from '../auth.js';
import { inkwellPublic, saveInkwell, inkwellLookup } from '../integrations.js';

export default async function integrationRoutes(app) {
  app.get('/api/integrations/inkwell', { preHandler: requireUser }, async (req) => inkwellPublic(req.user.id));
  app.put('/api/integrations/inkwell', { preHandler: requireUser }, async (req, reply) => {
    try { return saveInkwell(req.user.id, req.body || {}); } catch (e) { return reply.code(400).send({ error: e.message }); }
  });
  // "Test connection": asks Inkwell once with a ref nothing links to.
  app.post('/api/integrations/inkwell/test', { preHandler: requireUser }, async (req) => {
    try { const r = await inkwellLookup(req.user.id, 'email', ['0']); return r ? { ok: true } : { ok: false, error: 'Add the address and a token first' }; } catch (e) { return { ok: false, error: e.name === 'TimeoutError' ? 'Inkwell did not answer' : e.message }; }
  });
  // Pages linked to mail / events / tasks (?kind=event&ref=1,2,3 — several at once for lists). Inkwell not set up or
  // not reachable: no url and no links, so the views look as they do without it.
  app.get('/api/integrations/inkwell/links', { preHandler: requireUser }, async (req, reply) => {
    const refs = String(req.query.ref || '').split(',');
    try {
      const links = await inkwellLookup(req.user.id, String(req.query.kind || ''), refs);
      return links ? { url: inkwellPublic(req.user.id).url, links } : { url: null, links: [] };
    } catch (e) {
      if (e.statusCode === 400) return reply.code(400).send({ error: e.message });
      req.log.warn({ err: e.message }, 'inkwell lookup failed');
      return { url: null, links: [], error: e.name === 'TimeoutError' ? 'Inkwell did not answer' : e.message };
    }
  });
}
