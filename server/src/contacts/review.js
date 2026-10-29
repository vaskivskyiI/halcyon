// Contacts tidied up with the user's say: suggestions to merge duplicates (the same address in two contacts, the same
// name, and — with AI — the same person written differently) and to save people the user writes with as contacts
// (with their organisation from the AI's profile of them). Nothing changes until the user accepts a suggestion; a
// rejected one is not suggested again (contact_suggestions, migration 41).
import { get, all, run, json, now, tx, fold } from '../db/index.js';
import { createContact, updateContact, deleteContact } from './repo.js';
import { serializeContact } from './service.js';
import { getSettings } from '../settings.js';
import { chatJSON } from '../ai/router.js';
import { ownAddresses } from '../ai/open-items.js';
import { logger } from '../util/log.js';

const log = logger('contacts');
const PUBLIC_MAIL = /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|gmx|web|siol|t-2|amis|proton|protonmail|aol|mail|yandex)\./i;

/** Merges contacts into the first (emails, phones, addresses, groups joined; empty fields filled); the rest go. */
export function mergeContacts(userId, keepId, otherIds) {
  const keep = get('SELECT * FROM contacts WHERE id = ? AND user_id = ? AND deleted = 0', keepId, userId);
  if (!keep) return null;
  const k = serializeContact(keep);
  const uniq = (arr) => [...new Map(arr.map((v) => [String(v.value || JSON.stringify(v)).toLowerCase(), v])).values()];
  for (const id of otherIds) {
    const o = get('SELECT * FROM contacts WHERE id = ? AND user_id = ? AND deleted = 0', id, userId);
    if (!o || o.id === keep.id) continue;
    const x = serializeContact(o);
    k.emails = uniq([...k.emails, ...x.emails]); k.phones = uniq([...k.phones, ...x.phones]); k.addresses = [...k.addresses, ...x.addresses];
    k.groups = [...new Set([...k.groups, ...x.groups])];
    for (const f of ['org', 'title', 'birthday', 'notes', 'photo', 'website', 'nickname']) k[f] ||= x[f];
    if (x.favorite) k.favorite = true;
    deleteContact(userId, id);
  }
  return updateContact(userId, keep.id, k);
}

// Names in Cyrillic are written in Latin letters, and both are reduced to how they sound, so "Ігор Васківський",
// "Igor Vaskivskij" and "Ihor Vaskivskyi" (or "Шуштар" and "Šuštar") give the same key: č/ч, š/ш, ž/ж fold alike,
// г/h/g are one, й/и/y/j/i are one, doubled letters count once.
const CYR = { а: 'a', б: 'b', в: 'v', г: 'g', ґ: 'g', д: 'd', е: 'e', є: 'e', ё: 'e', ж: 'z', з: 'z', и: 'i', і: 'i', ї: 'i', й: 'i', к: 'k', л: 'l',
  м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'c', ш: 's', щ: 's', ъ: '', ы: 'i', ь: '', э: 'e',
  ю: 'iu', я: 'ia', ђ: 'd', ј: 'i', љ: 'l', њ: 'n', ћ: 'c', џ: 'd', ѓ: 'g', ќ: 'k', ѕ: 'dz' };
export const sounds = (s) => fold(s || '').replace(/[\u0400-\u04ff]/g, (c) => CYR[c] ?? '')
  .replace(/shch|sch/g, 's').replace(/kh/g, 'h').replace(/zh/g, 'z').replace(/ch|tz|ts/g, 'c').replace(/sh/g, 's').replace(/dj|dzh/g, 'd')
  .replace(/h/g, 'g').replace(/w/g, 'v').replace(/[yj]/g, 'i').replace(/([a-z])\1+/g, '$1');
const nameKey = (n) => sounds(n).replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
const scriptOf = (n) => (/[\u0400-\u04ff]/.test(n || '') ? 'cyr' : 'lat');
const contactsOf = (userId) => all('SELECT * FROM contacts WHERE user_id = ? AND deleted = 0', userId).map((c) => ({ ...c, emails: json(c.emails_json, []).map((e) => String(e.value || '').toLowerCase()).filter(Boolean) }));
/** The contact the others merge into: a saved one before collected ones, then the fullest, then the oldest. */
const best = (list) => [...list].sort((a, b) => (a.auto_collected - b.auto_collected) || (b.favorite - a.favorite)
  || (['org', 'phones_json', 'notes', 'title'].filter((f) => b[f] && b[f] !== '[]').length - ['org', 'phones_json', 'notes', 'title'].filter((f) => a[f] && a[f] !== '[]').length) || a.id - b.id)[0];

function suggest(userId, kind, key, payload, reason) {
  run(`INSERT INTO contact_suggestions (user_id, kind, key, payload_json, reason, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)
    ON CONFLICT(user_id, key) DO UPDATE SET payload_json = excluded.payload_json, reason = excluded.reason WHERE contact_suggestions.status = 'open'`,
  userId, kind, key, JSON.stringify(payload), reason, now());
}

