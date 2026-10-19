// Mail rules (filters). Rules with AI conditions run after background analysis; others on arrival.
import { all, get, json } from './db/index.js';
import { setFlags, moveMessages, archiveMessages, trashMessages, spamMessages, setLabels } from './mail/actions.js';
import { queueSend } from './mail/send.js';
import { logger } from './util/log.js';

const log = logger('rules');
const AI_FIELDS = new Set(['category', 'priority', 'needsReply']);

const fieldValue = (m, ins, field) => {
  switch (field) {
    case 'from': return `${m.from_name} ${m.from_addr}`;
    case 'to': return [...json(m.to_json, []), ...json(m.cc_json, [])].map((a) => `${a.name} ${a.address}`).join(' ');
    case 'subject': return m.subject || '';
    case 'body': return m.body_text || '';
    case 'any': return `${m.from_name} ${m.from_addr} ${m.subject} ${m.body_text}`;
    case 'hasAttachment': return !!m.has_attachments;
    case 'account': return m.account_id;
    case 'category': return ins?.category || '';
    case 'priority': return ins?.priority ?? 0;
    case 'needsReply': return !!ins?.needs_reply;
    default: return '';
  }
};

export function testCondition(m, ins, c) {
  const v = fieldValue(m, ins, c.field);
  const val = c.value;
  const s = String(v).toLowerCase(), t = String(val ?? '').toLowerCase();
  switch (c.op) {
    case 'contains': return s.includes(t);
    case 'not_contains': return !s.includes(t);
    case 'equals': return s === t;
    case 'starts': return s.startsWith(t);
    case 'ends': return s.endsWith(t);
    case 'regex': try { return new RegExp(val, 'i').test(String(v)); } catch { return false; }
    case 'gte': return Number(v) >= Number(val);
    case 'lte': return Number(v) <= Number(val);
    case 'is': return Boolean(v) === (val === true || val === 'true');
    default: return false;
  }
}

export function ruleMatches(rule, m, ins) {
  const conds = json(rule.conditions_json, []);
  if (!conds.length) return false;
  if (rule.account_id && rule.account_id !== m.account_id) return false;
  return rule.match_all ? conds.every((c) => testCondition(m, ins, c)) : conds.some((c) => testCondition(m, ins, c));
}

export async function applyRules(userId, ids, phase) {
  const rules = all('SELECT * FROM rules WHERE user_id = ? AND enabled = 1 ORDER BY sort_order, id', userId)
    .filter((r) => json(r.conditions_json, []).some((c) => AI_FIELDS.has(c.field)) === (phase === 'ai'));
  if (!rules.length) return;
  for (const id of ids) {
    const m = get('SELECT * FROM messages WHERE id = ?', id);
    if (!m) continue;
    const ins = get('SELECT * FROM ai_insights WHERE message_id = ?', id);
    for (const rule of rules) {
      if (!ruleMatches(rule, m, ins)) continue;
      try { await runActions(userId, m, json(rule.actions_json, [])); } catch (e) { log.warn(`rule ${rule.id}: ${e.message}`); }
      if (rule.stop) break;
    }
  }
}

/** Runs one rule over the given message rows (used by "Run now"). Returns matched count. */
export async function runRule(userId, rule, messages) {
  let n = 0;
  for (const m of messages) {
    if (!ruleMatches(rule, m, get('SELECT * FROM ai_insights WHERE message_id = ?', m.id))) continue;
    n++;
    try { await runActions(userId, m, json(rule.actions_json, [])); } catch (e) { log.warn(`rule ${rule.id}: ${e.message}`); }
  }
  return n;
}

async function runActions(userId, m, actions) {
  for (const a of actions) {
    switch (a.type) {
      case 'markRead': setFlags(userId, [m.id], { read: true }); break;
      case 'flag': setFlags(userId, [m.id], { flagged: true }); break;
      case 'move': await moveMessages(userId, [m.id], Number(a.folderId)); return;
      case 'archive': await archiveMessages(userId, [m.id]); return;
      case 'trash': await trashMessages(userId, [m.id]); return;
      case 'spam': await spamMessages(userId, [m.id]); return;
      case 'label': setLabels(userId, [m.id], { add: [a.labelId] }); break;
      case 'forward':
        if (a.to) queueSend(userId, { accountId: m.account_id, to: [a.to], subject: `Fwd: ${m.subject}`, html: m.body_html || undefined, text: m.body_text, attachments: json(m.attachments_json, []).filter((x) => !x.inline).map((x) => ({ fromMessageId: m.id, index: x.index })) });
        break;
      default: break;
    }
  }
}
