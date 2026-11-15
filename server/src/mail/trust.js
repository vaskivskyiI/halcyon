// Is the email what it claims to be? Plain checks run before the AI reads it, so a fake invoice is caught however
// convincing its text: the receiving server's verdict on the sender's address (SPF / DKIM / DMARC in
// Authentication-Results), a well-known brand in the sender's name or subject sent from a domain that is not the
// brand's, a look-alike of a brand's or a correspondent's domain, replies that go elsewhere, links that do not go where
// they say, and a first email ever from a domain asking for money or a login. Each finding has a weight; the sum is the
// score (0-100). The AI is given the findings as evidence; a high score marks the email as phishing whatever the AI
// says, and mail from people the user writes to counts against it (their address is rarely forged when DMARC passes).
import { get } from '../db/index.js';
import { readRaw } from './store.js';
import { linksOf, siteOf } from './links.js';

export const PHISHING_SCORE = 60;
export const SUSPICIOUS_SCORE = 30;

// Brands that are imitated most, with the sites they really send from (subdomains count: mail.openai.com).
const BRANDS = [
  [/\b(chat ?gpt|openai)\b/i, 'OpenAI / ChatGPT', ['openai.com', 'chatgpt.com']],
  [/\bpaypal\b/i, 'PayPal', ['paypal.com', 'paypal.me', 'paypal-communication.com']],
  [/\b(microsoft|office ?365|outlook|onedrive|sharepoint)\b/i, 'Microsoft', ['microsoft.com', 'office.com', 'office365.com', 'outlook.com', 'live.com', 'microsoftonline.com', 'sharepoint.com', 'onmicrosoft.com', 'microsoft365.com']],
  [/\b(apple|icloud|itunes|app store)\b/i, 'Apple', ['apple.com', 'icloud.com', 'me.com']],
  [/\bamazon\b/i, 'Amazon', ['amazon.com', 'amazon.de', 'amazon.co.uk', 'amazon.fr', 'amazon.it', 'amazon.es', 'amazonaws.com', 'amazonses.com', 'aws.com']],
  [/\b(google|gmail|google workspace)\b/i, 'Google', ['google.com', 'gmail.com', 'youtube.com', 'googlemail.com']],
  [/\bnetflix\b/i, 'Netflix', ['netflix.com']],
  [/\bdhl\b/i, 'DHL', ['dhl.com', 'dhl.de', 'dhl.si', 'dpdhl.com']],
  [/\bfedex\b/i, 'FedEx', ['fedex.com']],
  [/\bups\b/, 'UPS', ['ups.com']],
  [/\bdocusign\b/i, 'DocuSign', ['docusign.com', 'docusign.net']],
  [/\bdropbox\b/i, 'Dropbox', ['dropbox.com', 'dropboxmail.com']],
  [/\blinkedin\b/i, 'LinkedIn', ['linkedin.com']],
  [/\b(facebook|instagram|whatsapp)\b/i, 'Meta', ['facebook.com', 'facebookmail.com', 'meta.com', 'instagram.com', 'whatsapp.com']],
  [/\bspotify\b/i, 'Spotify', ['spotify.com']],
  [/\badobe\b/i, 'Adobe', ['adobe.com']],
  [/\bstripe\b/i, 'Stripe', ['stripe.com']],
  [/\b(coinbase|binance|metamask)\b/i, 'a crypto exchange', ['coinbase.com', 'binance.com', 'metamask.io']],
  [/\b(anthropic|claude\.ai)\b/i, 'Anthropic', ['anthropic.com', 'claude.ai', 'claude.com']],
  [/\b(github)\b/i, 'GitHub', ['github.com']],
];
const PUBLIC = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com', 'gmx.net', 'gmx.de', 'web.de', 'proton.me', 'protonmail.com', 'aol.com', 'mail.com', 'yandex.ru', 'mail.ru']);
// Money, accounts and logins: what phishing asks for (English and Slovenian).
const BAIT = /\b(invoice|receipt|payment|billing|subscription|renew|refund|overdue|unpaid|declined|failed|suspend\w*|locked|verify|confirm your|password|sign[- ]?in|log[- ]?in|account|wallet|bank|card|urgent|expire\w*|račun\w*|plačil\w*|naročnin\w*|geslo|gesl\w*|prijav\w*|kartic\w*|zapadl\w*)\b/i;

