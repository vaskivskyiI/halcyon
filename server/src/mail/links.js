// The links of an email, checked for phishing: plain rules at once (a link whose text shows another address, an IP
// address, a punycode or user@ host), and the AI's verdict, asked once per email (link_checks) when it is read.
import { get, run, json, now } from '../db/index.js';
import { getSettings } from '../settings.js';
import { chatJSON } from '../ai/router.js';
import { ownAddresses } from '../ai/open-items.js';
import { logger } from '../util/log.js';

const log = logger('links');

const MAX = 30;
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu', 'or', 'ne', 'go']);

/** example.co.uk from www.mail.example.co.uk — near enough for comparing where links go. */
export function siteOf(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (/^[\d.]+$/.test(h) || h.includes(':')) return h;
  const p = h.split('.');
  const n = p.length > 2 && p.at(-1).length === 2 && SECOND_LEVEL.has(p.at(-2)) ? 3 : 2;
  return p.slice(-n).join('.');
}

const decode = (s) => s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&#x([\da-f]+);/gi, (_, d) => String.fromCodePoint(parseInt(d, 16))).replace(/\s+/g, ' ').trim();
const norm = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x : null; } catch { return null; } };
// Text that is itself an address ("www.bank.com", "https://bank.com/login"): the host it shows.
const shownHost = (t) => { const m = /^(?:https?:\/\/)?((?:[\p{L}\d-]+\.)+[\p{L}]{2,})(?:[/:?#]\S*)?$/iu.exec(t.trim()); return m ? m[1].toLowerCase() : null; };

/** Web links of an email (unique, at most MAX) with what they show and the rules that call them suspicious. */
export function linksOf(m) {
  const found = new Map();
  const add = (href, text) => {
    const u = norm(href);
    if (!u || found.has(u.href) || found.size >= MAX) return;
    const host = u.hostname.toLowerCase(), flags = [];
    const shows = shownHost(text || '');
    if (shows && siteOf(shows) !== siteOf(host)) flags.push(`The text shows ${shows}, but the link goes to ${host}`);
    if (/^[\d.]+$/.test(host) || host.startsWith('[')) flags.push('Goes to a bare IP address, not a named site');
    if (host.split('.').some((l) => l.startsWith('xn--'))) flags.push('The address uses look-alike (punycode) letters');
    if (u.username) flags.push(`Hides the real site behind "${u.username}@"`);
    found.set(u.href, { url: u.href, host, text: (text || '').slice(0, 120), flags });
  };
  const re = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  for (let x; (x = re.exec(m.body_html || ''));) add(decode(x[1] ?? x[2] ?? x[3] ?? ''), decode(x[4]));
  if (!m.body_html) for (const u of String(m.body_text || '').match(/https?:\/\/[^\s<>"]+/g) || []) add(u, u);
  return [...found.values()];
}

const asking = new Map();

/** The links with a verdict each: { links: [{ url, host, text, flags, suspicious, reason }], ai: 'done'|'off'|'failed' }. */
export async function checkLinks(userId, m) {
  const links = linksOf(m);
  const ruled = (ai) => ({ links: links.map((l) => ({ ...l, suspicious: l.flags.length > 0, reason: l.flags[0] || null })), ai });
  if (!links.length) return ruled('done');
  const saved = get('SELECT links_json FROM link_checks WHERE message_id = ?', m.id);
  if (saved) return merge(links, json(saved.links_json, []));
  if (!getSettings(userId).ai.enabled) return ruled('off');
  // Nothing to ask: own mail, or every link stays on the sender's own site and no rule speaks against it.
  const from = String(m.from_addr || '').toLowerCase();
  const site = siteOf(from.split('@')[1]);
  if (ownAddresses(userId).has(from) || links.every((l) => !l.flags.length && siteOf(l.host) === site)) return ruled('done');
  if (!asking.has(m.id)) asking.set(m.id, ask(userId, m, links).finally(() => asking.delete(m.id)));
  try { return merge(links, await asking.get(m.id)); } catch (e) {
    log.warn(`link check ${m.id}: ${e.message}`);
    return ruled('failed');
  }
}

function merge(links, verdicts) {
  const by = new Map(verdicts.map((v) => [v.url, v]));
  return { links: links.map((l) => { const v = by.get(l.url); return { ...l, suspicious: v ? !!v.suspicious : l.flags.length > 0, reason: v?.reason || l.flags[0] || null }; }), ai: 'done' };
}

async function ask(userId, m, links) {
  const list = links.map((l, i) => `[${i}] text: "${l.text.replace(/\s+/g, ' ')}" -> ${l.url}${l.flags.length ? `  (note: ${l.flags.join('; ')})` : ''}`).join('\n');
  const { data, model } = await chatJSON(userId, 'background', {
    system: `You check the links in an email for phishing. A link is suspicious when it likely does not lead where the email or the link text claims: a look-alike or misspelled domain, a well-known brand (bank, delivery, Microsoft, Google, a university, the user's own organisation…) asking to log in, pay or confirm on a domain that is not theirs, a bare IP address, a hidden destination in a request for credentials or payment. Ordinary links of newsletters and their click-tracking services, unsubscribe links, and links to the sender's own site are not suspicious.
Return JSON {"links": [{"i": <number>, "reason": "<why, at most 15 words, in the language of the email>"}]} listing only the suspicious links (an empty list when none). Output JSON only.`,
    messages: [{ role: 'user', content: `From: ${m.from_name || ''} <${m.from_addr || ''}>\nSubject: ${m.subject || ''}\n\n${String(m.body_text || '').replace(/\s+/g, ' ').slice(0, 1500)}\n\nLinks:\n${list}` }],
    temperature: 0, maxTokens: 600, interactive: true,
  });
  const bad = new Map((Array.isArray(data?.links) ? data.links : []).filter((x) => links[Number(x?.i)]).map((x) => [links[Number(x.i)].url, String(x.reason || 'The AI considers this link suspicious').slice(0, 200)]));
  // Kept for every link: the AI's word overrides the rules (a tracking link whose text shows the brand's site is fine).
  const verdicts = links.map((l) => ({ url: l.url, suspicious: bad.has(l.url), reason: bad.get(l.url) || null }));
  run('INSERT OR REPLACE INTO link_checks (message_id, links_json, model, created_at) VALUES (?, ?, ?, ?)', m.id, JSON.stringify(verdicts), model, now());
  return verdicts;
}
