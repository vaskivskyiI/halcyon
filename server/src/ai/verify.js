// Second opinion on what the analysis flagged. Small local models often get the direction wrong ("Marko will reply"
// read as "reply to Marko") or turn reminders into to-dos, so "needs reply" / "action needed" are kept only when a
// focused check finds the sentence in THE EMAIL that asks the user — and that sentence really is in the email.
// The same kind of focused check decides which open requests an email by the user answered or completed.
import { chatJSON } from './router.js';
import * as P from './prompts.js';

// Automated senders: nobody reads a reply.
export const AUTOMATED = /(^|[._+-])(no-?reply|do-?not-?reply|donotreply|notifications?|notify|alerts?|mailer-daemon|postmaster|bounces?|announcements?|newsletters?|news|automated)([._+-]|@)/i;
export const isAutomated = (m) => AUTOMATED.test(String(m.from_addr || '')) || /-bounces@|-request@/i.test(String(m.from_addr || ''));

// Not something to do: being somewhere at a time (the event goes to the calendar), or putting it in the calendar.
const NOT_A_TASK = /^\s*(add|put|save|enter|note)\b[^.]{0,60}\b(calendar|koledar)|^\s*(attend|join|be at|go to|participate|save (your )?work)\b/i;
export const notATask = (text) => NOT_A_TASK.test(String(text || ''));

const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[\p{L}\p{N}]{3,}/gu) || [];
/** The quoted sentence is (mostly) in the text — so the model did not make it up or take it from quoted history. */
export function quoted(quote, text) {
  const q = words(quote);
  if (q.length < 2) return false;
  const t = new Set(words(text));
  return q.filter((w) => t.has(w)).length / q.length >= 0.7;
}

export function verifyPrompt({ ctx, conversation, message, flagged, language = 'English' }) {
  return {
    system: `You check another assistant's triage of an email; it is often wrong. ${ctx}
"THE USER" is the mailbox owner. Judge only THE EMAIL (the new text of it); the earlier conversation and quoted text are context.
Return JSON with exactly these keys:
- "reply_quote": the exact sentence from THE EMAIL in which the sender asks THE USER a question or asks THE USER to answer/decide/confirm something, copied word for word; "" if there is none.
- "task_quote": the exact sentence from THE EMAIL that asks THE USER to do something (pay, sign, send, review, approve, register, submit, book, fill in…), copied word for word; "" if there is none.
- "task": that task as a short imperative (max 10 words, in ${language}), with a deadline ONLY if THE EMAIL states one; "" if none.
Answer "" when: the sender says THEY will do something or will reply later; the question or request is addressed to someone else (another recipient, "Marko, could you…"); it was the USER who asked (earlier); it is an automated notification, reminder, receipt, alert or newsletter (nobody reads a reply); the only "task" is attending a meeting or adding an event to the calendar; it is a sign-in / new-device / security notice that does not say the account is locked or must be secured.
The other assistant flagged: ${flagged}. Output JSON only.`,
    messages: [{ role: 'user', content: `${conversation ? `EARLIER IN THIS CONVERSATION (context only):\n${conversation}\n\n` : ''}THE EMAIL:\n${message}` }],
  };
}

/** Applies the second opinion to the analysis result `d` (needs_reply / needs_action / action_summary). */
export async function verifyOpen(userId, m, d, { ctx, conversation, message, interactive = false, language }) {
  const flagged = [d.needs_reply && 'needs a reply', d.needs_action && `action "${d.action_summary || ''}"`].filter(Boolean).join(' and ');
  const { data: v } = await chatJSON(userId, 'background', { ...verifyPrompt({ ctx, conversation, message, flagged, language }), temperature: 0, maxTokens: 300, interactive });
  const own = `${m.subject || ''}\n${P.stripQuoted(m.body_text)}`;
  if (d.needs_reply && !quoted(v.reply_quote, own)) d.needs_reply = false;
  if (d.needs_action) {
    if (!quoted(v.task_quote, own) || !String(v.task || '').trim() || notATask(v.task)) d.needs_action = false;
    else d.action_summary = String(v.task).trim().slice(0, 160);
  }
  d.verified = { reply: v.reply_quote || '', task: v.task_quote || '' };
  return d;
}

export function resolvePrompt({ ctx, message, requests }) {
  return {
    system: `${ctx}
THE USER sent the email below. For each open request (sent to the user earlier) decide whether this email by the user answers it or completes it — also when it is a new conversation, has another subject or goes to more people. Say true only when the email clearly does it (gives the answer, sends what was asked, confirms the date, says it is done). A mere "thanks", "I will look at it" or a reply about something else is false.
Return JSON: {"answers": [{"id": <number>, "done": true|false}]} with one entry per request. Output JSON only.`,
    messages: [{ role: 'user', content: `OPEN REQUESTS:\n${requests}\n\nTHE USER'S EMAIL:\n${message}` }],
  };
}

/** Ids of the open requests (from openRequestsFor) that the user's email answers or completes. */
export async function resolveCheck(userId, { ctx, message, candidates, tz, interactive = false }) {
  if (!candidates.length) return [];
  const requests = candidates.map((c) => `[${c.id}] ${P.localStamp(c.date, tz).slice(0, 10)} from ${c.from_name || c.from_addr} · ${c.subject}${c.action_summary ? ` → ${c.action_summary}` : ''}${c.summary ? ` — ${c.summary}` : ''}`).join('\n');
  const { data } = await chatJSON(userId, 'background', { ...resolvePrompt({ ctx, message, requests }), temperature: 0, maxTokens: 300, interactive });
  return (Array.isArray(data.answers) ? data.answers : []).filter((a) => a && a.done === true).map((a) => Number(a.id)).filter((id) => candidates.some((c) => c.id === id));
}