const lower = (s) => String(s || '').toLowerCase();
const domainOf = (a) => lower(a).split('@')[1] || '';
const brandSite = (site, sites) => sites.some((s) => site === s || site.endsWith(`.${s}`));

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

/** SPF / DKIM / DMARC as the receiving server saw them (the first, topmost Authentication-Results), or null. */
export function authResults(raw) {
  if (!raw) return null;
  const head = raw.subarray(0, 65536).toString('latin1').split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');
  const ar = head.match(/^Authentication-Results:[ \t]*(.*)$/mi)?.[1] || '';
  const spfHeader = head.match(/^Received-SPF:[ \t]*(\w+)/mi)?.[1] || '';
  const pick = (k) => ar.match(new RegExp(`\\b${k}=(\\w+)`, 'i'))?.[1]?.toLowerCase() || null;
  const out = { spf: pick('spf') || lower(spfHeader) || null, dkim: pick('dkim'), dmarc: pick('dmarc'), dkimDomain: lower(ar.match(/header\.d=([\w.-]+)/i)?.[1]) || null };
  return out.spf || out.dkim || out.dmarc ? out : null;
}

/** How well the user knows the sender: mail from the address / domain, mail the user sent them, a contact. */
function acquaintance(userId, m, from, domain) {
  const r = get(`SELECT
      (SELECT COUNT(*) FROM messages x WHERE x.user_id = ? AND lower(x.from_addr) = ? AND x.id != ?) AS fromAddr,
      (SELECT COUNT(*) FROM messages x WHERE x.user_id = ? AND lower(x.from_addr) LIKE ? AND x.id != ?) AS fromDomain,
      (SELECT COUNT(*) FROM messages x JOIN folders f ON f.id = x.folder_id WHERE x.user_id = ? AND f.special_use = '\\Sent' AND (lower(x.to_json) LIKE ? OR lower(x.cc_json) LIKE ?)) AS sentTo,
      (SELECT COUNT(*) FROM contact_emails c WHERE c.user_id = ? AND c.email = ?) AS contact`,
  userId, from, m.id, userId, `%@${domain}`, m.id, userId, `%"${from}"%`, `%"${from}"%`, userId, from);
  return r || { fromAddr: 0, fromDomain: 0, sentTo: 0, contact: 0 };
}

/** Sites of the people the user writes to (for look-alikes of a correspondent's domain). */
function correspondentSites(userId) {
  const rows = get(`SELECT group_concat(DISTINCT lower(substr(c.email, instr(c.email, '@') + 1))) AS d FROM contact_emails c WHERE c.user_id = ?`, userId);
  return new Set(String(rows?.d || '').split(',').filter(Boolean).map(siteOf).filter((s) => !PUBLIC.has(s)));
}

/**
 * { score, level: 'high'|'medium'|'low', reasons: [string], auth, known } for an email (a messages row).
 * own: the user's addresses (mail from the user is not checked).
 */
