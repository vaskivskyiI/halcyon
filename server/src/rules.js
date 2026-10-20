// Mail rules (filters). Rules with AI conditions run after background analysis; others on arrival.
import { all, get, run, json, now } from './db/index.js';
import { setFlags, moveMessages, archiveMessages, trashMessages, spamMessages, setLabels } from './mail/actions.js';
import { queueSend } from './mail/send.js';
import { notify } from './util/events.js';
import { logger } from './util/log.js';

const log = logger('rules');
const AI_FIELDS = new Set(['category', 'priority', 'needsReply']);
// Actions that lose or disclose mail. When a rule depends on AI output they are never executed automatically:
// a crafted email can steer the model's verdict, so the user has to approve each one (see ai_approvals).
const GATED = new Set(['trash', 'spam', 'forward']);

export const isAiRule = (rule) => json(rule.conditions_json, []).some((c) => AI_FIELDS.has(c.field));

function needsApproval(userId, a) {
  if (GATED.has(a.type)) return true;
  if (a.type !== 'move') return false;
  const f = get('SELECT f.special_use FROM folders f JOIN accounts a ON a.id = f.account_id WHERE f.id = ? AND a.user_id = ?', Number(a.folderId), userId);
  return !f || f.special_use === '\\Trash' || f.special_use === '\\Junk';
}

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
    .filter((r) => isAiRule(r) === (phase === 'ai'));
  if (!rules.length) return;
  for (const id of ids) {
    const m = get('SELECT * FROM messages WHERE id = ?', id);
    if (!m) continue;
    const ins = get('SELECT * FROM ai_insights WHERE message_id = ?', id);
    for (const rule of rules) {
      if (!ruleMatches(rule, m, ins)) continue;
      let actions = json(rule.actions_json, []);
      if (phase === 'ai') {
        for (const a of actions.filter((x) => needsApproval(userId, x))) proposeAction(userId, m.id, rule, a);
        actions = actions.filter((x) => !needsApproval(userId, x));
      }
      try { await runActions(userId, m, actions); } catch (e) { log.warn(`rule ${rule.id}: ${e.message}`); }
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

function proposeAction(userId, messageId, rule, action) {
  const actionJson = JSON.stringify(action);
  if (get("SELECT 1 AS x FROM ai_approvals WHERE user_id = ? AND message_id = ? AND action_json = ? AND status = 'pending'", userId, messageId, actionJson)) return;
  run('INSERT INTO ai_approvals (user_id, message_id, rule_id, rule_name, action_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    userId, messageId, rule.id, rule.name || '', actionJson, now());
  notify(userId, 'ai:approval', { count: pendingApprovalCount(userId) });
}

export const pendingApprovalCount = (userId) => get("SELECT COUNT(*) AS n FROM ai_approvals WHERE user_id = ? AND status = 'pending'", userId).n;

export function listApprovals(userId) {
  return all(`SELECT p.*, m.subject, m.from_name, m.from_addr, m.date, i.category, i.priority, i.summary
    FROM ai_approvals p JOIN messages m ON m.id = p.message_id LEFT JOIN ai_insights i ON i.message_id = m.id
    WHERE p.user_id = ? AND p.status = 'pending' ORDER BY p.created_at DESC LIMIT 200`, userId).map((r) => ({
    id: r.id, messageId: r.message_id, ruleId: r.rule_id, ruleName: r.rule_name, action: json(r.action_json, {}), createdAt: r.created_at,
    message: { subject: r.subject, from: r.from_name || r.from_addr, fromAddr: r.from_addr, date: r.date, category: r.category, priority: r.priority, summary: r.summary },
  }));
}

/** The user's decision on a proposed action. Only this path (an explicit user request) executes gated actions. */
export async function decideApproval(userId, id, approve) {
  const p = get("SELECT * FROM ai_approvals WHERE id = ? AND user_id = ? AND status = 'pending'", id, userId);
  if (!p) return null;
  run('UPDATE ai_approvals SET status = ?, decided_at = ? WHERE id = ?', approve ? 'approved' : 'dismissed', now(), p.id);
  const m = get('SELECT * FROM messages WHERE id = ? AND user_id = ?', p.message_id, userId);
  if (approve && m) await runActions(userId, m, [json(p.action_json, {})]);
  notify(userId, 'ai:approval', { count: pendingApprovalCount(userId) });
  return { ok: true, executed: !!(approve && m) };
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
