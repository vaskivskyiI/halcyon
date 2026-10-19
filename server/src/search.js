// Search: Gmail-like operators, FTS5 keyword search and semantic (embedding) search, fused with RRF.
import { all, get } from './db/index.js';
import { embed } from './ai/router.js';
import { search as vectorSearch } from './ai/vectors.js';

export function parseQuery(q) {
  const filters = { terms: [] };
  const re = /(-?)(\w+):("[^"]*"|\S+)|"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(q || ''))) {
    if (m[2]) {
      const key = m[2].toLowerCase(), val = m[3].replace(/^"|"$/g, '');
      if (['from', 'to', 'subject', 'has', 'is', 'in', 'before', 'after', 'label', 'category', 'account', 'older_than', 'newer_than', 'priority'].includes(key)) {
        (filters[key] ||= []).push({ val, neg: m[1] === '-' });
        continue;
      }
      filters.terms.push(`${m[2]}:${val}`);
    } else filters.terms.push(m[4] || m[5]);
  }
  return filters;
}

const rel = (s) => { const m = String(s).match(/^(\d+)([dwmy])$/); return m ? Date.now() - Number(m[1]) * { d: 1, w: 7, m: 30, y: 365 }[m[2]] * 864e5 : null; };
const ftsEscape = (t) => `"${t.replace(/"/g, '""')}"*`;

export function buildWhere(userId, f) {
  const where = ['m.user_id = ?'], params = [userId];
  const add = (sql, ...p) => { where.push(sql); params.push(...p); };
  for (const { val, neg } of f.from || []) add(`${neg ? 'NOT ' : ''}(m.from_addr LIKE ? OR m.from_name LIKE ?)`, `%${val}%`, `%${val}%`);
  for (const { val, neg } of f.to || []) add(`${neg ? 'NOT ' : ''}(m.to_json LIKE ? OR m.cc_json LIKE ?)`, `%${val}%`, `%${val}%`);
  for (const { val, neg } of f.subject || []) add(`${neg ? 'NOT ' : ''}m.subject LIKE ?`, `%${val}%`);
  for (const { val, neg } of f.has || []) if (/attach/.test(val)) add(`m.has_attachments = ${neg ? 0 : 1}`);
  for (const { val, neg } of f.is || []) {
    const map = { unread: 'm.is_read = 0', read: 'm.is_read = 1', flagged: 'm.is_flagged = 1', starred: 'm.is_flagged = 1', answered: 'm.is_answered = 1', snoozed: 'm.snoozed_until IS NOT NULL', important: 'EXISTS (SELECT 1 FROM ai_insights i WHERE i.message_id = m.id AND i.priority >= 70)', needsreply: 'EXISTS (SELECT 1 FROM ai_insights i WHERE i.message_id = m.id AND i.needs_reply = 1)' };
    if (map[val]) where.push(neg ? `NOT (${map[val]})` : map[val]);
  }
  for (const { val } of f.in || []) {
    const special = { inbox: '\\Inbox', sent: '\\Sent', drafts: '\\Drafts', trash: '\\Trash', spam: '\\Junk', junk: '\\Junk', archive: '\\Archive' }[val.toLowerCase()];
    if (special) add('m.folder_id IN (SELECT id FROM folders WHERE special_use = ?)', special);
    else add('m.folder_id IN (SELECT id FROM folders WHERE lower(name) = lower(?) OR lower(path) = lower(?))', val, val);
  }
  for (const { val } of f.before || []) add('m.date < ?', Date.parse(val) || 0);
  for (const { val } of f.after || []) add('m.date >= ?', Date.parse(val) || 0);
  for (const { val } of f.older_than || []) { const t = rel(val); if (t) add('m.date < ?', t); }
  for (const { val } of f.newer_than || []) { const t = rel(val); if (t) add('m.date >= ?', t); }
  for (const { val } of f.label || []) add("EXISTS (SELECT 1 FROM labels l, json_each(m.labels_json) j WHERE l.id = j.value AND lower(l.name) = lower(?))", val);
  for (const { val } of f.category || []) add('EXISTS (SELECT 1 FROM ai_insights i WHERE i.message_id = m.id AND i.category = ?)', val.toLowerCase());
  for (const { val } of f.priority || []) add('EXISTS (SELECT 1 FROM ai_insights i WHERE i.message_id = m.id AND i.priority >= ?)', val === 'high' ? 70 : val === 'medium' ? 40 : 0);
  for (const { val } of f.account || []) add('m.account_id IN (SELECT id FROM accounts WHERE email LIKE ?)', `%${val}%`);
  return { where, params };
}

export function keywordSearch(userId, q, { limit = 50, offset = 0 } = {}) {
  const f = parseQuery(q);
  const { where, params } = buildWhere(userId, f);
  let sql;
  if (f.terms.length) {
    const match = f.terms.map(ftsEscape).join(' ');
    sql = `SELECT m.id FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid WHERE messages_fts MATCH ? AND ${where.join(' AND ')} ORDER BY bm25(messages_fts, 8.0, 4.0, 2.0, 1.0) + (julianday('now') - julianday(m.date / 1000, 'unixepoch')) / 365.0 LIMIT ? OFFSET ?`;
    return all(sql, match, ...params, limit, offset).map((r) => r.id);
  }
  sql = `SELECT m.id FROM messages m WHERE ${where.join(' AND ')} ORDER BY m.date DESC LIMIT ? OFFSET ?`;
  return all(sql, ...params, limit, offset).map((r) => r.id);
}

export async function semanticSearch(userId, text, k = 20) {
  try {
    const { vectors, model } = await embed(userId, [text]);
    return vectorSearch(userId, vectors[0], model, k);
  } catch { return []; }
}

/** Reciprocal-rank fusion of keyword and semantic results. */
export async function hybridSearch(userId, q, { limit = 50, semantic = true } = {}) {
  const kw = keywordSearch(userId, q, { limit });
  const f = parseQuery(q);
  if (!semantic || !f.terms.length) return kw;
  const sem = await semanticSearch(userId, f.terms.join(' '), limit);
  if (!sem.length) return kw;
  // Apply operator filters to semantic hits too.
  const { where, params } = buildWhere(userId, { ...f, terms: [] });
  const ok = new Set(all(`SELECT m.id FROM messages m WHERE ${where.join(' AND ')} AND m.id IN (${sem.map(() => '?').join(',')})`, ...params, ...sem.map((s) => s.id)).map((r) => r.id));
  const score = new Map();
  kw.forEach((id, i) => score.set(id, (score.get(id) || 0) + 1 / (60 + i)));
  sem.filter((s) => ok.has(s.id) && s.score > 0.25).forEach((s, i) => score.set(s.id, (score.get(s.id) || 0) + 1 / (60 + i)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id);
}

export function messageExists(id) { return !!get('SELECT 1 AS x FROM messages WHERE id = ?', id); }
