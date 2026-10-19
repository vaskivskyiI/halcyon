// Minimal but robust vCard 3.0/4.0 parser and serializer.
const unescape = (s) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
const escape = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');

function splitUnescaped(s, sep) {
  const out = []; let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) { cur += s[i] + s[i + 1]; i++; continue; }
    if (s[i] === sep) { out.push(cur); cur = ''; continue; }
    cur += s[i];
  }
  out.push(cur);
  return out;
}

function parseLine(line) {
  const colon = (() => { let q = false; for (let i = 0; i < line.length; i++) { if (line[i] === '"') q = !q; if (line[i] === ':' && !q) return i; } return -1; })();
  if (colon < 0) return null;
  const head = line.slice(0, colon), value = line.slice(colon + 1);
  const parts = head.split(';');
  const name = parts[0].replace(/^.*\./, '').toUpperCase();
  const params = {};
  for (const p of parts.slice(1)) {
    const [k, v] = p.split('=');
    const key = (v === undefined ? 'TYPE' : k).toUpperCase();
    const val = (v === undefined ? k : v).replace(/"/g, '');
    params[key] = [...(params[key] || []), ...val.toLowerCase().split(',')];
  }
  return { name, params, value };
}

const typeOf = (params) => (params.TYPE || []).find((t) => !['internet', 'pref', 'voice', 'x400'].includes(t)) || 'other';

export function parseVCards(text) {
  const unfolded = String(text).replace(/\r?\n[ \t]/g, '');
  const cards = [];
  let cur = null;
  for (const line of unfolded.split(/\r?\n/)) {
    if (/^BEGIN:VCARD/i.test(line)) { cur = { emails: [], phones: [], addresses: [], groups: [] }; continue; }
    if (/^END:VCARD/i.test(line)) { if (cur) { if (!cur.displayName) cur.displayName = [cur.firstName, cur.lastName].filter(Boolean).join(' ') || cur.emails[0]?.value || cur.org || 'Unnamed'; cards.push(cur); } cur = null; continue; }
    if (!cur) continue;
    const p = parseLine(line);
    if (!p) continue;
    const v = p.value;
    switch (p.name) {
      case 'UID': cur.uid = v.replace(/^urn:uuid:/, ''); break;
      case 'FN': cur.displayName = unescape(v); break;
      case 'N': { const [last, first] = splitUnescaped(v, ';').map(unescape); cur.lastName = last; cur.firstName = first; break; }
      case 'NICKNAME': cur.nickname = unescape(v); break;
      case 'EMAIL': cur.emails.push({ type: typeOf(p.params), value: unescape(v).trim() }); break;
      case 'TEL': cur.phones.push({ type: typeOf(p.params), value: unescape(v.replace(/^tel:/, '')).trim() }); break;
      case 'ADR': {
        const [, , street, city, region, postal, country] = splitUnescaped(v, ';').map(unescape);
        cur.addresses.push({ type: typeOf(p.params), street, city, region, postal, country });
        break;
      }
      case 'ORG': cur.org = splitUnescaped(v, ';').map(unescape).filter(Boolean).join(', '); break;
      case 'TITLE': cur.title = unescape(v); break;
      case 'BDAY': cur.birthday = v.replace(/^--/, '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'); break;
      case 'NOTE': cur.notes = unescape(v); break;
      case 'URL': cur.website = unescape(v); break;
      case 'CATEGORIES': cur.groups = splitUnescaped(v, ',').map(unescape).filter(Boolean); break;
      case 'PHOTO': {
        if (/^data:|^https?:/.test(v)) cur.photo = v;
        else if ((p.params.ENCODING || []).includes('b') || (p.params.ENCODING || []).includes('base64')) cur.photo = `data:image/${(p.params.TYPE || ['jpeg'])[0]};base64,${v}`;
        break;
      }
      default: break;
    }
  }
  return cards;
}

const fold = (line) => {
  const out = [];
  let s = line;
  while (s.length > 75) { out.push(s.slice(0, 75)); s = ' ' + s.slice(75); }
  out.push(s);
  return out.join('\r\n');
};

export function toVCard(c) {
  const L = ['BEGIN:VCARD', 'VERSION:3.0', `UID:${c.uid}`, `FN:${escape(c.displayName)}`, `N:${escape(c.lastName)};${escape(c.firstName)};;;`];
  if (c.nickname) L.push(`NICKNAME:${escape(c.nickname)}`);
  for (const e of c.emails || []) L.push(`EMAIL;TYPE=INTERNET,${(e.type || 'other').toUpperCase()}:${e.value}`);
  for (const p of c.phones || []) L.push(`TEL;TYPE=${(p.type || 'other').toUpperCase()}:${p.value}`);
  for (const a of c.addresses || []) L.push(`ADR;TYPE=${(a.type || 'other').toUpperCase()}:;;${[a.street, a.city, a.region, a.postal, a.country].map(escape).join(';')}`);
  if (c.org) L.push(`ORG:${escape(c.org)}`);
  if (c.title) L.push(`TITLE:${escape(c.title)}`);
  if (c.birthday) L.push(`BDAY:${c.birthday}`);
  if (c.website) L.push(`URL:${c.website}`);
  if (c.notes) L.push(`NOTE:${escape(c.notes)}`);
  if (c.groups?.length) L.push(`CATEGORIES:${c.groups.map(escape).join(',')}`);
  if (c.photo?.startsWith('data:')) {
    const m = c.photo.match(/^data:image\/(\w+);base64,(.*)$/);
    if (m) L.push(`PHOTO;ENCODING=b;TYPE=${m[1].toUpperCase()}:${m[2]}`);
  }
  L.push(`REV:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}`, 'END:VCARD');
  return L.map(fold).join('\r\n') + '\r\n';
}
