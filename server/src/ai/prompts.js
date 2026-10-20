// Prompt construction. Kept compact so small local models (7–8B) handle them well.
import { json } from '../db/index.js';
import { splitPlainQuote } from '../util/quotes.js';

export const CATEGORIES = ['personal', 'work', 'finance', 'shopping', 'travel', 'newsletter', 'promotion', 'social', 'notification', 'security', 'calendar', 'support', 'other'];

// Removes quoted history and signatures so the model sees the new content.
export function stripQuoted(text) {
  const q = splitPlainQuote(text);
  return (q ? q.own : String(text || '')).split(/\r?\n/).filter((l) => !/^\s*>/.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** "Tue 2026-10-20 14:05" in the given time zone (models resolve "tomorrow" etc. from the local date). */
export function localStamp(t, tz) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return `${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  } catch { return new Date(t).toISOString(); }
}

export function messageForPrompt(m, maxChars = 6000, tz = null) {
  const to = json(m.to_json, []).map((a) => a.name || a.address).join(', ');
  const cc = json(m.cc_json, []).map((a) => a.name || a.address).slice(0, 15).join(', ');
  const body = stripQuoted(m.body_text).slice(0, maxChars);
  const atts = json(m.attachments_json, []).filter((a) => !a.inline).map((a) => a.filename);
  return `From: ${m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr}
To: ${to}${cc ? `
Cc: ${cc}` : ''}
Date: ${tz ? `${localStamp(m.date, tz)} (${tz})` : new Date(m.date).toISOString()}
Subject: ${m.subject}${atts.length ? `\nAttachments: ${atts.join(', ')}` : ''}

${body}`;
}

export function userContext(user, settings, accounts) {
  const lines = [`The user is ${user.name || 'the mailbox owner'} (${accounts.map((a) => a.email).join(', ')}).`];
  if (settings.ai.aboutMe) lines.push(`About the user: ${settings.ai.aboutMe}`);
  lines.push(`Current date/time: ${new Date().toString()} (timezone ${settings.calendar.timezone}).`);
  return lines.join('\n');
}

export function analyzePrompt({ ctx, message, senderInfo, language, timezone, fromMe = false, preferences = '', topics = [] }) {
  return {
    system: `You are an email triage assistant. ${ctx}
${fromMe ? 'This email was SENT BY THE USER. Summarise what the user wrote; "action_items" are things the user promised to do; "needs_reply" is false; priority is low (10-30) unless the user committed to something with a deadline.\n' : ''}Analyze the email and return a JSON object with exactly these keys:
- "summary": 1-2 sentence summary of what the email is about and what is asked (written in ${language}).
- "category": one of ${CATEGORIES.join(', ')}.
- "priority": integer 0-100 for how important it is that the USER sees this soon (personal requests from real people, deadlines, money, security = high; newsletters, promotions, automated notifications = low). Weigh how the user is addressed (see "Recipients"): the only direct recipient = most important; one of many in To = less; only in CC = usually informational unless the user is named or asked to act; not addressed at all (mailing list / BCC) = low unless clearly relevant to the user.
- "priority_reason": short reason (max 12 words, ${language}).
- "needs_reply": true if a real person expects a reply from the user.
- "action_items": array of {"text": string, "due": "YYYY-MM-DD" or null} the user must do (empty if none).
- "events": array of {"title": string, "date": "YYYY-MM-DD", "start_time": "HH:MM" or null, "end_time": "HH:MM" or null, "all_day": boolean, "location": string or null} for meetings/appointments/deadlines explicitly mentioned. Copy times exactly as written in the email (24-hour clock, the user's time zone ${timezone}; convert only if the email names a different time zone). Resolve relative dates ("tomorrow", "next Tuesday") from the email's date. Empty if none.
- "suggested_replies": if needs_reply, 3 very short distinct reply options (max 8 words each, in the email's language); else [].
- "sentiment": one of positive, neutral, negative, urgent.
- "language": ISO 639-1 code of the email.
- "is_phishing": true only if the email shows clear signs of phishing/scam.
- "expires": "YYYY-MM-DD HH:MM" (time zone ${timezone}) after which the email is no longer useful, else null. Set it for one-time/login/verification codes and sign-in or confirmation links (usually 10-30 minutes after the email's date unless a validity is stated), offers or notices valid only until a stated time, and reminders of events that are then over. Normal mail: null.
- "requested_items": if the sender asks the user to send or forward an earlier email, document or attachment, an array of {"description": short description in English, "keywords": 3-6 search words in the email's language and in English}; else [].
- "topic": short name (1-4 words) of the ongoing project, event, case or activity this email belongs to, e.g. "Helios grant", "NQW 2026 conference", "Order 4471", "Flat renovation"; null for one-off mail, newsletters and notifications.${topics.length ? ` Reuse one of these existing topics when it fits: ${topics.map((t) => `"${t}"`).join(', ')}.` : ''}
- "facts": 0-3 short, self-contained facts worth remembering for months (who someone is and their role, agreements, commitments, deadlines, project names), written in ${language} with full names, e.g. "Ana Novak is the user's PhD student". Use [] for newsletters, notifications, promotions and routine mail — usually [].
${preferences ? `\nThe user's own past corrections (follow them for similar mail):\n${preferences}\n` : ''}Output JSON only.`,
    messages: [{ role: 'user', content: `${senderInfo}\n\n${message}` }],
  };
}

export function threadSummaryPrompt({ ctx, messages, language }) {
  return {
    system: `You summarize email conversations. ${ctx}
Write a concise summary in ${language} as 2-5 bullet points ("- "): what was discussed, decisions made, open questions, and who is waiting on whom. No preamble.`,
    messages: [{ role: 'user', content: messages.map((m, i) => `### Message ${i + 1}\n${m}`).join('\n\n') }],
  };
}

export function draftReplyPrompt({ ctx, style, learned, examples, thread, intent, language, signatureName }) {
  return {
    system: `You write email replies on behalf of the user. ${ctx}
${style ? `User's writing style (their own description — follow it): ${style}\n` : ''}${learned ? `How the user usually writes (learned from their sent mail): ${learned}\n` : ''}${examples ? `Emails the user wrote earlier to this recipient — match greeting, tone, formality, length, language and sign-off:\n${examples}\n` : ''}Write only the reply body (no subject line, no quoted text, no placeholders like [Name] unless information is truly unknown).
Reply in ${language}. Keep it natural, concise and appropriate in tone. Sign off as ${signatureName || 'the user'}.`,
    messages: [{ role: 'user', content: `Conversation (most recent last):\n\n${thread}\n\n${intent ? `The reply should: ${intent}` : 'Write the most appropriate reply.'}` }],
  };
}

export function composePrompt({ ctx, style, learned, examples, instruction, recipients, language, signatureName }) {
  return {
    system: `You draft new emails on behalf of the user. ${ctx}
${style ? `User's writing style (their own description — follow it): ${style}\n` : ''}${learned ? `How the user usually writes (learned from their sent mail): ${learned}\n` : ''}${examples ? `Emails the user wrote earlier to this recipient — match greeting, tone, formality, length, language and sign-off:\n${examples}\n` : ''}Output format exactly:
Subject: <subject line>

<email body>
Write in ${language}. Sign off as ${signatureName || 'the user'}.`,
    messages: [{ role: 'user', content: `${recipients ? `Recipients: ${recipients}\n` : ''}Write an email that: ${instruction}` }],
  };
}

const REWRITE_MODES = {
  improve: 'Improve clarity, flow and grammar while keeping meaning and tone.',
  fix: 'Fix spelling, grammar and punctuation only. Change nothing else.',
  shorten: 'Make it significantly shorter and more direct, keeping key points.',
  expand: 'Expand it with more detail and context while keeping it professional.',
  formal: 'Rewrite in a formal, professional tone.',
  friendly: 'Rewrite in a warm, friendly tone.',
  confident: 'Rewrite to sound more confident and assertive, without being rude.',
  bullet: 'Restructure the content into clear bullet points where appropriate.',
};

export function stylePrompt({ samples }) {
  return {
    system: `You analyse how a person writes emails. From the samples of their sent emails, describe their writing style in 4-8 short bullet points:
greetings and sign-offs they use (by recipient type, e.g. colleagues vs. external, formal vs. informal), tone and formality, typical length and structure,
languages they use and with whom, recurring phrases. Be concrete and quote short phrases. Do not mention names, addresses or confidential content.`,
    messages: [{ role: 'user', content: samples.map((s, i) => `### Email ${i + 1} (to ${s.to})\n${s.text}`).join('\n\n') }],
  };
}

export function rewritePrompt({ text, mode, instruction, language }) {
  let task = REWRITE_MODES[mode] || instruction || REWRITE_MODES.improve;
  if (mode === 'translate') task = `Translate it into ${language}. Preserve formatting.`;
  return {
    system: 'You are an expert editor. Return only the rewritten text, without commentary, quotes or code fences. Preserve line breaks between paragraphs.',
    messages: [{ role: 'user', content: `Task: ${task}\n\nText:\n${text}` }],
  };
}

export function briefPrompt({ ctx, language, data }) {
  return {
    system: `You are an executive assistant preparing the user's daily briefing. ${ctx}
The app already shows the full lists of important emails, events and tasks next to your text, so do NOT repeat them item by item.
Write in ${language}, in Markdown:
1. A 2-4 sentence overview of the day: what matters most and why.
2. "## Heads-up" — at most 5 bullets about things that need judgement: conflicts, deadlines, follow-ups, risks. Link emails as [open](msg:ID).
3. Optionally "## FYI" — one or two lines on noteworthy low-priority items.
Be concise; no filler.`,
    messages: [{ role: 'user', content: JSON.stringify(data) }],
  };
}

export function askPrompt({ ctx, language, context, history }) {
  return {
    system: `You are Halcyon, an AI assistant with access to the user's email, calendar, contacts and tasks. ${ctx}
Answer using the provided context. Cite emails inline as [#ID] using the message ID numbers given. If the context lacks the answer, say so and suggest a search.
Be concise. Respond in ${language} unless the user writes in another language.

CONTEXT:
${context}`,
    messages: history,
  };
}

export function extractEventPrompt({ ctx, message, timezone }) {
  return {
    system: `Extract a calendar event from the email. ${ctx}
Return JSON: {"title": string, "date": "YYYY-MM-DD", "start_time": "HH:MM" or null, "end_time": "HH:MM" or null, "all_day": boolean, "location": string|null, "description": short string, "attendees": [emails]}.
Copy times exactly as written in the email (24-hour clock, time zone ${timezone}; convert only if the email names a different zone). Resolve relative dates from the email's date. If no date is mentioned, propose the next reasonable working-day slot.`,
    messages: [{ role: 'user', content: message }],
  };
}
