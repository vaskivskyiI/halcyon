import { get, all, run, now, json } from '../db/index.js';
import { requireUser } from '../auth.js';
import { httpError, streamNdjson } from './util.js';
import { encrypt, decrypt } from '../util/crypto.js';
import { PROVIDER_TYPES, makeProvider, isLocalEndpoint } from '../ai/providers/index.js';
import { enqueue, resumeWaiting, queueStats } from '../ai/queue.js';
import { memoryStats, invalidate, removeMemory } from '../ai/memory.js';
import { scope, reqSpace, spaceMap, ownerSpace, cleanSpace, inIds } from '../spaces.js';
import { listPreferences, forgetSender, listRules, updateRule } from '../ai/learning.js';
import * as T from '../ai/tasks.js';
import { ask } from '../ai/assistant.js';
import { getSettings } from '../settings.js';
import { stripQuoted } from '../ai/prompts.js';
import { backfillAnalysis } from '../mail/pipeline.js';
import { listApprovals, decideApproval, pendingApprovalCount } from '../rules.js';
import { contactProfile, setProfileNotes } from '../ai/profiles.js';

// Plain HTTP to a host outside this machine/LAN sends email content readable by anyone on the path.
const insecure = (p) => /^http:/i.test(p.base_url || '') && !isLocalEndpoint(p.type, p.base_url);
const provOut = (p) => ({ id: p.id, name: p.name, type: p.type, baseUrl: p.base_url, hasKey: !!p.api_key_enc, defaultModel: p.default_model, embedModel: p.embed_model, enabled: !!p.enabled, local: isLocalEndpoint(p.type, p.base_url), insecure: insecure(p) });

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
    backfillAnalysis(req.user.id);
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

  // Local AI runtimes on this machine (desktop "local AI" mode). Foundry Local runs models on the NPU of
  // Copilot+ PCs (Snapdragon / Intel / AMD); its port is dynamic, so the desktop shell passes it when known.
  app.get('/api/ai/local-detect', async () => {
    const probe = async (url) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); return r.ok ? await r.json() : null; } catch { return null; } };
    const found = [];
    const foundryUrls = [...new Set([process.env.HALCYON_FOUNDRY_URL, 'http://127.0.0.1:5273', 'http://127.0.0.1:5272'].filter(Boolean).map((u) => u.replace(/\/(v1)?\/?$/, '')))];
    for (const base of foundryUrls) {
      const d = await probe(`${base}/v1/models`);
      if (d) { found.push({ key: 'foundry', type: 'openai-compatible', label: 'Foundry Local (NPU / GPU)', baseUrl: `${base}/v1`, models: (d.data || []).map((m) => m.id) }); break; }
    }
    const ol = await probe('http://127.0.0.1:11434/api/tags');
    if (ol) found.push({ key: 'ollama', type: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434', models: (ol.models || []).map((m) => m.name) });
    const lm = await probe('http://127.0.0.1:1234/v1/models');
    if (lm) found.push({ key: 'lmstudio', type: 'openai-compatible', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', models: (lm.data || []).map((m) => m.id) });
    return found;
  });

  // ---- status & maintenance
  app.get('/api/ai/status', async (req) => {
    const usage = all(`SELECT model, task, COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output, AVG(ms) AS avgMs, SUM(1 - ok) AS errors
      FROM ai_usage WHERE user_id = ? AND created_at > ? GROUP BY model, task ORDER BY calls DESC`, req.user.id, now() - 30 * 864e5);
    // From the analyses, not messages.ai_status: that column sits after the bodies in each row, so counting it reads
    // the whole mailbox (this endpoint is polled every few seconds by Settings → AI).
    const analyzed = get('SELECT COUNT(*) AS n FROM ai_insights i JOIN messages m ON m.id = i.message_id WHERE m.user_id = ?', req.user.id).n;
    const mem = memoryStats(req.user.id);
    const msgRows = mem.rows.filter((r) => r.kind === 'message').sort((a, b) => b.items - a.items);
    return { queue: queueStats(req.user.id), index: { count: msgRows[0]?.items || 0, model: msgRows[0]?.model || null }, memory: mem, usage, analyzed, approvals: pendingApprovalCount(req.user.id) };
  });

  // ---- actions proposed by AI-driven rules (delete / spam / forward) waiting for the user's decision
  app.get('/api/ai/approvals', async (req) => listApprovals(req.user.id));
  app.post('/api/ai/approvals/:id', async (req, reply) => {
    const r = await decideApproval(req.user.id, Number(req.params.id), req.body?.approve === true);
    return r || httpError(reply, 404, 'Not found');
  });

  // Analyse older mail (builds summaries, facts and topics for the AI memory) or re-analyse it.
  // days: number or 'all'; mode: 'missing' (only mail without analysis) | 'all' (re-analyse everything in the range).
  // Older mail gets lower priority than new mail, which keeps being analysed first.
  app.post('/api/ai/reprocess', async (req) => {
    // quiet: old mail was most likely handled — analyse it for memory/search without creating "needs reply" etc.
    const { what = 'analyze', days = 14, mode = 'all', quiet = false } = req.body || {};
    const since = days === 'all' ? 0 : now() - Number(days) * 864e5;
    const sc = scope(req.user.id, reqSpace(req));
    const folders = what === 'analyze'
      ? (getSettings(req.user.id).ai.analyzeFolders === 'all' ? "COALESCE(f.special_use, '') NOT IN ('\\Trash', '\\Junk', '\\Drafts')" : "f.special_use IN ('\\Inbox', '\\Sent')")
      : "COALESCE(f.special_use, '') NOT IN ('\\Trash', '\\Junk')";
    const missing = what === 'analyze' && mode === 'missing' ? 'AND NOT EXISTS (SELECT 1 FROM ai_insights i WHERE i.message_id = m.id)' : '';
    const rows = all(`SELECT m.id, m.date FROM messages m JOIN folders f ON f.id = m.folder_id
      WHERE m.user_id = ? AND m.date >= ? AND ${inIds('m.account_id', sc?.accountIds)} AND ${folders} ${missing} ORDER BY m.date DESC`, req.user.id, since);
    if (what === 'embed') { run('DELETE FROM memory WHERE user_id = ? AND kind = ?', req.user.id, 'message'); invalidate(req.user.id); }
    for (const m of rows) {
      const ageDays = (now() - m.date) / 864e5;
      enqueue(req.user.id, what === 'embed' ? 'embed' : 'analyze', m.id, what === 'embed' ? 5 : ageDays > 30 ? 3 : Math.max(10, 80 - Math.round(ageDays)), { force: true, options: quiet ? { quiet: true } : null });
    }
    return { queued: rows.length };
  });

  // Learn the writing style from sent mail now (normally weekly).
  app.post('/api/ai/style/refresh', async (req) => { enqueue(req.user.id, 'style', 'style', 60, { force: true }); return { ok: true }; });
  app.post('/api/ai/about-me/refresh', async (req) => { enqueue(req.user.id, 'aboutme', 'aboutme', 60, { force: true }); return { ok: true }; });

  // ---- what the AI knows about a person (contact profiles): read, correct with own notes, rebuild
  app.get('/api/people/:email', async (req) => contactProfile(req.user.id, req.params.email) || { email: String(req.params.email).toLowerCase(), profile: null, notes: '', messages: 0 });
  app.put('/api/people/:email/notes', async (req) => { setProfileNotes(req.user.id, req.params.email, req.body?.notes); return contactProfile(req.user.id, req.params.email); });
  app.post('/api/people/:email/refresh', async (req) => { enqueue(req.user.id, 'profile', String(req.params.email).toLowerCase(), 70, { force: true }); return { ok: true }; });

  // Stop bulk work: drops queued (not yet started) analysis / indexing jobs; new mail is still handled.
  app.post('/api/ai/cancel', async (req) => {
    const types = req.body?.type === 'embed' ? ['embed', 'memory'] : ['analyze'];
    const ph = types.map(() => '?').join(',');
    run(`UPDATE messages SET ai_status = 'none' WHERE user_id = ? AND ai_status = 'pending' AND CAST(id AS TEXT) IN
      (SELECT ref_id FROM ai_jobs WHERE user_id = ? AND type = 'analyze' AND status = 'queued')`, req.user.id, req.user.id);
    const r = run(`DELETE FROM ai_jobs WHERE user_id = ? AND status = 'queued' AND type IN (${ph})`, req.user.id, ...types);
    return { cancelled: r.changes };
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

  // A suggested reason for a correction (prefilled in the "why?" box; the user edits it before it is saved).
  app.post('/api/messages/:id/suggest-reason', async (req, reply) => {
    const { kind, value } = req.body || {};
    try { return { reason: await T.suggestReason(req.user.id, Number(req.params.id), kind, value) }; } catch (e) { return httpError(reply, 400, e.message); }
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
    // The live lists never depend on the AI; the overview text may fail (e.g. AI server busy) without hiding them.
    const live = T.briefLive(req.user.id, reqSpace(req));
    try { return { ...(await T.dailyBrief(req.user.id, { force: req.query.refresh === '1', cacheOnly: req.query.refresh !== '1', space: reqSpace(req), interactive: true })), live }; } catch (e) { return { live, error: e.message }; }
  });

  // ---- assistant chat
  app.post('/api/ai/ask', async (req, reply) => {
    const { chatId, question } = req.body || {};
    if (!question?.trim()) return httpError(reply, 400, 'Question required');
    return streamNdjson(req, reply, (onToken, signal, onStatus) => ask(req.user.id, { chatId, question: question.trim(), space: reqSpace(req), author: req.person?.id }, onToken, { signal, onStatus }));
  });
  // In a shared space each member sees only their own assistant chats (author_id; NULL = the user's own chats).
  const MINE = '(author_id IS NULL OR author_id = ?)';
  // In a space only that space's chats are listed; "all spaces" lists every chat.
  app.get('/api/ai/chats', async (req) => {
    const space = scope(req.user.id, reqSpace(req))?.space;
    return all(`SELECT id, title, space, updated_at AS updatedAt FROM chats WHERE user_id = ? AND ${MINE} ${space ? 'AND space = ?' : ''} ORDER BY updated_at DESC LIMIT 50`, req.user.id, req.person?.id ?? -1, ...(space ? [space] : []));
  });
  app.get('/api/ai/chats/:id', async (req, reply) => {
    const c = get(`SELECT * FROM chats WHERE id = ? AND user_id = ? AND ${MINE}`, req.params.id, req.user.id, req.person?.id ?? -1);
    if (!c) return httpError(reply, 404, 'Not found');
    return { id: c.id, title: c.title, messages: all('SELECT role, content, sources_json, created_at FROM chat_messages WHERE chat_id = ? ORDER BY id', c.id).map((m) => ({ role: m.role, content: m.content, sources: json(m.sources_json, []), createdAt: m.created_at })) };
  });
  app.delete('/api/ai/chats/:id', async (req) => { run(`DELETE FROM chats WHERE id = ? AND user_id = ? AND ${MINE}`, req.params.id, req.user.id, req.person?.id ?? -1); return { ok: true }; });

  // ---- what the AI learned from the user's corrections, per sender
  app.get('/api/ai/preferences', async (req) => listPreferences(req.user.id));
  // The user's rules from their comments on corrections: edit the text, or empty it to delete the rule.
  app.get('/api/ai/rules', async (req) => listRules(req.user.id));
  app.patch('/api/ai/rules/:id', async (req) => { updateRule(req.user.id, Number(req.params.id), req.body?.reason); return { ok: true }; });
  app.delete('/api/ai/preferences', async (req) => { forgetSender(req.user.id, req.query.from); return { ok: true }; });

  // ---- memory: what the AI has indexed and the facts it remembers (visible, editable, deletable by the user)
  app.get('/api/ai/memory', async (req) => {
    const sc = scope(req.user.id, reqSpace(req)), map = spaceMap(req.user.id);
    const facts = all('SELECT f.*, m.subject FROM facts f LEFT JOIN messages m ON m.id = f.source_message_id WHERE f.user_id = ? ORDER BY f.created_at DESC LIMIT 1000', req.user.id)
      .filter((f) => !sc || sc.owners.has(f.owner))
      .map((f) => ({ id: f.id, text: f.text, origin: f.origin, space: ownerSpace(req.user.id, f.owner, map), sourceMessageId: f.source_message_id, sourceSubject: f.subject, createdAt: f.created_at }));
    return { stats: memoryStats(req.user.id), facts };
  });
  app.post('/api/ai/memory/facts', async (req, reply) => {
    const text = String(req.body?.text || '').trim();
    if (text.length < 3) return httpError(reply, 400, 'Text required');
    return { id: T.rememberFact(req.user.id, text, cleanSpace(req.body.space ?? reqSpace(req))) };
  });
  app.delete('/api/ai/memory/facts/:id', async (req) => {
    run('DELETE FROM facts WHERE id = ? AND user_id = ?', Number(req.params.id), req.user.id);
    removeMemory(req.user.id, 'fact', [Number(req.params.id)]);
    return { ok: true };
  });
  // what: 'facts' (learned + remembered facts) | 'all' (also the semantic index; rebuilt in the background if enabled)
  app.delete('/api/ai/memory', async (req) => {
    run('DELETE FROM facts WHERE user_id = ?', req.user.id);
    if (req.query.what === 'all') run('DELETE FROM memory WHERE user_id = ?', req.user.id);
    else run("DELETE FROM memory WHERE user_id = ? AND kind = 'fact'", req.user.id);
    invalidate(req.user.id);
    return { ok: true };
  });
}
