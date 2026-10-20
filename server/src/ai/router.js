// Resolves which provider/model handles a task for a user, and wraps calls with usage accounting.
import { get, all, run, now } from '../db/index.js';
import { decrypt } from '../util/crypto.js';
import { getSettings } from '../settings.js';
import { makeProvider, PROVIDER_TYPES, isLocalEndpoint } from './providers/index.js';

export class NoProviderError extends Error {
  constructor(task) { super(`No AI provider configured for "${task}". Add one in Settings → AI.`); this.code = 'NO_PROVIDER'; }
}

export function providerRows(userId) {
  return all('SELECT * FROM ai_providers WHERE user_id = ? AND enabled = 1 ORDER BY id', userId);
}

/** task: 'background' | 'compose' | 'chat' | 'embeddings' */
export function resolve(userId, task) {
  const s = getSettings(userId);
  if (!s.ai.enabled) throw Object.assign(new Error('AI features are disabled'), { code: 'AI_DISABLED' });
  let rows = providerRows(userId);
  if (s.ai.privacyMode) rows = rows.filter((r) => isLocalEndpoint(r.type, r.base_url));
  const route = s.ai.routes?.[task];
  let row = route?.providerId && rows.find((r) => r.id === Number(route.providerId));
  if (!row) {
    // Fallback: for embeddings prefer a provider that supports them; for others, the first one.
    row = task === 'embeddings' ? rows.find((r) => r.type !== 'anthropic' && (r.embed_model || PROVIDER_TYPES[r.type]?.defaultEmbed)) : rows[0];
  }
  if (!row) throw new NoProviderError(task);
  const model = route?.providerId && Number(route.providerId) === row.id && route.model
    ? route.model
    : task === 'embeddings' ? (row.embed_model || PROVIDER_TYPES[row.type]?.defaultEmbed) : (row.default_model || PROVIDER_TYPES[row.type]?.defaultModel);
  if (!model) throw new NoProviderError(task);
  return { row, model, provider: makeProvider({ type: row.type, baseUrl: row.base_url, apiKey: decrypt(row.api_key_enc) }) };
}

// Per-provider lanes. The user's own requests (chat, search, writing, "analyze now") go first: background work
// (analysis, indexing) waits while any of them is pending and keeps at most a few requests in flight per provider.
// A self-hosted model server works through requests one by one, so without this an interactive request would queue
// behind the whole backlog.
const lanes = new Map();
const laneOf = (id) => { let l = lanes.get(id); if (!l) lanes.set(id, (l = { interactive: 0, bg: 0, waiters: [] })); return l; };
const wake = (l) => l.waiters.splice(0).forEach((f) => f());
const bgLimit = (row) => (row.type === 'ollama' || isLocalEndpoint(row.type, row.base_url) ? 1 : 3);

async function enterLane(row, interactive) {
  const l = laneOf(row.id);
  if (interactive) { l.interactive++; return () => { l.interactive--; wake(l); }; }
  while (l.interactive > 0 || l.bg >= bgLimit(row)) await new Promise((r) => l.waiters.push(r));
  l.bg++;
  return () => { l.bg--; wake(l); };
}

export const laneStats = () => Object.fromEntries([...lanes].map(([id, l]) => [id, { interactive: l.interactive, background: l.bg, waiting: l.waiters.length }]));

function logUsage(userId, row, model, task, usage, ms, ok) {
  run('INSERT INTO ai_usage (user_id, provider_id, model, task, input_tokens, output_tokens, ms, ok, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    userId, row.id, model, task, usage?.input || 0, usage?.output || 0, ms, ok ? 1 : 0, now());
}

/** opts.interactive overrides the lane (e.g. "analyze now" uses the background model but the user is waiting). */
export async function chat(userId, task, { interactive = task !== 'background', ...opts } = {}) {
  const { row, model, provider } = resolve(userId, task);
  const leave = await enterLane(row, interactive);
  const t0 = Date.now();
  try {
    const res = await provider.chat({ model, ...opts });
    logUsage(userId, row, model, task, res.usage, Date.now() - t0, true);
    return { ...res, model: `${row.type}:${model}` };
  } catch (e) {
    logUsage(userId, row, model, task, null, Date.now() - t0, false);
    throw e;
  } finally { leave(); }
}

export async function chatJSON(userId, task, opts) {
  const res = await chat(userId, task, { ...opts, json: true });
  return { data: parseJSON(res.text), model: res.model };
}

/** interactive: a search query the user is waiting for (vs. background indexing). */
export async function embed(userId, texts, { interactive = false, signal } = {}) {
  const { row, model, provider } = resolve(userId, 'embeddings');
  const leave = await enterLane(row, interactive);
  const t0 = Date.now();
  try {
    const vectors = await provider.embed({ model, input: texts, signal });
    logUsage(userId, row, model, 'embeddings', { input: texts.join(' ').length / 4 }, Date.now() - t0, true);
    return { vectors, model: `${row.type}:${model}` };
  } finally { leave(); }
}

export function parseJSON(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch { /* fallthrough */ }
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try { return JSON.parse(t.slice(s, e + 1)); } catch { /* fallthrough */ }
  }
  throw new Error('Model did not return valid JSON');
}
