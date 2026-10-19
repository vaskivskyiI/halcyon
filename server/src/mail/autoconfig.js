// Server settings discovery: built-in presets, then Mozilla ISPDB / domain autoconfig, then MX-based guess.
import dns from 'node:dns/promises';

const PRESETS = {
  'gmail.com': { imap: ['imap.gmail.com', 993, true], smtp: ['smtp.gmail.com', 465, true], oauth: 'google', note: 'Use an App Password or sign in with Google.' },
  'googlemail.com': 'gmail.com',
  'outlook.com': { imap: ['outlook.office365.com', 993, true], smtp: ['smtp-mail.outlook.com', 587, false], oauth: 'microsoft', note: 'Microsoft requires OAuth sign-in for IMAP.' },
  'hotmail.com': 'outlook.com', 'live.com': 'outlook.com', 'msn.com': 'outlook.com',
  'office365.com': { imap: ['outlook.office365.com', 993, true], smtp: ['smtp.office365.com', 587, false], oauth: 'microsoft' },
  'yahoo.com': { imap: ['imap.mail.yahoo.com', 993, true], smtp: ['smtp.mail.yahoo.com', 465, true], note: 'Use an App Password.' },
  'icloud.com': { imap: ['imap.mail.me.com', 993, true], smtp: ['smtp.mail.me.com', 587, false], note: 'Use an app-specific password.', caldav: 'https://caldav.icloud.com', carddav: 'https://contacts.icloud.com' },
  'me.com': 'icloud.com', 'mac.com': 'icloud.com',
  'fastmail.com': { imap: ['imap.fastmail.com', 993, true], smtp: ['smtp.fastmail.com', 465, true], caldav: 'https://caldav.fastmail.com/dav/', carddav: 'https://carddav.fastmail.com/dav/' },
  'gmx.com': { imap: ['imap.gmx.com', 993, true], smtp: ['mail.gmx.com', 587, false] },
  'gmx.net': { imap: ['imap.gmx.net', 993, true], smtp: ['mail.gmx.net', 587, false] },
  'web.de': { imap: ['imap.web.de', 993, true], smtp: ['smtp.web.de', 587, false] },
  'zoho.com': { imap: ['imap.zoho.com', 993, true], smtp: ['smtp.zoho.com', 465, true] },
  'aol.com': { imap: ['imap.aol.com', 993, true], smtp: ['smtp.aol.com', 465, true] },
  'mail.ru': { imap: ['imap.mail.ru', 993, true], smtp: ['smtp.mail.ru', 465, true] },
  'yandex.com': { imap: ['imap.yandex.com', 993, true], smtp: ['smtp.yandex.com', 465, true] },
  'proton.me': { imap: ['127.0.0.1', 1143, false], smtp: ['127.0.0.1', 1025, false], note: 'Requires Proton Mail Bridge running locally.' },
  'protonmail.com': 'proton.me',
};

function preset(domain) {
  let p = PRESETS[domain];
  if (typeof p === 'string') p = PRESETS[p];
  return p || null;
}

function toResult(p, source) {
  return {
    source,
    imap: { host: p.imap[0], port: p.imap[1], secure: p.imap[2] },
    smtp: { host: p.smtp[0], port: p.smtp[1], secure: p.smtp[2] },
    oauth: p.oauth || null, note: p.note || null, caldav: p.caldav || null, carddav: p.carddav || null,
  };
}

async function fetchText(url, ms = 5000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    return r.ok ? await r.text() : null;
  } catch { return null; } finally { clearTimeout(t); }
}

function parseIspdb(xml, email) {
  const [local, domain] = email.split('@');
  const pick = (type) => {
    const re = new RegExp(`<(incomingServer|outgoingServer) type="${type}">([\\s\\S]*?)</\\1>`, 'g');
    const m = re.exec(xml);
    if (!m) return null;
    const tag = (n) => (m[2].match(new RegExp(`<${n}>([^<]*)</${n}>`)) || [])[1];
    const sock = tag('socketType');
    return { host: tag('hostname')?.replace('%EMAILDOMAIN%', domain), port: Number(tag('port')), secure: sock === 'SSL', username: tag('username')?.replace('%EMAILADDRESS%', email).replace('%EMAILLOCALPART%', local) };
  };
  const imap = pick('imap');
  const smtp = pick('smtp');
  if (!imap?.host || !smtp?.host) return null;
  const oauth = /oauth2/i.test(xml) ? (/google/i.test(imap.host) ? 'google' : /office365|outlook/i.test(imap.host) ? 'microsoft' : null) : null;
  return { source: 'ispdb', imap, smtp, oauth, note: null };
}

export async function discover(email) {
  const domain = String(email).split('@')[1]?.toLowerCase();
  if (!domain) throw new Error('Invalid email address');
  const p = preset(domain);
  if (p) return toResult(p, 'preset');

  for (const url of [
    `https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`,
    `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml`,
    `https://autoconfig.thunderbird.net/v1.1/${domain}`,
  ]) {
    const xml = await fetchText(url);
    const r = xml && parseIspdb(xml, email);
    if (r) return r;
  }

  // MX lookup: hosted Google / Microsoft domains.
  try {
    const mx = (await dns.resolveMx(domain)).sort((a, b) => a.priority - b.priority).map((m) => m.exchange.toLowerCase());
    if (mx.some((h) => h.endsWith('google.com') || h.endsWith('googlemail.com'))) return toResult(PRESETS['gmail.com'], 'mx');
    if (mx.some((h) => h.endsWith('outlook.com'))) return toResult(PRESETS['office365.com'], 'mx');
  } catch { /* ignore */ }

  return toResult({ imap: [`imap.${domain}`, 993, true], smtp: [`smtp.${domain}`, 465, true], note: 'Settings guessed; please verify.' }, 'guess');
}