export function trustSignals(userId, m, { own = new Set(), raw } = {}) {
  const from = lower(m.from_addr), domain = domainOf(from), site = siteOf(domain);
  if (!from || own.has(from)) return { score: 0, level: 'low', reasons: [], auth: null, known: true };
  const reasons = [];
  let score = 0;
  const add = (w, why) => { score += w; reasons.push(why); };

  const auth = authResults(raw === undefined ? readRaw(m) : raw);
  if (auth?.dmarc === 'fail') add(45, `The sender's domain ${domain} failed the DMARC check: the From address is probably forged`);
  else if (auth && ['fail', 'softfail'].includes(auth.spf) && auth.dkim !== 'pass') add(25, `The mail server was not allowed to send for ${domain} (SPF ${auth.spf}) and the email is not signed by it`);
  else if (auth && auth.dkim !== 'pass' && auth.spf !== 'pass' && auth.dmarc !== 'pass') add(10, `The email is not authenticated for ${domain} (no SPF/DKIM pass)`);

  const name = String(m.from_name || ''), subject = String(m.subject || '');
  const head = `${subject}\n${String(m.body_text || '').slice(0, 1500)}`;
  const bait = BAIT.test(head);
  for (const [re, brand, sites] of BRANDS) {
    if (brandSite(site, sites)) continue;
    if (re.test(name) || re.test(from.split('@')[0]) || re.test(domain.replace(/[-.]/g, ' '))) {
      add(PUBLIC.has(site) ? 50 : 40, `Presents itself as ${brand}, but is sent from ${domain}, which is not ${brand}'s`);
      break;
    }
    if (re.test(subject) && bait && !m.list_unsubscribe) { add(15, `Mentions ${brand} about money or an account, but is sent from ${domain}`); break; }
  }

  // Look-alike domains: paypa1.com, rnicrosoft.com, or a correspondent's domain with a letter changed.
  if (domain.split('.').some((l) => l.startsWith('xn--'))) add(30, `The sender's domain ${domain} uses look-alike (punycode) letters`);
  const known = correspondentSites(userId);
  const brandSites = BRANDS.flatMap((b) => b[2]);
  const twin = [...brandSites, ...known].find((s) => s !== site && site.length >= 6 && distance(site.split('.')[0], s.split('.')[0]) <= 1 && site.split('.')[0] !== s.split('.')[0]);
  if (twin) add(40, `The sender's domain ${site} looks like ${twin} but is not it`);

  const replyTo = (() => { try { return JSON.parse(m.reply_to_json || '[]'); } catch { return []; } })().map((a) => domainOf(a.address)).filter(Boolean);
  if (replyTo.length && !m.list_unsubscribe && replyTo.every((d) => siteOf(d) !== site)) add(PUBLIC.has(siteOf(replyTo[0])) ? 20 : 12, `Replies go to ${replyTo[0]}, not to the sender's domain`);

  const links = linksOf(m);
  const flagged = links.filter((l) => l.flags.length);
  if (flagged.length) add(Math.min(30, 15 * flagged.length), flagged[0].flags[0]);

  const k = acquaintance(userId, m, from, domain);
  const firstEver = !k.fromAddr && !k.contact && !k.sentTo && (PUBLIC.has(site) || !k.fromDomain);
  if (firstEver && bait && score > 0) add(15, `First email ever from ${PUBLIC.has(site) ? from : domain}, and it is about money or an account`);
  else if (firstEver && bait) add(5, `First email ever from ${PUBLIC.has(site) ? from : domain}`);
  // People the user writes to: their real address (DMARC not failing) is not phishing because of a weak sign.
  const trusted = (k.sentTo > 0 || k.contact > 0) && auth?.dmarc !== 'fail';
  if (trusted) score -= 30;
  score = Math.max(0, Math.min(100, score));
  return { score, level: score >= PHISHING_SCORE ? 'high' : score >= SUSPICIOUS_SCORE ? 'medium' : 'low', reasons, auth, known: trusted,
    firstEver, sentTo: k.sentTo, fromAddr: k.fromAddr };
}

/** For the analysis prompt: the findings as evidence, or ''. */
export function trustText(t) {
  if (!t) return '';
  const auth = t.auth ? `Sender authentication (receiving server): SPF ${t.auth.spf || 'none'}, DKIM ${t.auth.dkim || 'none'}, DMARC ${t.auth.dmarc || 'none'}.` : '';
  if (!t.reasons.length) return auth;
  return `${auth}\nSECURITY CHECKS (computed, reliable) — risk ${t.score}/100:\n${t.reasons.map((r) => `- ${r}`).join('\n')}`;
}
