import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifyWebsocket from '@fastify/websocket';
import { config } from './config.js';
import './db/index.js';
import authRoutes, { userFromRequest, sessionFromRequest, readOnlyBlocks } from './auth.js';
import { recordTiming } from './util/metrics.js';
import diagnosticsRoutes from './routes/diagnostics.js';
import sharedRoutes from './routes/shared.js';
import mcpRoutes from './mcp/server.js';
import { sharedOf } from './shared.js';
import mailRoutes from './routes/mail.js';
import accountRoutes from './routes/accounts.js';
import calendarRoutes, { startSubscriptionRefresh } from './routes/calendar.js';
import contactRoutes from './routes/contacts.js';
import taskRoutes from './routes/tasks.js';
import aiRoutes from './routes/ai.js';
import settingsRoutes from './routes/settings.js';
import spaceRoutes from './routes/spaces.js';
import { syncManager } from './mail/sync.js';
import { startQueue } from './ai/queue.js';
import './ai/tasks.js';
import { startScheduler } from './scheduler.js';
import { bus } from './util/events.js';
import { logger } from './util/log.js';

const log = logger('server');
// Email HTML is rendered in a srcdoc iframe, which inherits this policy: no scripts, no remote fonts/frames, and
// remote images only when the user chose to load them (the sanitizer strips them otherwise).
const CSP = ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: https: http:",
  "font-src 'self' data:", "connect-src 'self'", "frame-src 'self' blob:", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'self'"].join('; ');

export async function buildServer({ background = true } = {}) {
  const app = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024, trustProxy: config.trustProxy });
  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket);

  // Read-only sessions are enforced here, before any route runs (see auth.js readOnlyBlocks).
  app.addHook('onRequest', async (req, reply) => {
    req.t0 = performance.now();
    if (!req.url.startsWith('/api/')) return;
    if (!sessionFromRequest(req)?.read_only) return;
    req.readOnly = true;
    if (readOnlyBlocks(req)) return reply.code(403).send({ error: 'Read-only session: nothing can be changed. Sign out and sign in normally to make changes.', readOnly: true });
  });
  app.addHook('onResponse', async (req, reply) => { if (req.t0 != null) recordTiming(req, reply.statusCode, performance.now() - req.t0); });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-frame-options', 'SAMEORIGIN');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-content-type-options', 'nosniff');
    if (!reply.hasHeader('content-security-policy')) reply.header('content-security-policy', CSP);
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    log.error(req.method, req.url, err.message);
    reply.code(err.statusCode || 500).send({ error: err.message });
  });

  app.get('/api/health', async () => ({ ok: true, version: '1.0.0', accounts: syncManager.workers.size }));
  app.get('/.well-known/assetlinks.json', async (req, reply) => {
    const { package: pkg, sha256 } = config.android;
    if (!pkg || !sha256.length) return reply.code(404).send([]);
    return [{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: pkg, sha256_cert_fingerprints: sha256 } }];
  });

  // Real-time events: new mail, sync state, AI results, reminders.
  app.get('/api/ws', { websocket: true }, (socket, req) => {
    const user = userFromRequest(req);
    if (!user) { socket.close(4001, 'unauthorized'); return; }
    // Events of the person and of their shared spaces; those of a shared space carry `as` (its user id), so the app
    // can tell new mail in the business mailbox from its own.
    let spaces = new Set(), checked = 0;
    const mine = (uid) => {
      if (Date.now() - checked > 30e3) { spaces = new Set(sharedOf(user.id).map((s) => s.id)); checked = Date.now(); }
      return spaces.has(uid);
    };
    const onEvent = (e) => {
      if (socket.readyState !== 1) return;
      if (e.type === 'shared:changed' && e.userId === user.id) checked = 0;
      if (e.userId === user.id) socket.send(JSON.stringify({ type: e.type, payload: e.payload }));
      else if (mine(e.userId)) socket.send(JSON.stringify({ type: e.type, payload: e.payload, as: e.userId }));
    };
    bus.on('user-event', onEvent);
    const ping = setInterval(() => socket.readyState === 1 && socket.ping(), 30e3);
    socket.on('close', () => { bus.off('user-event', onEvent); clearInterval(ping); });
    socket.send(JSON.stringify({ type: 'hello', payload: { userId: user.id } }));
  });

  await app.register(authRoutes);
  await app.register(settingsRoutes);
  await app.register(spaceRoutes);
  await app.register(diagnosticsRoutes);
  await app.register(sharedRoutes);
  await app.register(mcpRoutes);
  await app.register(accountRoutes);
  await app.register(mailRoutes);
  await app.register(calendarRoutes);
  await app.register(contactRoutes);
  await app.register(taskRoutes);
  await app.register(aiRoutes);

  if (fs.existsSync(path.join(config.webDir, 'index.html'))) {
    // Hashed assets may be cached; index.html must be revalidated or browsers keep an old UI after an upgrade.
    await app.register(fastifyStatic, {
      root: config.webDir, wildcard: true, maxAge: '1h',
      // Pages, the manifest and the service worker are always checked for updates.
      setHeaders: (reply, filePath) => { if (/\.(html|webmanifest)$|[\\/]sw\.js$/.test(filePath)) reply.header('cache-control', 'no-cache'); },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
      return reply.sendFile('index.html', { maxAge: 0 });
    });
  } else {
    app.get('/', async () => ({ name: 'Halcyon API', note: 'Web UI not built. Run `npm run build` in the project root.' }));
  }

  if (background) {
    syncManager.startAll();
    startQueue();
    startScheduler();
    startSubscriptionRefresh();
  }
  return app;
}

if ((process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) || process.env.HALCYON_START === '1') {
  const app = await buildServer();
  await app.listen({ host: config.host, port: config.port });
  log.info(`Halcyon listening on http://${config.host}:${config.port} (data: ${config.dataDir})`);
  if (process.send) process.send({ type: 'ready', port: app.server.address().port });
  const shutdown = async () => { log.info('shutting down'); await syncManager.stopAll(); await app.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
