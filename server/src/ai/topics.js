// Topics (#Helios grant, #NQW 2026): the ongoing matters the user's mail is about. The model proposes one per email; it
// becomes a topic only when it names a real, specific matter, and before a new one is made the existing ones are
// searched for the same matter written differently ("NQW 2026" / "NQW 2026 conference" / "NQW conference 2026",
// "Helios grant" / "Helios grant application") — the most used spelling wins. Near-duplicates made before this are
// merged once a day.
import { all, run, now } from '../db/index.js';

// Words that say what kind of thing it is, not which one: ignored when comparing, and not a topic on their own.
const GENERIC = new Set(['project', 'projects', 'conference', 'meeting', 'meetings', 'call', 'invoice', 'invoices', 'payment', 'payments', 'order', 'orders',
  'update', 'updates', 'report', 'reports', 'request', 'requests', 'question', 'questions', 'information', 'info', 'newsletter', 'news', 'account', 'security',
  'notification', 'notifications', 'reminder', 'event', 'events', 'application', 'proposal', 'submission', 'review', 'workshop', 'seminar', 'the', 'and', 'of',
  'for', 'a', 'an', 'in', 'on', 'to', 'with', 'about', 'issue', 'case', 'admin', 'administration', 'general', 'misc', 'other', 'team', 'work', 'personal',
  'projekt', 'sestanek', 'račun', 'konferenca', 'prijava', 'poročilo', 'obvestilo', 'vprašanje']);
const NONE = /^(null|none|n\/a|na|other|general|misc|various|unknown|no topic)$/i;
// Categories whose mail is not part of an ongoing matter of the user's.
const NO_TOPIC = new Set(['newsletter', 'promotion', 'social']);

const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const core = (s) => words(s).filter((w) => !GENERIC.has(w));
const key = (s) => words(s).join('');

function distance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** The same matter: same letters, or the same distinctive words (one set inside the other, or nearly all shared). */
export function sameTopic(a, b) {
  if (key(a) === key(b)) return true;
  const x = core(a), y = core(b);
  if (!x.length || !y.length) return false;
  const near = (w, list) => list.some((v) => v === w || (w.length >= 5 && v.length >= 5 && distance(w, v) <= 1));
  const inX = y.filter((w) => near(w, x)).length, inY = x.filter((w) => near(w, y)).length;
  // Numbers (years, order numbers) must agree: "NQW 2025" is not "NQW 2026".
  const nums = (l) => l.filter((w) => /\d/.test(w)).sort().join(' ');
  if (nums(x) && nums(y) && nums(x) !== nums(y)) return false;
  return inY === x.length || inX === y.length || (inX + inY) / (x.length + y.length) >= 0.75;
}

/** Topics used in the last 90 days, most used first (the model is asked to reuse them). */
export function recentTopics(userId, limit = 40) {
  return all(`SELECT i.topic, COUNT(*) AS n FROM ai_insights i JOIN messages m ON m.id = i.message_id
    WHERE m.user_id = ? AND i.topic IS NOT NULL AND m.date > ? GROUP BY lower(i.topic) ORDER BY n DESC LIMIT ?`, userId, now() - 90 * 864e5, limit).map((r) => r.topic);
}

/**
 * The topic to store for a model's proposal: an existing one when it is the same matter (existing: most used first),
 * else the cleaned proposal — or null for no real topic (generic words only, a newsletter, phishing).
 */
export function normalizeTopic(topic, existing = [], { category = null, phishing = false } = {}) {
  const t = String(topic || '').replace(/["'`#]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!t || NONE.test(t) || phishing || NO_TOPIC.has(category)) return null;
  const hit = existing.find((e) => sameTopic(e, t));
  if (hit) return hit;
  // Nothing distinctive ("Meeting", "Invoice", "Project update"): not a topic.
  if (!core(t).length) return null;
  return t;
}

/** Near-duplicate topics of the last 180 days renamed to their most used spelling. Returns the number of emails changed. */
export function mergeTopics(userId) {
  const rows = all(`SELECT i.topic, COUNT(*) AS n FROM ai_insights i JOIN messages m ON m.id = i.message_id
    WHERE m.user_id = ? AND i.topic IS NOT NULL AND m.date > ? GROUP BY i.topic ORDER BY n DESC, length(i.topic)`, userId, now() - 180 * 864e5);
  const keep = [];
  let changed = 0;
  for (const r of rows) {
    const to = keep.find((k) => sameTopic(k, r.topic)) || (!core(r.topic).length ? null : undefined);
    if (to === undefined) { keep.push(r.topic); continue; }
    changed += run('UPDATE ai_insights SET topic = ? WHERE topic = ? AND message_id IN (SELECT id FROM messages WHERE user_id = ?)', to, r.topic, userId).changes;
  }
  return changed;
}

export function mergeAllTopics() {
  let n = 0;
  for (const u of all('SELECT id FROM users')) n += mergeTopics(u.id);
  return n;
}
