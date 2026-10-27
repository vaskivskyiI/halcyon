// The user's own categories ("Gift vouchers", "Wedding shoots", …): described in words — the AI decides which mail
// belongs (during the analysis of new mail, and once over past mail when a category is made or changed) — and/or a
// saved search. Hand-made changes win: mail added by hand stays, mail removed by hand is not added again.
import { get, all, run, now } from '../db/index.js';
import { chatJSON } from './router.js';
import { registerHandler, enqueue, notifyAI } from './queue.js';
import { keywordSearch, embedQuery, messageHits } from '../search.js';
import { userAccounts } from '../accounts.js';
import { stripQuoted, localStamp } from './prompts.js';
import { getSettings } from '../settings.js';
import { keywords } from '../util/text.js';

export const categoryById = (userId, id) => get('SELECT * FROM custom_categories WHERE id = ? AND user_id = ?', id, userId);

/** Categories with a description the AI can apply to mail of this account. */
export const describedFor = (userId, accountId) => all("SELECT * FROM custom_categories WHERE user_id = ? AND COALESCE(description, '') != '' AND (account_id IS NULL OR account_id = ?) ORDER BY sort_order, id", userId, accountId);

/** The part of the analysis prompt that asks for the user's categories (empty when there are none). */
export function promptBlock(cats) {
  if (!cats.length) return '';
  return `- "my_categories": the names of the USER'S OWN CATEGORIES below that this email clearly belongs to (any number; [] if none fits):\n${cats.map((c) => `  · "${c.name}": ${c.description}`).join('\n')}\n`;
}

/** Stores the AI's choice for one message (its earlier AI tags are replaced; hand-made ones stay). */
export function applyAiTags(userId, messageId, names, cats) {
  const want = new Set((Array.isArray(names) ? names : []).map((n) => String(n).trim().toLowerCase()));
  run("DELETE FROM message_tags WHERE message_id = ? AND source = 'ai'", messageId);
  for (const c of cats.filter((x) => want.has(x.name.toLowerCase()))) {
    run("INSERT OR IGNORE INTO message_tags (message_id, category_id, source, created_at) VALUES (?, ?, 'ai', ?)", messageId, c.id, now());
  }
}

/** Mail added (value true) or removed (false) by hand — the AI never changes this again. */
export function setTag(userId, categoryId, messageIds, value) {
  if (!categoryById(userId, categoryId)) throw new Error('Category not found');
  let n = 0;
  for (const id of messageIds) {
    if (!get('SELECT 1 AS x FROM messages WHERE id = ? AND user_id = ?', id, userId)) continue;
    run('INSERT OR REPLACE INTO message_tags (message_id, category_id, source, created_at) VALUES (?, ?, ?, ?)', id, categoryId, value ? 'user' : 'no', now());
    n++;
  }
  return n;
}

/** SQL condition for the category's view (messages alias m). */
export function viewSql(userId, c) {
  const parts = [];
  if (c.description) parts.push(`m.id IN (SELECT message_id FROM message_tags WHERE category_id = ${Number(c.id)} AND source IN ('ai', 'user'))`);
  if (c.query) {
    const sc = c.account_id ? { accountIds: [c.account_id] } : null;
    const ids = keywordSearch(userId, c.query, { limit: 500, sc });
    parts.push(ids.length ? `m.id IN (${ids.map(Number).join(',')})` : '0');
  }
  const acc = c.account_id ? ` AND m.account_id = ${Number(c.account_id)}` : '';
  return `((${parts.join(' OR ') || '0'})${acc} AND m.id NOT IN (SELECT message_id FROM message_tags WHERE category_id = ${Number(c.id)} AND source = 'no'))`;
}

export function listCategories(userId) {
  const since = now() - 365 * 864e5;
  return all('SELECT * FROM custom_categories WHERE user_id = ? ORDER BY sort_order, name', userId).map((c) => {
    const cond = viewSql(userId, c);
    const r = get(`SELECT COUNT(DISTINCT m.thread_id) AS n, COUNT(DISTINCT CASE WHEN m.is_read = 0 THEN m.thread_id END) AS unread FROM messages m WHERE m.user_id = ? AND m.date > ? AND ${cond}`, userId, since);
    return { id: c.id, name: c.name, color: c.color, description: c.description || '', query: c.query || '', accountId: c.account_id, count: r.n, unread: r.unread, scannedAt: c.scanned_at };
  });
}

