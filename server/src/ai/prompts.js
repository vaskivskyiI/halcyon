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

/** "Ana Novak <ana@x> → THE USER (cc Marko)": who wrote to whom, with the user marked (own: the user's addresses). */
export function whoWrote(m, own) {
  const label = (a) => (own.has(String(a.address || '').toLowerCase()) ? 'THE USER' : a.name ? `${a.name} <${a.address}>` : a.address);
  const to = json(m.to_json, []).map(label);
  const cc = json(m.cc_json, []).map(label);
  return `${label({ name: m.from_name, address: m.from_addr })} → ${to.slice(0, 8).join(', ') || '(undisclosed recipients)'}${cc.length ? ` (cc ${cc.slice(0, 8).join(', ')})` : ''}`;
}

/** Earlier messages of a conversation (oldest first), each labelled with who wrote to whom, for the AI to see who asked whom. */
export function conversationForPrompt(msgs, own, tz, budget = 3600) {
  const per = Math.max(400, Math.floor(budget / Math.max(1, msgs.length)));
  return msgs.map((x) => `[${localStamp(x.date, tz)}] ${whoWrote(x, own)}\n${stripQuoted(x.body_text).slice(0, per) || '(no text)'}`).join('\n\n');
}

export function messageForPrompt(m, maxChars = 6000, tz = null, own = null) {
  const to = json(m.to_json, []).map((a) => a.name || a.address).join(', ');
  const cc = json(m.cc_json, []).map((a) => a.name || a.address).slice(0, 15).join(', ');
  const body = stripQuoted(m.body_text).slice(0, maxChars);
  const atts = json(m.attachments_json, []).filter((a) => !a.inline).map((a) => a.filename);
  return `${own ? `Written: ${whoWrote(m, own)}\n` : ''}From: ${m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr}
To: ${to}${cc ? `
Cc: ${cc}` : ''}
Date: ${tz ? `${localStamp(m.date, tz)} (${tz})` : new Date(m.date).toISOString()}
Subject: ${m.subject}${atts.length ? `\nAttachments: ${atts.join(', ')}` : ''}

${body}`;
}

