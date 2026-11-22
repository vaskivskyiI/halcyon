// Search: Outlook- and Gmail-like operators, FTS5 keyword search and semantic (embedding) search, fused with RRF.
import { all, get, fold } from './db/index.js';
import { embed } from './ai/router.js';
import { searchMemory } from './ai/memory.js';
import { inIds } from './spaces.js';
import { openReplySql, openActionSql } from './ai/open-items.js';

// Operators as in Outlook and Gmail. Outlook names are mapped to the ones below (hasattachments:yes → has:attachment,
// isread:no → is:unread, folder: → in:, importance: → priority:, sent: → received:).
const KEYS = new Set(['from', 'to', 'cc', 'bcc', 'participants', 'subject', 'body', 'has', 'attachments', 'is', 'in', 'before', 'after', 'received',
  'label', 'category', 'topic', 'account', 'older_than', 'newer_than', 'priority']);
const ALIAS = { hasattachment: 'has', hasattachments: 'has', attachment: 'attachments', isread: 'is', read: 'is', isflagged: 'is', flagged: 'is', folder: 'in',
  importance: 'priority', sent: 'received', date: 'received', recipients: 'to' };
const NO = /^(no|false|0|n)$/i;

export function parseQuery(q) {
  const filters = { terms: [], notTerms: [], bodyTerms: [] };
  // key:value, key:"a phrase", key:(several words); "a phrase"; a word. NOT / -x negate, OR joins words, AND is implied.
  const re = /(-?)(\w+): ?(\([^)]*\)|"[^"]*"|\S+)|(-?)"([^"]+)"|(\S+)/g;
  const tokens = [];
  let m;
  while ((m = re.exec(q || ''))) tokens.push(m);
  let negNext = false;
  for (let n = 0; n < tokens.length; n++) {
    m = tokens[n];
    const word = m[6];
    if (word === 'NOT') { negNext = true; continue; }
    if (word === 'AND') continue;
    if (word === 'OR') { if (filters.terms.length) filters.terms.push('OR'); continue; }
    const neg = !!(negNext || m[1] === '-' || m[4] === '-' || (word?.startsWith('-') && word.length > 1));
    negNext = false;
    if (m[2]) {
      let key = m[2].toLowerCase();
      const raw = m[3], phrase = raw.startsWith('"');
      let val = raw.replace(/^"|"$/g, '').replace(/^\(|\)$/g, '').trim();
      // "received:last week": the second word belongs to it.
      if (['received', 'sent', 'date'].includes(key) && /^(this|last|past|previous)$/i.test(val) && tokens[n + 1]?.[6]) val = `${val} ${tokens[++n][6]}`;
      const alias = ALIAS[key];
      if (alias === 'has') { (filters.has ||= []).push({ val: 'attachment', neg: neg !== NO.test(val) }); continue; }
      if (alias === 'is') {
        const flag = key.includes('flag');
        const yes = NO.test(val) === neg;
        (filters.is ||= []).push({ val: flag ? (yes ? 'flagged' : 'unflagged') : (yes ? 'read' : 'unread'), neg: false });
        continue;
      }
      key = alias || key;
      if (KEYS.has(key)) { (filters[key] ||= []).push(phrase ? { val, neg, phrase } : { val, neg }); continue; }
      filters.terms.push(`${m[2]}:${val}`);
    } else {
      const t = m[5] || word.replace(/^-(?=.)/, '');
      (neg ? filters.notTerms : filters.terms).push(t);
    }
  }
  if (filters.terms.at(-1) === 'OR') filters.terms.pop();
  if (filters.terms[0] === 'OR') filters.terms.shift();
  for (const { val, neg } of filters.body || []) (neg ? filters.notTerms : filters.bodyTerms).push(val);
  return filters;
}

/** A day (local time) from 2026-01-15, 15.1.2026, 1/15/2026, "Jan 15 2026" — or null. */
function parseDay(s) {
  const t = String(s).trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(+m[1], m[2] - 1, +m[3]).getTime();
  m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return new Date(+m[3], m[2] - 1, +m[1]).getTime();
  const d = Date.parse(t);
  if (Number.isNaN(d)) return null;
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  return x.getTime();
}

/** received: / sent: as Outlook takes them → [from, to) in epoch ms (either may be null), or null if not understood. */
export function dateRange(v, at = Date.now()) {
  const D = 864e5, s = String(v).toLowerCase().replace(/\s+/g, ' ').replace(/^(past|previous) /, 'last ').trim();
  const today = new Date(at); today.setHours(0, 0, 0, 0);
  const t0 = today.getTime();
  const week = t0 - ((today.getDay() + 6) % 7) * D;
  const month = (k) => new Date(today.getFullYear(), today.getMonth() + k, 1).getTime();
  const year = (k) => new Date(today.getFullYear() + k, 0, 1).getTime();
  const named = { today: [t0, t0 + D], yesterday: [t0 - D, t0], 'this week': [week, week + 7 * D], 'last week': [week - 7 * D, week],
    'this month': [month(0), month(1)], 'last month': [month(-1), month(0)], 'this year': [year(0), year(1)], 'last year': [year(-1), year(0)] };
  if (named[s]) return named[s];
  let m = s.match(/^(>=|<=|>|<)\s*(.+)$/);
  if (m) {
    const d = parseDay(m[2]);
    if (d == null) return null;
    return { '>': [d + D, null], '>=': [d, null], '<': [null, d], '<=': [null, d + D] }[m[1]];
  }
  m = s.split('..');
  if (m.length === 2) { const a = parseDay(m[0]), b = parseDay(m[1]); return a == null && b == null ? null : [a, b == null ? null : b + D]; }
  const d = parseDay(s);
  return d == null ? null : [d, d + D];
}

const rel = (s) => { const m = String(s).match(/^(\d+)([dwmy])$/); return m ? Date.now() - Number(m[1]) * { d: 1, w: 7, m: 30, y: 365 }[m[2]] * 864e5 : null; };
const ftsEscape = (t) => `"${t.replace(/"/g, '""')}"*`;

/** sc: scope from spaces.scope() (null = all spaces). */
export function buildWhere(userId, f, sc = null) {
  const where = ['m.user_id = ?', inIds('m.account_id', sc?.accountIds)], params = [userId];
  if (sc?.folderId) where.push(`m.folder_id = ${Number(sc.folderId)}`); // search limited to one folder
  const add = (sql, ...p) => { where.push(sql); params.push(...p); };
  for (const { val, neg } of f.from || []) add(`${neg ? 'NOT ' : ''}(fold(m.from_addr) LIKE ? OR fold(m.from_name) LIKE ?)`, `%${fold(val)}%`, `%${fold(val)}%`);
  for (const { val, neg } of f.to || []) add(`${neg ? 'NOT ' : ''}(fold(m.to_json) LIKE ? OR fold(m.cc_json) LIKE ?)`, `%${fold(val)}%`, `%${fold(val)}%`);
  for (const { val, neg } of f.cc || []) add(`${neg ? 'NOT ' : ''}fold(m.cc_json) LIKE ?`, `%${fold(val)}%`);
  for (const { val, neg } of f.bcc || []) add(`${neg ? 'NOT ' : ''}fold(COALESCE(m.bcc_json, '')) LIKE ?`, `%${fold(val)}%`);
  for (const { val, neg } of f.participants || []) add(`${neg ? 'NOT ' : ''}(fold(m.from_addr) LIKE ? OR fold(m.from_name) LIKE ? OR fold(m.to_json) LIKE ? OR fold(m.cc_json) LIKE ?)`, ...Array(4).fill(`%${fold(val)}%`));
  // subject:"a phrase" as written; subject:(two words) each somewhere in the subject.
  for (const { val, neg, phrase } of f.subject || []) for (const w of phrase ? [val] : val.split(/\s+/)) add(`${neg ? 'NOT ' : ''}fold(m.subject) LIKE ?`, `%${fold(w)}%`);
  for (const { val, neg } of f.has || []) if (/attach/.test(val)) add(`m.has_attachments = ${neg ? 0 : 1}`);
  for (const { val, neg } of f.attachments || []) add(`${neg ? 'NOT ' : ''}(m.has_attachments = 1 AND fold(m.attachments_json) LIKE ?)`, `%${fold(val.replace(/[%_]/g, ''))}%`);
  for (const { val, neg } of f.received || []) {
    const r = dateRange(val);
    if (!r) { where.push('0'); continue; }
    const cond = [r[0] != null && `m.date >= ${r[0]}`, r[1] != null && `m.date < ${r[1]}`].filter(Boolean).join(' AND ');
    if (cond) where.push(neg ? `NOT (${cond})` : cond);
  }
  for (const { val, neg } of f.is || []) {
    const map = { unread: 'm.is_read = 0', read: 'm.is_read = 1', flagged: 'm.is_flagged = 1', unflagged: 'm.is_flagged = 0', starred: 'm.is_flagged = 1', answered: 'm.is_answered = 1', snoozed: 'm.snoozed_until IS NOT NULL', important: 'EXISTS (SELECT 1 FROM ai_insights i WHERE i.message_id = m.id AND i.priority >= 70)', needsreply: `EXISTS (SELECT 1 FROM ai_insights i WHERE i.message_id = m.id AND ${openReplySql(userId)})`,
      action: `EXISTS (SELECT 1 FROM ai_insights i WHERE i.message_id = m.id AND ${openActionSql(userId)})`, needsaction: `EXISTS (SELECT 1 FROM ai_insights i WHERE i.message_id = m.id AND ${openActionSql(userId)})`,
      replied: "EXISTS (SELECT 1 FROM ai_insights i WHERE i.message_id = m.id AND i.resolution = 'replied')",
      // Settled requests: done by the user, or deliberately not acted on.
      done: "EXISTS (SELECT 1 FROM ai_insights i WHERE i.message_id = m.id AND i.dismissed_at IS NOT NULL AND COALESCE(i.resolution, 'done') = 'done')",
      skipped: "EXISTS (SELECT 1 FROM ai_insights i WHERE i.message_id = m.id AND i.dismissed_at IS NOT NULL AND i.resolution = 'skipped')" };
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
  for (const { val, neg } of f.category || []) add(`${neg ? 'NOT ' : ''}EXISTS (SELECT 1 FROM ai_insights i WHERE i.message_id = m.id AND i.category = ?)`, val.toLowerCase());
  for (const { val, neg } of f.topic || []) add(`${neg ? 'NOT ' : ''}EXISTS (SELECT 1 FROM ai_insights i WHERE i.message_id = m.id AND lower(i.topic) = lower(?))`, val);
  for (const { val } of f.priority || []) {
    if (/^low$/i.test(val)) where.push('NOT EXISTS (SELECT 1 FROM ai_insights i WHERE i.message_id = m.id AND i.priority >= 40)');
    else add('EXISTS (SELECT 1 FROM ai_insights i WHERE i.message_id = m.id AND i.priority >= ?)', /^high$/i.test(val) ? 70 : /^(medium|normal)$/i.test(val) ? 40 : Number(val) || 0);
  }
  // Words that must not appear (NOT word, -word, -body:word).
  for (const t of f.notTerms || []) add('m.id NOT IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)', ftsEscape(t));
  for (const { val } of f.account || []) add('m.account_id IN (SELECT id FROM accounts WHERE email LIKE ?)', `%${val}%`);
  return { where, params };
}

export function keywordSearch(userId, q, { limit = 50, offset = 0, sc = null, relax = false } = {}) {
  const f = parseQuery(q);
  const { where, params } = buildWhere(userId, f, sc);
  if (f.terms.length || f.bodyTerms?.length) {
    const run = (terms) => {
      const words = terms.map((t) => (t === 'OR' ? 'OR' : ftsEscape(t))).join(' ');
      const match = [words, ...(f.bodyTerms || []).map((t) => `body : ${ftsEscape(t)}`)].filter(Boolean).join(' ');
      // bm25 weighs a word by how rare it is: a word in many messages (a project or company name) scores ~0 and the
      // column weights are lost, leaving only the date. The words in the subject or sender lift a message explicitly.
      const boost = words ? `- 3.0 * (m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)) - 1.5 * (m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?))` : '';
      const boostParams = words ? [`subject : (${words})`, `sender : (${words})`] : [];
      return all(`SELECT m.id FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid WHERE messages_fts MATCH ? AND ${where.join(' AND ')}
        ORDER BY bm25(messages_fts, 8.0, 4.0, 2.0, 1.0) ${boost} + (julianday('now') - julianday(m.date / 1000, 'unixepoch')) / 365.0 LIMIT ? OFFSET ?`,
      match, ...params, ...boostParams, limit, offset).map((r) => r.id);
    };
    const ids = run(f.terms);
    // Nothing has all the words (a typo, a word the mail does not use): the mail with most of them, best first —
    // bm25 ranks a message that has more of the words higher. Said so (relaxed), so the list is not taken as exact.
    if (relax && !ids.length && !offset && !f.terms.includes('OR') && f.terms.length > 1) {
      const some = run(f.terms.flatMap((t, i) => (i ? ['OR', t] : [t])));
      some.relaxed = some.length > 0;
      return some;
    }
    return ids;
  }
  return all(`SELECT m.id FROM messages m WHERE ${where.join(' AND ')} ORDER BY m.date DESC LIMIT ? OFFSET ?`, ...params, limit, offset).map((r) => r.id);
}

/** Embeds a query once; null when no embedding provider is available or it does not answer in time. */
export async function embedQuery(userId, text, { interactive = true, timeoutMs = 20e3 } = {}) {
  try {
    const { vectors, model } = await embed(userId, [text], { interactive, signal: AbortSignal.timeout(timeoutMs) });
    return { vector: vectors[0], model };
  } catch { return null; }
}

/** Messages ranked by their best-matching chunk: [{ id, score, chunkId }]. A conversation's summary matches too (it
 *  says what a long thread is about better than any one of its messages): it stands for the newest message in it. */
export async function messageHits(userId, query, k = 20, sc = null) {
  if (!query) return [];
  const hits = await searchMemory(userId, query.vector, query.model, { k: k * 4, owners: sc?.owners || null, kinds: new Set(['message', 'thread']) });
  const threads = [...new Set(hits.filter((h) => h.kind === 'thread').map((h) => String(h.ref)))];
  const newest = new Map(threads.length ? all(`SELECT thread_id AS t, id FROM (SELECT thread_id, id, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY date DESC) AS rn
    FROM messages m WHERE user_id = ? AND ${inIds('m.account_id', sc?.accountIds)} AND thread_id IN (${threads.map(() => '?').join(',')})) WHERE rn = 1`, userId, ...threads).map((r) => [r.t, r.id]) : []);
  const best = new Map();
  for (const h of hits) {
    const id = h.kind === 'thread' ? newest.get(String(h.ref)) : Number(h.ref);
    if (id && !best.has(id)) best.set(id, { id, score: h.score, chunkId: h.id });
  }
  return [...best.values()].slice(0, k);
}

/** Matches by meaning worth showing: above an absolute floor and not far below the best one (scores of different
 *  embedding models sit in different ranges, so a fixed floor alone lets a long tail of weak matches through). */
export function goodHits(hits, floor = 0.3, spread = 0.2) {
  const top = hits.reduce((m, h) => Math.max(m, h.score), 0);
  return hits.filter((h) => h.score > floor && h.score >= top - spread);
}

/** True when a query narrows by operators (from:, received:, is:unread…), not only by words. */
export function hasOperators(f) {
  return Object.entries(f).some(([k, v]) => !['terms', 'notTerms', 'bodyTerms'].includes(k) && v?.length) || f.notTerms.length > 0;
}

export async function semanticSearch(userId, text, k = 20, sc = null) {
  return messageHits(userId, await embedQuery(userId, text), k, sc);
}

/** Reciprocal-rank fusion of keyword and semantic results. relaxed (on the array): no message had all the words. */
export async function hybridSearch(userId, q, { limit = 50, semantic = true, sc = null } = {}) {
  const kw = keywordSearch(userId, q, { limit, sc, relax: true });
  const f = parseQuery(q);
  if (!semantic || !f.terms.length) return kw;
  // With operators most matches by meaning are filtered out below: ask for more of them.
  const sem = await semanticSearch(userId, [...f.terms.filter((t) => t !== 'OR'), ...f.bodyTerms].join(' '), hasOperators(f) ? limit * 4 : limit, sc);
  if (!sem.length) return kw;
  // Apply operator filters (and the space) to semantic hits too; this also drops hits of deleted mail.
  const { where, params } = buildWhere(userId, { ...f, terms: [], bodyTerms: [] }, sc);
  const ok = new Set(all(`SELECT m.id FROM messages m WHERE ${where.join(' AND ')} AND m.id IN (${sem.map(() => '?').join(',')})`, ...params, ...sem.map((s) => s.id)).map((r) => r.id));
  const score = new Map();
  // Words found only loosely (relaxed) weigh less than a match by meaning.
  kw.forEach((id, i) => score.set(id, (score.get(id) || 0) + (kw.relaxed ? 0.5 : 1) / (60 + i)));
  goodHits(sem.filter((s) => ok.has(s.id)), 0.25).forEach((s, i) => score.set(s.id, (score.get(s.id) || 0) + 1 / (60 + i)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id);
}

export function messageExists(id) { return !!get('SELECT 1 AS x FROM messages WHERE id = ?', id); }