export function saveCategory(userId, b, id = null) {
  const name = String(b.name || '').trim().slice(0, 60);
  if (!name) throw new Error('Give the category a name');
  const description = String(b.description || '').trim().slice(0, 600) || null;
  const query = String(b.query || '').trim().slice(0, 300) || null;
  if (!description && !query) throw new Error('Describe what belongs in it, or give a search');
  const accountId = b.accountId && userAccounts(userId).some((a) => a.id === Number(b.accountId)) ? Number(b.accountId) : null;
  const color = String(b.color || '').slice(0, 30) || null;
  let cid = id;
  if (id) {
    const old = categoryById(userId, id);
    if (!old) throw new Error('Category not found');
    run('UPDATE custom_categories SET name = ?, description = ?, query = ?, account_id = ?, color = ? WHERE id = ?', name, description, query, accountId, color, id);
    // A new description means new choices: the AI's earlier ones are made again (hand-made ones stay).
    if ((old.description || '') !== (description || '') || old.account_id !== accountId) run("DELETE FROM message_tags WHERE category_id = ? AND source = 'ai'", id);
    else return { id };
  } else {
    cid = Number(run('INSERT INTO custom_categories (user_id, name, description, query, account_id, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', userId, name, description, query, accountId, color, now()).lastInsertRowid);
  }
  if (description) enqueue(userId, 'customcat', String(cid), 55, { force: true });
  return { id: cid };
}

const words = (s) => [...keywords(s)].slice(0, 8);

/**
 * Past mail (last year): likely candidates — by words of the name and description, and by meaning when the search
 * index has embeddings — then the AI decides for each, 15 at a time.
 */
export async function scanCategory(userId, ref) {
  const c = categoryById(userId, Number(ref));
  if (!c?.description) return;
  const sc = c.account_id ? { accountIds: [c.account_id], owners: new Set([`a:${c.account_id}`]) } : null;
  const score = new Map();
  for (const w of words(`${c.name} ${c.description}`)) keywordSearch(userId, w, { limit: 60, sc }).forEach((id, i) => score.set(id, (score.get(id) || 0) + 1 / (10 + i)));
  try {
    const q = await embedQuery(userId, `${c.name}: ${c.description}`, { interactive: false, timeoutMs: 60e3 });
    messageHits(userId, q, 120, sc).forEach((h, i) => score.set(h.id, (score.get(h.id) || 0) + 2 / (10 + i)));
  } catch { /* no embeddings: words only */ }
  const done = new Set(all('SELECT message_id FROM message_tags WHERE category_id = ?', c.id).map((r) => r.message_id));
  const ids = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id).filter((id) => !done.has(id)).slice(0, 150);
  const tz = getSettings(userId).calendar.timezone;
  const rows = ids.length ? all(`SELECT m.id, m.date, m.from_name, m.from_addr, m.subject, substr(m.body_text, 1, 600) AS body, i.summary FROM messages m LEFT JOIN ai_insights i ON i.message_id = m.id
    WHERE m.user_id = ? AND m.date > ? AND m.id IN (${ids.join(',')})`, userId, now() - 365 * 864e5) : [];
  const examples = all(`SELECT m.subject, t.source FROM message_tags t JOIN messages m ON m.id = t.message_id WHERE t.category_id = ? AND t.source IN ('user', 'no') ORDER BY t.created_at DESC LIMIT 10`, c.id)
    .map((r) => `- ${r.source === 'user' ? 'belongs' : 'does NOT belong'}: "${r.subject}"`).join('\n');
  let added = 0;
  for (let i = 0; i < rows.length; i += 15) {
    const batch = rows.slice(i, i + 15);
    const list = batch.map((r) => `[${r.id}] ${localStamp(r.date, tz).slice(0, 10)} · ${r.from_name || r.from_addr} · ${r.subject}\n    ${(r.summary || stripQuoted(r.body)).replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');
    const { data } = await chatJSON(userId, 'background', {
      system: `You sort emails into the user's own category "${c.name}": ${c.description}
${examples ? `The user's own choices:\n${examples}\n` : ''}Return JSON {"ids": [the numbers of the emails below that clearly belong to this category]}. When unsure, leave it out. Output JSON only.`,
      messages: [{ role: 'user', content: list }], temperature: 0, maxTokens: 300,
    });
    const yes = new Set((Array.isArray(data.ids) ? data.ids : []).map(Number));
    for (const r of batch.filter((x) => yes.has(x.id))) { run("INSERT OR IGNORE INTO message_tags (message_id, category_id, source, created_at) VALUES (?, ?, 'ai', ?)", r.id, c.id, now()); added++; }
  }
  run('UPDATE custom_categories SET scanned_at = ? WHERE id = ?', now(), c.id);
  notifyAI(userId, 'folders:changed', { customCategory: c.id, added });
}
registerHandler('customcat', scanCategory);
