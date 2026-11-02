// Reading an email into what the store keeps, without the database: store.js has new mail parsed in worker threads
// (parse-worker.js) so a large or tricky message does not hold up requests while it is taken apart.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import { htmlToText } from './sanitize.js';
import { parseIcs } from '../calendar/ics.js';

export const addrList = (a) => (a ? (Array.isArray(a) ? a : [a]).flatMap((x) => x.value || []).map((v) => ({ name: v.name || '', address: (v.address || '').toLowerCase() })).filter((v) => v.address) : []);
export const cleanId = (s) => (s || '').trim().replace(/^<|>$/g, '');

// The Sender header names who actually sent a message when that is not the From address ("Ana on behalf of the
// Director"). Mailing lists and bulk-mail services set it to list / bounce addresses: those are not worth showing.
const SYSTEM_SENDER = /(^|[-_.+])(bounces?|owner|request|noreply|no-reply|donotreply|mailer-daemon|postmaster|listserv|mailman|majordomo)([-_.+@]|$)/i;
export function actingSender(headers, from) {
  const s = addrList(headers.get('sender'))[0];
  if (!s || s.address === String(from.address || '').toLowerCase()) return '';
  if (headers.has('list-id') || headers.has('list-post') || SYSTEM_SENDER.test(s.address)) return '';
  return JSON.stringify(s);
}

export const simpleParse = (raw) => simpleParser(raw, { skipImageLinks: true, skipTextToHtml: false, keepCidLinks: true });

// Calendar data in a message: a text/calendar or .ics part (any type name senders use), calendar data recognised by its
// content in other text parts, or inside a forwarded message (the original invitation attached as message/rfc822).
const ICS_BLOCK = /BEGIN:VCALENDAR[\s\S]*?END:VCALENDAR/;
export async function findIcs(parsed, depth = 0) {
  const atts = parsed.attachments || [];
  const typed = atts.find((a) => /^(text\/calendar|text\/x-vcalendar|application\/ics|application\/x-ics)/i.test(a.contentType || '') || /\.(ics|vcs)$/i.test(a.filename || ''));
  const block = (s) => { const m = String(s || '').match(ICS_BLOCK); return m && /BEGIN:VEVENT/.test(m[0]) ? m[0] : null; };
  if (typed) return block(typed.content.toString('utf8')) || typed.content.toString('utf8');
  for (const a of atts) {
    if (a.size > 5e6) continue;
    if (/^message\/rfc822/i.test(a.contentType || '') && depth < 2) {
      const inner = await findIcs(await simpleParse(a.content), depth + 1).catch(() => null);
      if (inner) return inner;
    } else if (/^(text\/|application\/octet-stream)/i.test(a.contentType || '')) {
      const b = block(a.content.toString('utf8'));
      if (b) return b;
    }
  }
  // Some clients put the invitation in a text body part.
  return block(parsed.text);
}

/** Text of an invitation that has no body of its own (only calendar data): its description and location. */
export function inviteText(ics) {
  try {
    const e = parseIcs(ics).events[0];
    return e ? [e.description, e.location && `Location: ${e.location}`].filter(Boolean).join('\n\n') : '';
  } catch { return ''; }
}

/**
 * When a message cannot be parsed, it is stored anyway — with the headers that can be read and a note — so nothing
 * that arrived is lost; the original stays available for download.
 */
export function fallbackParse(raw, err) {
  const head = raw.subarray(0, 65536).toString('latin1').split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');
  const h = (name) => (head.match(new RegExp(`^${name}:[ \t]*(.*)$`, 'mi')) || [])[1]?.trim() || '';
  const addr = (v) => { const m = v.match(/^(.*?)<([^>]+)>/); return m ? { value: [{ name: m[1].replace(/"/g, '').trim(), address: m[2].trim() }] } : (v ? { value: [{ name: '', address: v }] } : null); };
  const date = new Date(h('Date'));
  return {
    messageId: h('Message-ID'), inReplyTo: h('In-Reply-To'), references: h('References') || undefined, subject: h('Subject') || '(message could not be read)',
    from: addr(h('From')), to: addr(h('To')), cc: null, bcc: null, replyTo: null, date: Number.isNaN(date.getTime()) ? null : date,
    text: `This message could not be read completely (${err.message}). Download the original to open it in another program.`, html: null, attachments: [], headers: new Map(),
  };
}

/** Everything ingest stores from a raw message, as plain values (it crosses from the worker thread). */
export async function digest(raw) {
  let parsed;
  try { parsed = await simpleParse(raw); } catch (e) { parsed = fallbackParse(raw, e); }
  const inReplyTo = cleanId(parsed.inReplyTo);
  let refs = parsed.references ? (Array.isArray(parsed.references) ? parsed.references : String(parsed.references).split(/\s+/)) : [];
  refs = refs.map(cleanId).filter(Boolean);
  if (inReplyTo && !refs.includes(inReplyTo)) refs.push(inReplyTo);
  const from = addrList(parsed.from)[0] || { name: '', address: '' };
  const html = parsed.html || null;
  let text = parsed.text || (html ? htmlToText(html) : '');
  const attachments = (parsed.attachments || []).map((a, i) => (
    { index: i, filename: a.filename || `attachment-${i + 1}`, contentType: a.contentType, size: a.size, cid: a.cid || null, inline: a.contentDisposition === 'inline' && !!a.cid }));
  const ics = (await findIcs(parsed)) || '';
  // An invitation sent as calendar data only: its description is the message.
  if (!html && !text.trim() && ics) text = inviteText(ics);
  const unsub = parsed.headers.get('list-unsubscribe');
  return {
    messageId: cleanId(parsed.messageId), inReplyTo, refs, subject: parsed.subject || '', from,
    to: addrList(parsed.to), cc: addrList(parsed.cc), bcc: addrList(parsed.bcc), replyTo: addrList(parsed.replyTo),
    date: parsed.date ? parsed.date.getTime() : null, html, text, snippet: text.replace(/\s+/g, ' ').trim().slice(0, 240), attachments, ics,
    unsubscribe: unsub ? (typeof unsub === 'string' ? unsub : JSON.stringify(unsub)) : null, sender: actingSender(parsed.headers, from),
  };
}

/**
 * The original kept in dir (the account's folder of the mail store), named by its content so each is written once.
 * On the parse worker too: on Windows a write or a new folder sometimes takes long (virus scanners).
 */
export function saveRaw(dir, raw) {
  const file = path.join(dir, `${crypto.createHash('sha1').update(raw).digest('hex')}.eml`);
  if (!fs.existsSync(file)) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, raw); }
  return file;
}

/** digest, with the original saved: { ...digest, rawPath }. */
export async function digestAndSave(raw, dir) {
  return { ...(await digest(raw)), rawPath: saveRaw(dir, raw) };
}