/** Looks for duplicates and people worth saving; with AI, also name variants. Returns the open suggestions. */
export async function scanContacts(userId) {
  const contacts = contactsOf(userId);
  const byId = new Map(contacts.map((c) => [c.id, c]));
  const groups = [];
  // The same address in several contacts.
  const byEmail = new Map();
  for (const c of contacts) for (const e of c.emails) { if (!byEmail.has(e)) byEmail.set(e, []); byEmail.get(e).push(c.id); }
  for (const [e, ids] of byEmail) if (new Set(ids).size > 1) groups.push({ ids: [...new Set(ids)], reason: `Both have ${e}` });
  // The same full name (accents, order and case aside).
  const byName = new Map();
  for (const c of contacts) { const k = nameKey(c.display_name); if (k.split(' ').length >= 2 && k.length >= 5) { if (!byName.has(k)) byName.set(k, []); byName.get(k).push(c.id); } }
  for (const ids of byName.values()) {
    if (ids.length < 2) continue;
    const mixed = new Set(ids.map((id) => scriptOf(byId.get(id).display_name))).size > 1;
    groups.push({ ids, reason: mixed ? 'Same name in Latin and Cyrillic' : 'Same name' });
  }
  // Overlapping groups become one.
  const merged = [];
  for (const g of groups) {
    const hit = merged.find((m) => g.ids.some((id) => m.ids.includes(id)));
    if (hit) { hit.ids = [...new Set([...hit.ids, ...g.ids])]; if (!hit.reason.includes(g.reason)) hit.reason += ` · ${g.reason}`; } else merged.push({ ...g });
  }
  if (getSettings(userId).ai.enabled) merged.push(...await nameVariants(userId, contacts, merged).catch((e) => { log.warn(`contact variants: ${e.message}`); return []; }));
  tx(() => {
    for (const g of merged) {
      const list = g.ids.map((id) => byId.get(id)).filter(Boolean);
      if (list.length < 2) continue;
      suggest(userId, 'merge', `merge:${[...g.ids].sort((a, b) => a - b).join(',')}`, { keepId: best(list).id, ids: list.map((c) => c.id) }, g.reason);
    }
    // People the user writes with, not saved as contacts: collected ones written to several times, and frequent
    // correspondents with an AI profile.
    const own = ownAddresses(userId);
    for (const c of contacts.filter((x) => x.auto_collected && x.contact_count >= 3)) {
      const p = get('SELECT name, profile_json FROM contact_profiles WHERE user_id = ? AND email = ?', userId, c.emails[0]);
      const prof = json(p?.profile_json, {});
      suggest(userId, 'add', `add:${c.emails[0]}`, { contactId: c.id, name: c.display_name, email: c.emails[0], org: prof?.organisation || null },
        `You wrote to them ${c.contact_count} times${prof?.who ? ` — ${prof.who}` : ''}`);
    }
    for (const p of all(`SELECT email, name, msg_count, profile_json FROM contact_profiles WHERE user_id = ? AND msg_count >= 5 AND profile_json IS NOT NULL
        AND email NOT IN (SELECT email FROM contact_emails WHERE user_id = ?) ORDER BY msg_count DESC LIMIT 50`, userId, userId)) {
      if (own.has(p.email)) continue;
      const prof = json(p.profile_json, {});
      if (/newsletter|automated|notification|no-?reply|marketing/i.test(`${prof.relationship || ''} ${prof.who || ''}`)) continue;
      suggest(userId, 'add', `add:${p.email}`, { contactId: null, name: p.name || p.email.split('@')[0], email: p.email, org: prof.organisation || null },
        `${p.msg_count} emails together${prof.who ? ` — ${prof.who}` : ''}`);
    }
    // Suggestions that no longer apply (a contact gone, already saved) are dropped.
    for (const s of all("SELECT id, kind, payload_json FROM contact_suggestions WHERE user_id = ? AND status = 'open'", userId)) {
      const p = json(s.payload_json, {});
      const stale = s.kind === 'merge' ? p.ids.filter((id) => byId.has(id)).length < 2
        : p.contactId ? !byId.get(p.contactId)?.auto_collected : !!get('SELECT 1 AS x FROM contact_emails WHERE user_id = ? AND email = ?', userId, p.email);
      if (stale) run('DELETE FROM contact_suggestions WHERE id = ?', s.id);
    }
  });
  run("INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)", `contacts_scan:${userId}`, String(now()));
  return openSuggestions(userId);
}

