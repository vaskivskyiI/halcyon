// Focused / Other (the inbox split, and the "Mail in Focused" notifications): SQL over messages m LEFT JOIN ai_insights i.
import { all, get } from '../db/index.js';
import { NOISE as OPEN_NOISE } from '../ai/open-items.js';

// Mail the AI is about to read waits in Other, visible, and moves when the analysis says so. Mail it will not read stays in Focused.
export const analysing = (m) => `EXISTS (SELECT 1 FROM ai_jobs j WHERE j.user_id = ${m}.user_id AND j.type = 'analyze' AND j.ref_id = CAST(${m}.id AS TEXT) AND j.status IN ('queued', 'running'))`;
export const ANALYSING = analysing('m');
export const focusedOne = (i, m) => `((${i}.message_id IS NULL AND NOT ${analysing(m)}) OR (${i}.priority >= 40 AND COALESCE(${i}.category, '') NOT IN ${OPEN_NOISE}) OR ${i}.priority >= 70)`;
// Focused goes by conversation: a message is focused when it or another message of its conversation in an Inbox is, so a
// conversation is never split between Focused and Other (a reply to a focused conversation stays with it).
// Always Focused: conversations the user started or replied to (a message of theirs in Sent, or answered), and senders
// on the user's Focused list (focus.js; an address or a whole @domain).
export const FOCUS_SENDER = `EXISTS (SELECT 1 FROM focus_senders fs WHERE fs.user_id = m.user_id AND fs.focused = 1
  AND fs.address IN (lower(m.from_addr), '@' || substr(lower(m.from_addr), instr(m.from_addr, '@') + 1)))`;
export const MINE = `(m.is_answered = 1 OR (m.thread_id IS NOT NULL AND EXISTS (SELECT 1 FROM messages s WHERE s.user_id = m.user_id AND s.thread_id = m.thread_id
  AND s.folder_id IN (SELECT id FROM folders WHERE special_use = '\\Sent'))))`;
// Built when first used: ai/open-items.js (NOISE) can still be loading when this module is (they import each other).
let focusedSql = null;
export const FOCUSED = () => (focusedSql ||= `(${focusedOne('i', 'm')} OR ${FOCUS_SENDER} OR ${MINE} OR (m.thread_id IS NOT NULL AND EXISTS (SELECT 1 FROM messages t LEFT JOIN ai_insights ti ON ti.message_id = t.id
  WHERE t.user_id = m.user_id AND t.thread_id = m.thread_id AND t.id != m.id AND t.folder_id IN (SELECT id FROM folders WHERE special_use = '\\Inbox') AND ${focusedOne('ti', 't')})))`);

/** Of these new emails, those in Focused now (mail the AI is still to read is not, until it has). */
export const focusedOf = (ids) => (ids.length ? all(`SELECT m.id FROM messages m LEFT JOIN ai_insights i ON i.message_id = m.id
  WHERE m.id IN (${ids.map(() => '?').join(',')}) AND ${FOCUSED()}`, ...ids).map((r) => r.id) : []);

/** In Focused whatever the AI says (sender, the user's own conversation, a focused conversation): told on arrival. */
export const focusedByRule = (id) => !!get(`SELECT 1 AS x FROM messages m WHERE m.id = ? AND (${FOCUS_SENDER} OR ${MINE} OR (m.thread_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM messages t LEFT JOIN ai_insights ti ON ti.message_id = t.id WHERE t.user_id = m.user_id AND t.thread_id = m.thread_id AND t.id != m.id
  AND t.folder_id IN (SELECT id FROM folders WHERE special_use = '\\Inbox') AND ${focusedOne('ti', 't')})))`, id);
