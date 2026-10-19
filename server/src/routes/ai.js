import { get, all, run, now, json } from '../db/index.js';
import { requireUser } from '../auth.js';
import { httpError, streamNdjson } from './util.js';
import { encrypt, decrypt } from '../util/crypto.js';
import { PROVIDER_TYPES, makeProvider, isLocalEndpoint } from '../ai/providers/index.js';
import { enqueue, resumeWaiting, queueStats } from '../ai/queue.js';
import { indexStats, invalidate } from '../ai/vectors.js';
import * as T from '../ai/tasks.js';
import { ask } from '../ai/assistant.js';
import { getSettings } from '../settings.js';
import { stripQuoted } from '../ai/prompts.js';

const provOut = (p) => ({ id: p.id, name: p.name, type: p.type, baseUrl: p.base_url, hasKey: !!p.api_key_enc, defaultModel: p.default_model, embedModel: p.embed_model, enabled: !!p.enabled, local: isLocalEndpoint(p.type, p.base_url) });

export default async function aiRoutes(app) {
  app.addHook('preHandler', requireUser);

  app.get('/api/ai/types', async () => Object.entries(PROVIDER_TYPES).filter(([, v]) => !v.hidden || process.env.HALCYON_DEMO === '1').map(([id, v]) => ({ id, ...v })));

  // ---- providers
  app.get('/api/ai/providers', async (req) => all('SELECT * FROM ai_providers WHERE user_id = ? ORDER BY id', req.user.id).map(provOut));

  app.post('/api/ai/providers', async (req, reply) => {
    const b = req.body || {};
    if (!PROVIDER_TYPES[b.type]) return httpError(reply, 400, 'Unknown provider type');
    const t = PROVIDER_TYPES[b.type];
    const r = run('INSERT INTO ai_providers (user_id, name, type, base_url, api_key_enc, default_model, embed_model, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)',
      req.user.id, b.name || t.label, b.type, b.baseUrl || t.defaultBaseUrl, encrypt(b.apiKey), b.defaultModel || t.defaultModel, b.embedModel ?? t.defaultEmbed, now());
    resumeWaiting(req.user.id);
    return provOut(get('SELECT * FROM ai_providers WHERE id = ?', r.lastInsertRowid));
  });

  app.patch('/api/ai/providers/:id', async (req, reply) => {
    const p = get('SELECT * FROM ai_providers WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!p) return httpError(reply, 404, 'Not found');
    const b = req.body || {};
    run('UPDATE ai_providers SET name = ?, base_url = ?, api_key_enc = ?, default_model = ?, embed_model = ?, enabled = ? WHERE id = ?',
      b.name ?? p.name, b.baseUrl ?? p.base_url, b.apiKey ? encrypt(b.apiKey) : (b.clearKey ? null : p.api_key_enc), b.defaultModel ?? p.default_model,
      b.embedModel !== undefined ? b.embedModel : p.embed_model, b.enabled === undefined ? p.enabled : (b.enabled ? 1 : 0), p.id);
    if (b.embedModel !== undefined && b.embedModel !== p.embed_model) invalidate(req.user.id);
    resumeWaiting(req.user.id);
    return provOut(get('SELECT * FROM ai_providers WHERE id = ?', p.id));
  });

  app.delete('/api/ai/providers/:id', async (req) => { run('DELETE FROM ai_providers WHERE id = ? AND user_id = ?', req.params.id, req.user.id); return { ok: true }; });

  function providerFromBody(userId, b) {
    const p = b.id ? get('SELECT * FROM ai_providers WHERE id = ? AND user_id = ?', b.id, userId) : null;
    const type = b.type || p?.type;
    return { type, provider: makeProvider({ type, baseUrl: b.baseUrl || p?.base_url || PROVIDER_TYPES[type]?.defaultBaseUrl, apiKey: b.apiKey || decrypt(p?.api_key_enc) }), model: b.defaultModel || p?.default_model || PROVIDER_TYPES[type]?.defaultModel, embedModel: b.embedModel ?? p?.embed_model };
  }

  app.post('/api/ai/providers/test', async (req, reply) => {
    const { provider, model, embedModel } = providerFromBody(req.user.id, req.body || {});
    const t0 = Date.now();
    const result = { chat: null, embeddings: null };
    try {
      const r = await provider.chat({ model, messages: [{ role: 'user', content: 'Reply with exactly: OK' }], maxTokens: 20, temperature: 0 });
      result.chat = { ok: true, reply: r.text.trim().slice(0, 50), ms: Date.now() - t0 };
    } catch (e) { result.chat = { ok: false, error: e.message }; }
    if (embedModel) {
      try { const v = await provider.embed({ model: embedModel, input: ['test'] }); result.embeddings = { ok: true, dim: v[0]?.length }; } catch (e) { result.embeddings = { ok: false, error: e.message }; }
    }
    return result;
  });

  app.post('/api/ai/providers/models', async (req, reply) => {
    try { return await providerFromBody(req.user.id, req.body || {}).provider.listModels(); } catch (e) { return httpError(reply, 400, e.message); }
  });

  app.post('/api/ai/providers/:id/pull', async (req, reply) => {
    const p = get('SELECT * FROM ai_providers WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (p?.type !== 'ollama') return httpError(reply, 400, 'Only for Ollama');
    try { return await makeProvider({ type: 'ollama', baseUrl: p.base_url, apiKey: decrypt(p.api_key_enc) }).pull(req.body.model); } catch (e) { return httpError(reply, 400, e.message); }
  });

  // ---- status & maintenance
  app.get('/api/ai/status', async (req) => {
    const usage = all(`SELECT model, task, COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output, AVG(ms) AS avgMs, SUM(1 - ok) AS errors
      FROM ai_usage WHERE user_id = ? AND created_at > ? GROUP BY model, task ORDER BY calls DESC`, req.user.id, now() - 30 * 864e5);
    const analyzed = get("SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND ai_status = 'done'", req.user.id).n;
    return { queue: queueStats(req.user.id), index: indexStats(req.user.id), usage, analyzed };
  });

  app.post('/api/ai/reprocess', async (req) => {
    const { what = 'analyze', days = 14 } = req.body || {};
    const since = now() - Number(days) * 864e5;
    const rows = all("SELECT m.id, m.date FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.user_id = ? AND m.date >= ? AND COALESCE(f.special_use, '') NOT IN ('\\Trash', '\\Junk')" + (what === 'analyze' ? " AND f.special_use = '\\Inbox'" : ''), req.user.id, since);
    if (what === 'embed') invalidate(req.user.id);
    for (const m of rows) enqueue(req.user.id, what === 'embed' ? 'embed' : 'analyze', m.id, what === 'embed' ? 5 : Math.max(10, 80 - Math.round((now() - m.date) / 864e5)), { force: true });
    return { queued: rows.length };
  });

  // ---- per-message / thread AI
  app.get('/api/messages/:id/insight', async (req, reply) => {
    const m = get('SELECT id FROM messages WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!m) return httpError(reply, 404, 'Not found');
    try { return await T.insightFor(req.user.id, m.id, { wait: req.query.wait === '1' }); } catch (e) { return httpError(reply, 400, e.message); }
  });

  app.post('/api/ai/thread-summary', async (req, reply) => {
    try { return { summary: await T.threadSummary(req.user.id, req.body.threadId) }; } catch (e) { return httpError(reply, 400, e.message); }
  });

  app.post('/api/ai/draft-reply', async (req, reply) => {
    const { messageId, intent, stream } = req.body || {};
    if (!stream) { try { return { text: await T.draftReply(req.user.id, Number(messageId), intent || null, null) }; } catch (e) { return httpError(reply, 400, e.message); } }
    return streamNdjson(req, reply, (onToken) => T.draftReply(req.user.id, Number(messageId), intent || null, onToken));
  });

  app.post('/api/ai/compose', async (req, reply) => streamNdjson(req, reply, (onToken) => T.composeNew(req.user.id, req.body || {}, onToken)));

  app.post('/api/ai/rewrite', async (req, reply) => streamNdjson(req, reply, (onToken) => T.rewrite(req.user.id, req.body || {}, onToken)));

  app.post('/api/ai/translate', async (req, reply) => {
    const m = get('SELECT body_text FROM messages WHERE id = ? AND user_id = ?', req.body?.messageId, req.user.id);
    if (!m) return httpError(reply, 404, 'Not found');
    const language = req.body.language || { en: 'English', sl: 'Slovenian', de: 'German' }[getSettings(req.user.id).ui.language] || 'English';
    return streamNdjson(req, reply, (onToken) => T.rewrite(req.user.id, { text: stripQuoted(m.body_text).slice(0, 8000), mode: 'translate', language }, onToken));
  });

  app.post('/api/ai/extract-event', async (req, reply) => {
    try { return await T.extractEvent(req.user.id, Number(req.body.messageId)); } catch (e) { return httpError(reply, 400, e.message); }
  });

  app.get('/api/ai/brief', async (req, reply) => {
    try { return await T.dailyBrief(req.user.id, { force: req.query.refresh === '1' }); } catch (e) { return httpError(reply, 400, e.message); }
  });

  // ---- assistant chat
  app.post('/api/ai/ask', async (req, reply) => {
    const { chatId, question } = req.body || {};
    if (!question?.trim()) return httpError(reply, 400, 'Question required');
    return streamNdjson(req, reply, (onToken) => ask(req.user.id, { chatId, question: question.trim() }, onToken));
  });
  app.get('/api/ai/chats', async (req) => all('SELECT id, title, updated_at AS updatedAt FROM chats WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50', req.user.id));
  app.get('/api/ai/chats/:id', async (req, reply) => {
    const c = get('SELECT * FROM chats WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
    if (!c) return httpError(reply, 404, 'Not found');
    return { id: c.id, title: c.title, messages: all('SELECT role, content, sources_json, created_at FROM chat_messages WHERE chat_id = ? ORDER BY id', c.id).map((m) => ({ role: m.role, content: m.content, sources: json(m.sources_json, []), createdAt: m.created_at })) };
  });
  app.delete('/api/ai/chats/:id', async (req) => { run('DELETE FROM chats WHERE id = ? AND user_id = ?', req.params.id, req.user.id); return { ok: true }; });
}