/** AI: pairs that may be one person written differently ("Igor V." / "Igor Vaskivskyi" at the same company). */
async function nameVariants(userId, contacts, known) {
  const done = new Set(known.flatMap((g) => g.ids));
  const decided = new Set(all('SELECT key FROM contact_suggestions WHERE user_id = ?', userId).map((r) => r.key));
  const first = (c) => nameKey(c.first_name || String(c.display_name || '').split(/\s+/)[0]).split(' ')[0] || '';
  const domain = (c) => (c.emails[0] || '').split('@')[1] || '';
  const phones = (c) => json(c.phones_json, []).map((p) => p.value).filter(Boolean).join(', ');
  const pairs = [];
  const list = contacts.filter((c) => !done.has(c.id) && (c.emails.length || c.phones_json !== '[]'));
  const words = (c) => nameKey(c.display_name).split(' ').filter((w) => w.length >= 4);
  for (let i = 0; i < list.length && pairs.length < 25; i++) {
    for (let j = i + 1; j < list.length && pairs.length < 25; j++) {
      const a = list[i], b = list[j];
      const sameDomain = domain(a) && domain(a) === domain(b) && !PUBLIC_MAIL.test(domain(a));
      const sameLocal = a.emails[0] && a.emails[0].split('@')[0] === b.emails[0]?.split('@')[0];
      // One in Cyrillic, one in Latin letters with a surname in common: maybe one person (a nickname, another spelling).
      const acrossScripts = scriptOf(a.display_name) !== scriptOf(b.display_name) && words(a).some((w) => words(b).includes(w));
      if (!((first(a) && first(a) === first(b) && (sameDomain || sameLocal)) || acrossScripts) || nameKey(a.display_name) === nameKey(b.display_name)) continue;
      if (decided.has(`merge:${[a.id, b.id].sort((x, y) => x - y).join(',')}`)) continue;
      pairs.push([a, b]);
    }
  }
  if (!pairs.length) return [];
  const { data } = await chatJSON(userId, 'background', {
    messages: [
      { role: 'system', content: 'You tidy an address book. For each numbered pair of contacts, decide whether both are very likely the SAME person (a nickname, initials, a second address of the same person, the name written in Cyrillic in one and in Latin letters in the other — e.g. "Олена Коваль" and "Olena Koval"). Different people who share a first name and a company are NOT the same. Answer JSON: {"same": [{"pair": number, "reason": short reason}]} listing only the pairs that are the same person.' },
      { role: 'user', content: pairs.map(([a, b], i) => `${i + 1}. ${[a, b].map((c) => `"${c.display_name}" <${[c.emails.join(', '), phones(c)].filter(Boolean).join('; ')}>${c.org ? ` (${c.org})` : ''}`).join('  —  ')}`).join('\n') },
    ],
    temperature: 0, maxTokens: 600,
  });
  return (Array.isArray(data?.same) ? data.same : []).map((x) => pairs[Number(x.pair) - 1] && { ids: pairs[Number(x.pair) - 1].map((c) => c.id), reason: `AI: ${String(x.reason || 'probably the same person').slice(0, 160)}` }).filter(Boolean);
}

export function openSuggestions(userId) {
  return all("SELECT * FROM contact_suggestions WHERE user_id = ? AND status = 'open' ORDER BY kind DESC, id", userId).map((s) => {
    const p = json(s.payload_json, {});
    const contacts = s.kind === 'merge' ? p.ids.map((id) => get('SELECT * FROM contacts WHERE id = ? AND deleted = 0', id)).filter(Boolean).map(serializeContact) : [];
    return { id: s.id, kind: s.kind, reason: s.reason, ...p, contacts };
  }).filter((s) => s.kind !== 'merge' || s.contacts.length > 1);
}

/** accept: merge (into keepId, which the user may change) or save; reject: never suggested again. */
export function decide(userId, id, accept, { keepId } = {}) {
  const s = get('SELECT * FROM contact_suggestions WHERE id = ? AND user_id = ?', id, userId);
  if (!s || s.status !== 'open') return null;
  let contact = null;
  if (accept) {
    const p = json(s.payload_json, {});
    if (s.kind === 'merge') {
      const keep = keepId && p.ids.includes(Number(keepId)) ? Number(keepId) : p.keepId;
      contact = mergeContacts(userId, keep, p.ids.filter((x) => x !== keep));
    } else if (p.contactId) {
      const c = get('SELECT * FROM contacts WHERE id = ? AND user_id = ?', p.contactId, userId);
      contact = c && updateContact(userId, c.id, { org: c.org || p.org || undefined });
    } else {
      const [firstName, ...rest] = String(p.name || '').split(' ');
      contact = createContact(userId, { displayName: p.name, firstName, lastName: rest.join(' '), org: p.org || undefined, emails: [{ type: 'work', value: p.email }] });
    }
  }
  run('UPDATE contact_suggestions SET status = ?, decided_at = ? WHERE id = ?', accept ? 'accepted' : 'rejected', now(), s.id);
  return { ok: true, contact: contact && serializeContact(contact) };
}

/** Daily: new suggestions in the background (the Contacts page shows how many wait). */
export async function scanAll() {
  for (const u of all("SELECT id FROM users WHERE COALESCE(kind, 'person') = 'person'")) {
    const last = Number(get('SELECT value FROM app_state WHERE key = ?', `contacts_scan:${u.id}`)?.value || 0);
    if (Date.now() - last < 20 * 3600e3) continue;
    await scanContacts(u.id).catch((e) => log.warn(`contact scan ${u.id}: ${e.message}`));
  }
}
