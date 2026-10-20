// Prompt construction. Kept compact so small local models (7–8B) handle them well.
import { json } from '../db/index.js';

export const CATEGORIES = ['personal', 'work', 'finance', 'shopping', 'travel', 'newsletter', 'promotion', 'social', 'notification', 'security', 'calendar', 'support', 'other'];

// Removes quoted history and signatures so the model sees the new content.
export function stripQuoted(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (const l of lines) {
    if (/^On .{5,200} wrote:\s*$/i.test(l) || /^-{2,}\s*Original Message\s*-{2,}/i.test(l) || /^_{10,}$/.test(l) || /^From: .+$/.test(l) && out.length > 3) break;
    if (/^\s*>/.test(l)) continue;
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function messageForPrompt(m, maxChars = 6000) {
  const to = json(m.to_json, []).map((a) => a.name || a.address).join(', ');
  const body = stripQuoted(m.body_text).slice(0, maxChars);
  const atts = json(m.attachments_json, []).filter((a) => !a.inline).map((a) => a.filename);
  return `From: ${m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr}
To: ${to}
Date: ${new Date(m.date).toISOString()}
Subject: ${m.subject}${atts.length ? `\nAttachments: ${atts.join(', ')}` : ''}

${body}`;
}

export function userContext(user, settings, accounts) {
  const lines = [`The user is ${user.name || 'the mailbox owner'} (${accounts.map((a) => a.email).join(', ')}).`];
  if (settings.ai.aboutMe) lines.push(`About the user: ${settings.ai.aboutMe}`);
  lines.push(`Current date/time: ${new Date().toString()} (timezone ${settings.calendar.timezone}).`);
  return lines.join('\n');
}

export function analyzePrompt({ ctx, message, senderInfo, language }) {
  return {
    system: `You are an email triage assistant. ${ctx}
Analyze the email and return a JSON object with exactly these keys:
- "summary": 1-2 sentence summary of what the email is about and what is asked (written in ${language}).
- "category": one of ${CATEGORIES.join(', ')}.
- "priority": integer 0-100 for how important it is that the USER sees this soon (personal requests from real people, deadlines, money, security = high; newsletters, promotions, automated notifications = low).
- "priority_reason": short reason (max 12 words, ${language}).
- "needs_reply": true if a real person expects a reply from the user.
- "action_items": array of {"text": string, "due": "YYYY-MM-DD" or null} the user must do (empty if none).
- "events": array of {"title": string, "start": ISO 8601 datetime with timezone offset, "end": ISO datetime or null, "all_day": boolean, "location": string or null} for meetings/appointments/deadlines explicitly mentioned (empty if none).
- "suggested_replies": if needs_reply, 3 very short distinct reply options (max 8 words each, in the email's language); else [].
- "sentiment": one of positive, neutral, negative, urgent.
- "language": ISO 639-1 code of the email.
- "is_phishing": true only if the email shows clear signs of phishing/scam.
- "facts": 0-3 short, self-contained facts worth remembering for months (who someone is and their role, agreements, commitments, deadlines, project names), written in ${language} with full names, e.g. "Ana Novak is the user's PhD student". Use [] for newsletters, notifications, promotions and routine mail — usually [].
Output JSON only.`,
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

export function draftReplyPrompt({ ctx, style, thread, intent, language, signatureName }) {
  return {
    system: `You write email replies on behalf of the user. ${ctx}
${style ? `User's writing style: ${style}\n` : ''}Write only the reply body (no subject line, no quoted text, no placeholders like [Name] unless information is truly unknown).
Reply in ${language}. Keep it natural, concise and appropriate in tone. Sign off as ${signatureName || 'the user'}.`,
    messages: [{ role: 'user', content: `Conversation (most recent last):\n\n${thread}\n\n${intent ? `The reply should: ${intent}` : 'Write the most appropriate reply.'}` }],
  };
}

export function composePrompt({ ctx, style, instruction, recipients, language, signatureName }) {
  return {
    system: `You draft new emails on behalf of the user. ${ctx}
${style ? `User's writing style: ${style}\n` : ''}Output format exactly:
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
Write in ${language}, in Markdown. Structure:
1. One-sentence overview of the day.
2. "## Needs your attention" — most important emails (max 7). Each line: "- **Sender** — what they need [open](msg:ID)".
3. "## Today's schedule" — events with times; flag conflicts.
4. "## Tasks" — due/overdue tasks.
5. "## FYI" — noteworthy low-priority items in one or two lines.
Omit empty sections. Be concise; no filler.`,
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

export function extractEventPrompt({ ctx, message }) {
  return {
    system: `Extract a calendar event from the email. ${ctx}
Return JSON: {"title": string, "start": ISO 8601 datetime with offset, "end": ISO datetime, "all_day": boolean, "location": string|null, "description": short string, "attendees": [emails]}. If no date is mentioned, propose the next reasonable working-day slot.`,
    messages: [{ role: 'user', content: message }],
  };
}