export const LANG_NAMES = { en: 'English', sl: 'Slovenian', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', hr: 'Croatian', sr: 'Serbian', uk: 'Ukrainian', pl: 'Polish', pt: 'Portuguese', nl: 'Dutch', cs: 'Czech', ru: 'Russian', ja: 'Japanese', zh: 'Chinese' };

/**
 * Who the user is, for the prompts. With `account` (mail of one account — reading, replying, writing from it): the
 * user's general description plus that account's own context only, so e.g. private mail is not handled with the
 * work role in mind. Without (assistant, brief): everything, each account's context labelled.
 */
export function userContext(user, settings, accounts, account = null) {
  const flat = (s) => String(s || '').replace(/\s*\n\s*/g, ' ').trim();
  const lines = [account
    ? `The user is ${user.name || 'the mailbox owner'}; this is about their account ${account.email}${json(account.aliases_json, []).length ? ` (also ${json(account.aliases_json, []).map((x) => x?.address || x).join(', ')})` : ''}.`
    : `The user is ${user.name || 'the mailbox owner'} (${accounts.map((a) => a.email).join(', ')}).`];
  if (settings.ai.aboutMe) lines.push(`About the user (their own words, authoritative): ${settings.ai.aboutMe}`);
  if (account) {
    if (account.about_me) lines.push(`About the user in this account (their own words, authoritative): ${flat(account.about_me)}`);
    if (account.learned_about) lines.push(`What this account's mail shows about the user (learned; the user's own words win): ${flat(account.learned_about)}`);
  } else {
    if (settings.ai.learnedAboutMe) lines.push(`What the user's mail shows about them (learned; the user's own words win): ${flat(settings.ai.learnedAboutMe)}`);
    for (const a of accounts.filter((x) => x.about_me || x.learned_about)) lines.push(`In their account ${a.email}: ${flat(a.about_me || a.learned_about).slice(0, 400)}`);
  }
  // The model has no clock: state "now" explicitly, in the user's time zone (the server may run in UTC).
  lines.push(`Now: ${localStamp(Date.now(), settings.calendar.timezone)} (${settings.calendar.timezone}). Anything dated before now is in the past.`);
  return lines.join('\n');
}

export function analyzePrompt({ ctx, message, senderInfo, language, timezone, fromMe = false, preferences = '', topics = [], openRequests = '', related = '', conversation = '', custom = '' }) {
  return {
    system: `You are an email triage assistant. ${ctx}
${fromMe ? 'This email was SENT BY THE USER. Summarise what the user wrote; "action_items" are things the user promised to do; "needs_reply" is false; priority is low (10-30) unless the user committed to something with a deadline. Also give "expects_reply": true if the user asks the recipient(s) a question or for something (a decision, a document, a date, a confirmation) and is waiting for their answer; false for thanks, information, answers and FYI.\n' : ''}WHO ASKED WHOM — get this right: every message is labelled with who wrote it to whom ("THE USER" is the mailbox owner). Analyse only THE EMAIL; the earlier conversation and any quoted text are context for understanding it. A question or request the USER made earlier is not something the user must answer or do: if THE EMAIL answers it, summarise the answer (e.g. "Tuesday 10:00 works for Marko; he will bring the slides") and "needs_reply" is false unless the email asks the user something new. What the sender promises or will do is not an action for the user. A request in THE EMAIL addressed to someone else (another recipient, "Marko, could you…") is not for the user. When it matters who must act, name them; refer to the user as "you".
Analyze THE EMAIL and return a JSON object with exactly these keys:
- "summary": the substance in 1-2 short sentences (${language}): what the user is asked to do (only what THE EMAIL asks of the user), what was decided, answered or changed, or the key information — with the concrete details (amounts, dates, times, places, names of others, document names). Do NOT repeat or paraphrase the subject line, do NOT start with the sender's name or with "The email", "This message", "The sender", "X writes/informs/asks"; mention the sender only when it matters (e.g. who must act). Write it as a direct statement or an imperative, e.g. "Send the signed contract by Friday; the client accepted the 8% discount." not "Ana Novak sends an email about the contract."
- "category": one of ${CATEGORIES.join(', ')}.
- "priority": integer 0-100 for how important it is that the USER sees this soon (personal requests from real people, deadlines, money, security = high; newsletters, promotions, automated notifications = low). Weigh how the user is addressed (see "Recipients"): the only direct recipient = most important; one of many in To = less; only in CC = usually informational unless the user is named or asked to act; not addressed at all (mailing list / BCC) = low unless clearly relevant to the user.
- "priority_reason": short reason (max 12 words, ${language}).
- "needs_reply": true if a real person expects a reply from the user.
- "needs_action": true if the user must DO something other than (or besides) replying: pay, sign, approve, register, submit, review a document, book, attend, fill in a form. false for information only.
- "action_summary": if needs_action, the action as a short imperative with its deadline if any (max 10 words, ${language}), e.g. "Pay invoice 2026-0412 by 30 Oct"; else "".
- "action_items": array of {"text": string, "due": "YYYY-MM-DD" or "YYYY-MM-DD HH:MM" (with a time only when the email states one) or null} the user must do (empty if none). A deadline belongs here, as the "due" of the thing to be done, never in "events".
- "events": array of {"title": string, "date": "YYYY-MM-DD", "start_time": "HH:MM" or null, "end_time": "HH:MM" or null, "tz": string or null, "all_day": boolean, "location": string or null} for meetings and appointments explicitly mentioned: things that happen at a time and take up the user's time. Not deadlines ("submit by Friday 17:00", "due on 30 Oct"): those are action items. Copy times exactly as written in the email (24-hour clock), never convert them; add "tz": the time zone the email states for them (e.g. "UTC", "CET", "GMT+1", "Europe/London"), or null when none is stated (the user's zone ${timezone} is then assumed). Resolve relative dates ("tomorrow", "next Tuesday") from the email's date. Empty if none.
- "suggested_replies": if needs_reply, 3 very short distinct reply options (max 8 words each, in the email's language); else [].
- "sentiment": one of positive, neutral, negative, urgent.
- "language": ISO 639-1 code of the email.
- "is_phishing": true only if the email shows clear signs of phishing/scam.
- "expires": "YYYY-MM-DD HH:MM" (time zone ${timezone}) after which the email is no longer useful, else null. Set it for one-time/login/verification codes and sign-in or confirmation links (usually 10-30 minutes after the email's date unless a validity is stated), offers or notices valid only until a stated time, and reminders of events that are then over. Normal mail: null.
- "requested_items": ONLY if THE EMAIL explicitly asks the user to send, forward or share an earlier email, document or attachment: an array of {"description": short description in English, "keywords": 3-6 search words in the email's language and in English, "quote": the exact sentence of THE EMAIL that asks for it, copied word for word}; else []. Not for mail that merely mentions or attaches documents itself, and not for automated mail.
- "topic": short name (1-4 words) of the ongoing project, event, case or activity this email belongs to, e.g. "Helios grant", "NQW 2026 conference", "Order 4471", "Flat renovation"; null for one-off mail, newsletters and notifications.${topics.length ? ` Reuse one of these existing topics when it fits: ${topics.map((t) => `"${t}"`).join(', ')}.` : ''}
- "facts": 0-3 short, self-contained facts worth remembering for months (who someone is and their role, agreements, commitments, deadlines, project names), written in ${language} with full names, e.g. "Ana Novak is the user's PhD student". Use [] for newsletters, notifications, promotions and routine mail — usually [].
${custom}${fromMe && openRequests ? `- "resolves": the ids (numbers) of the OPEN REQUESTS below that this email by the user clearly answers or completes — also when it is a new conversation, has another subject or goes to more people (e.g. the user sends the asked-for document, confirms the date, gives the requested answer). [] when unsure: a wrong id hides a request the user still has to handle.
OPEN REQUESTS to the user (from these recipients or this conversation):
${openRequests}
` : ''}${related ? `\nRECENT MAIL WITH THE SAME PEOPLE in other conversations (context only — e.g. this email may answer or continue one of them; do not summarise these):\n${related}\n` : ''}${preferences ? `\nWhat the user taught you:\n${preferences}\n` : ''}Output JSON only.`,
    messages: [{ role: 'user', content: `${conversation ? `EARLIER IN THIS CONVERSATION (oldest first; context only — do not summarise it, use it to understand who asked whom and what THE EMAIL answers):\n${conversation}\n\n` : ''}THE EMAIL TO ANALYSE:\n${senderInfo}\n\n${message}` }],
  };
}

export function threadSummaryPrompt({ ctx, messages, language, settled = [] }) {
  return {
    system: `You summarize email conversations. ${ctx}
Write a concise summary in ${language} as 2-5 bullet points ("- "): decisions made, open questions, and who is waiting on whom, with concrete details (dates, amounts, names). Each message is labelled with who wrote it to whom; "THE USER" is the mailbox owner — call them "you", and keep straight who asked whom and who promised what. Do not restate the subject; no preamble.${settled.length ? `
SETTLED lists what the user has already dealt with. It outranks the emails: never present these things as open or still to do; say briefly that they are done or dropped.` : ''}`,
    messages: [{ role: 'user', content: `${messages.map((m, i) => `### Message ${i + 1}\n${m}`).join('\n\n')}${settled.length ? `\n\nSETTLED:\n${settled.map((x) => `- ${x}`).join('\n')}` : ''}` }],
  };
}

/** The summary of one email, brought up to date with what the user settled; no new facts, nothing else changes. */
export function settledSummaryPrompt({ ctx, summary, settled }) {
  return {
    system: `You update the summary of an email. ${ctx}
SETTLED lists what the user has already dealt with. Rewrite the summary so that it no longer presents these things as open or still to do: say briefly that they are done or dropped, or leave them out. Keep everything else, the language and about the same length. Add no new facts. Reply with the summary only.`,
    messages: [{ role: 'user', content: `SUMMARY:\n${summary}\n\nSETTLED:\n${settled.map((x) => `- ${x}`).join('\n')}` }],
  };
}

export function draftReplyPrompt({ ctx, style, learned, examples, thread, intent, language, signatureName, people = '', background = '' }) {
  return {
    system: `You write email replies on behalf of the user. ${ctx}
${style ? `User's writing style (their own description — follow it): ${style}\n` : ''}${learned ? `How the user usually writes (learned from their sent mail): ${learned}\n` : ''}${people ? `About the recipient (what the user's mail shows; follow "how the user writes to them" for greeting, form of address, formality, language and sign-off):\n${people}\n` : ''}${examples ? `Emails the user wrote earlier to this recipient — match greeting, tone, formality, length, language and sign-off:\n${examples}\n` : ''}Each message in the conversation is labelled with who wrote it to whom; "THE USER" is the person you write for — reply to the last message not written by them, and do not answer questions the user asked others as if they were asked of the user.
Write only the reply body (no subject line, no quoted text, no placeholders like [Name] unless information is truly unknown).
Use the BACKGROUND (the user's history with these people) to get it right: do not ask for what they already sent or answered, keep to what the user promised, agreed or said before (dates, numbers, decisions) or say clearly what changed, refer to earlier agreements when it helps, and do not repeat something the user already did. Never invent facts, dates, numbers or commitments that are not in the conversation, the background or the user's instruction — where something needed is unknown, leave a short [placeholder]. The user's instruction, when given, decides what the reply says.
Reply in ${language}. Keep it natural, concise and appropriate in tone. Sign off as ${signatureName || 'the user'}.`,
    messages: [{ role: 'user', content: `${background ? `BACKGROUND:\n${background}\n\n` : ''}Conversation (most recent last):\n\n${thread}\n\n${intent ? `The user's instruction for the reply: ${intent}` : 'Write the most appropriate reply.'}` }],
  };
}

export function composePrompt({ ctx, style, learned, examples, instruction, recipients, language, signatureName, people = '', background = '' }) {
  return {
    system: `You draft new emails on behalf of the user. ${ctx}
${style ? `User's writing style (their own description — follow it): ${style}\n` : ''}${learned ? `How the user usually writes (learned from their sent mail): ${learned}\n` : ''}${people ? `About the recipients (what the user's mail shows; follow "how the user writes to them"):\n${people}\n` : ''}${examples ? `Emails the user wrote earlier to this recipient — match greeting, tone, formality, length, language and sign-off:\n${examples}\n` : ''}Output format exactly:
Subject: <subject line>

<email body>
Use the BACKGROUND (the user's history with these people) to get it right: do not ask for what they already sent or answered, keep to what the user promised, agreed or said before (dates, numbers, decisions) or say clearly what changed, refer to earlier agreements when it helps, and do not repeat something the user already did. Never invent facts, dates, numbers or commitments that are not in the conversation, the background or the user's instruction — where something needed is unknown, leave a short [placeholder].
Write in ${language}. Sign off as ${signatureName || 'the user'}.`,
    messages: [{ role: 'user', content: `${background ? `BACKGROUND:\n${background}\n\n` : ''}${recipients ? `Recipients: ${recipients}\n` : ''}Write an email that: ${instruction}` }],
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
Time: "Now" is stated above and every item carries its date and how long ago / how far ahead it is. Never present past events or deadlines as upcoming.
For questions about what to do or what needs attention, answer from OPEN ITEMS RIGHT NOW (the current state); older emails in the context are background only, and mail the user already replied to is handled.
Be concise. Respond in ${language} unless the user writes in another language.

CONTEXT:
${context}`,
    messages: history,
  };
}

export function extractEventPrompt({ ctx, message, timezone }) {
  return {
    system: `Extract a calendar event from the email. ${ctx}
Return JSON: {"title": string, "date": "YYYY-MM-DD", "start_time": "HH:MM" or null, "end_time": "HH:MM" or null, "tz": string|null, "all_day": boolean, "location": string|null, "description": short string, "attendees": [emails]}.
Copy times exactly as written in the email (24-hour clock), never convert them; "tz" is the time zone the email states for them (e.g. "UTC", "CET", "GMT+1"), or null when none is stated (the user's zone ${timezone} is then assumed). Resolve relative dates from the email's date. If no date is mentioned, propose the next reasonable working-day slot.`,
    messages: [{ role: 'user', content: message }],
  };
}

/** Profile of one correspondent from the mail exchanged with them (ai/profiles.js). */
export function contactProfilePrompt({ ctx, name, email, transcript, facts = [], notes = '', language }) {
  return {
    system: `You build a short profile of a person the user exchanges email with, to help the user and an AI assistant later. ${ctx}
Use only what the emails show; do not guess. Return JSON with exactly these keys (texts in ${language}):
- "who": one sentence: who the person is, their role and organisation, and their relation to the user (e.g. "Head of procurement at Acme; the user's main contact for the Helios order").
- "relationship": one of colleague, manager, report, student, supervisor, client, supplier, partner, friend, family, service, other.
- "organisation": their organisation or "" if unknown.
- "topics": up to 6 short names of what they and the user write about.
- "language": the language(s) the user and this person use with each other.
- "user_writing": how THE USER writes to this person: greeting and form of address (first name / title / formal vs. informal "you", e.g. tikanje or vikanje), formality, typical length, sign-off — concrete, quoting short phrases.
- "their_style": how this person writes (brief).
- "notes": up to 5 durable facts worth remembering (preferences, agreements, recurring requests, deadlines that recur). [] if none.
${notes ? `The user's own notes about this person (authoritative — never contradict them): ${notes}\n` : ''}Output JSON only.`,
    messages: [{ role: 'user', content: `Person: ${name ? `${name} <${email}>` : email}\n${facts.length ? `Remembered facts:\n- ${facts.join('\n- ')}\n` : ''}\nEmails (oldest first):\n\n${transcript}` }],
  };
}

/** What the user's own sent mail shows about them (role, organisation, projects, people, languages). */
export function aboutMePrompt({ name, samples, facts = [], language }) {
  return {
    system: `From a person's own sent emails (and facts remembered from their mail), describe who they are professionally so that an email assistant can help them better.
Write 4-8 short bullet points in ${language}: role and organisation, main projects and responsibilities, the people and groups they work with most, recurring tasks, languages they write in.
Only what the emails show; no private or sensitive details (health, finances, passwords), no email addresses.`,
    messages: [{ role: 'user', content: `${name ? `Name: ${name}\n` : ''}${facts.length ? `Remembered facts:\n- ${facts.join('\n- ')}\n\n` : ''}Sent emails:\n\n${samples.map((s, i) => `### ${i + 1}. To ${s.to} · ${s.subject}\n${s.text}`).join('\n\n')}` }],
  };
}
