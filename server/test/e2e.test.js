// End-to-end test against a real IMAP server (Dovecot) and a local SMTP relay, using the mock AI provider.
// Requires: IMAP on 127.0.0.1:1143 with users alice@test.local / bob@test.local (password secret123).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startSmtp, append, listUids, clearMailbox, rfc822, waitFor, sleep, imap } from './helpers.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_POLL_INTERVAL = '2';
process.env.HALCYON_LOG_LEVEL = process.env.HALCYON_LOG_LEVEL || 'warn';
process.env.HALCYON_DEMO = '1';

let app, base, cookie = '', smtp;

async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') && !ct.includes('ndjson') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
const ndjson = (text) => text.trim().split('\n').map((l) => JSON.parse(l));

before(async () => {
  await clearMailbox('alice@test.local');
  await clearMailbox('bob@test.local');
  smtp = await startSmtp(0);
  const { buildServer } = await import('../src/index.js');
  app = await buildServer();
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  const { syncManager } = await import('../src/mail/sync.js');
  await syncManager.stopAll();
  await app.close();
  smtp.server.close();
  setTimeout(() => process.exit(0), 200).unref();
});

const now = Date.now();
const thread1 = rfc822({ from: 'Carol <carol@test.local>', to: 'alice@test.local', subject: 'Project kickoff', body: 'Hi Alice, can we meet tomorrow at 10 to discuss the kickoff? It is urgent.', date: new Date(now - 3 * 3600e3), messageId: 'kick-1@test.local' });
const thread2 = rfc822({ from: 'Alice <alice@test.local>', to: 'carol@test.local', subject: 'Re: Project kickoff', body: 'Sure, 10 works.', date: new Date(now - 2 * 3600e3), messageId: 'kick-2@test.local', inReplyTo: 'kick-1@test.local', references: ['kick-1@test.local'] });
const thread3 = rfc822({ from: 'Carol <carol@test.local>', to: 'alice@test.local', subject: 'Re: Project kickoff', body: 'Great, I will bring the budget spreadsheet. Any questions before?', date: new Date(now - 3600e3), messageId: 'kick-3@test.local', inReplyTo: 'kick-2@test.local', references: ['kick-1@test.local', 'kick-2@test.local'] });
const newsletter = rfc822({ from: 'News <news@shop.example>', to: 'alice@test.local', subject: 'Weekly deals newsletter', html: '<h1>Deals</h1><p>Big sale <img src="https://tracker.example/pixel.gif"></p><script>alert(1)</script><a href="https://shop.example">Shop</a>', date: new Date(now - 5 * 3600e3), headers: { 'List-Unsubscribe': '<mailto:unsub@shop.example?subject=unsubscribe>' } });
const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'METHOD:REQUEST', 'PRODID:test', 'BEGIN:VEVENT', 'UID:inv-123@test.local', `DTSTAMP:20260101T000000Z`,
  `DTSTART:${new Date(now + 2 * 864e5).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}`, `DTEND:${new Date(now + 2 * 864e5 + 3600e3).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}`,
  'SUMMARY:Design review', 'LOCATION:Room 4', 'ORGANIZER;CN=Dave:mailto:dave@test.local', 'ATTENDEE;CN=Alice;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:alice@test.local', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
const invite = rfc822({ from: 'Dave <dave@test.local>', to: 'alice@test.local', subject: 'Invitation: Design review', body: 'Please join the design review.', date: new Date(now - 1800e3), ics });

let account, inboxId, messages;

test('setup, account creation and initial sync', async () => {
  const status = await api('GET', '/api/auth/status');
  assert.equal(status.needsSetup, true);
  await api('POST', '/api/auth/setup', { email: 'admin@example.com', name: 'Alice Admin', password: 'password123' });
  const me = await api('GET', '/api/me');
  assert.equal(me.user.email, 'admin@example.com');
  await api('PATCH', '/api/settings', { mail: { undoSendSeconds: 0 }, ai: { analyzeDays: 3650 } });

  for (const m of [thread1, newsletter, thread3, invite]) await append('alice@test.local', m.raw);
  await append('alice@test.local', thread2.raw, 'Sent', ['\\Seen']);

  // Mock AI provider so background AI runs offline.
  const prov = await api('POST', '/api/ai/providers', { type: 'mock', name: 'Mock' });
  assert.ok(prov.id);

  const t = await api('POST', '/api/accounts/test', { email: 'alice@test.local', imap: { host: '127.0.0.1', port: 1143, secure: false, user: 'alice@test.local', password: 'secret123' }, smtp: { host: '127.0.0.1', port: smtp.port, secure: false, user: 'alice@test.local', password: 'x' } });
  assert.equal(t.imap.ok, true, JSON.stringify(t));
  assert.equal(t.smtp.ok, true, JSON.stringify(t));

  account = await api('POST', '/api/accounts', { email: 'alice@test.local', displayName: 'Alice', imap: { host: '127.0.0.1', port: 1143, secure: false, user: 'alice@test.local', password: 'secret123' }, smtp: { host: '127.0.0.1', port: smtp.port, secure: false, user: 'alice@test.local', password: 'x' } });
  await waitFor(async () => {
    const f = await api('GET', '/api/folders');
    const inbox = f.accounts[0]?.folders.find((x) => x.specialUse === '\\Inbox');
    inboxId = inbox?.id;
    return inbox?.total === 4;
  }, { label: 'initial sync' });
  const f = await api('GET', '/api/folders');
  const specials = f.accounts[0].folders.map((x) => x.specialUse).filter(Boolean).sort();
  assert.deepEqual(specials, ['\\Archive', '\\Drafts', '\\Inbox', '\\Junk', '\\Sent', '\\Trash']);
});

test('threading and conversation list', async () => {
  const list = await api('GET', '/api/messages?view=unified');
  messages = list.items;
  const kickoff = list.items.find((m) => m.subject.includes('Project kickoff'));
  assert.equal(kickoff.threadCount, 2, 'two inbox messages in the thread');
  const thread = await api('GET', `/api/threads/${kickoff.threadId}`);
  assert.equal(thread.messages.length, 3, 'thread includes the sent reply');
  assert.deepEqual(thread.messages.map((m) => m.messageId), ['kick-1@test.local', 'kick-2@test.local', 'kick-3@test.local']);
  const flat = await api('GET', '/api/messages?view=unified&threads=0');
  assert.equal(flat.items.length, 4);
});

test('HTML sanitising blocks scripts and remote images', async () => {
  const n = messages.find((m) => m.subject.includes('newsletter'));
  const full = await api('GET', `/api/messages/${n.id}`);
  assert.ok(!full.html.includes('<script'));
  assert.ok(full.html.includes('data-remote-src="https://tracker.example/pixel.gif"'));
  assert.equal(full.blockedRemote, 1);
  const allowed = await api('GET', `/api/messages/${n.id}?images=1`);
  assert.ok(allowed.html.includes('src="https://tracker.example/pixel.gif"'));
});

test('background AI analysis, smart views, and embeddings', async () => {
  await waitFor(async () => (await api('GET', '/api/messages?view=unified&threads=0')).items.every((m) => m.ai), { label: 'AI insights' });
  const list = (await api('GET', '/api/messages?view=unified&threads=0')).items;
  const urgent = list.find((m) => m.messageId === 'kick-1@test.local');
  assert.ok(urgent.ai.priority >= 80);
  assert.equal(urgent.ai.needsReply, true);
  const full = await api('GET', `/api/messages/${urgent.id}`);
  assert.equal(full.insight.suggestedReplies.length, 3);
  // Precomputed draft reply for high-priority messages needing a reply.
  await waitFor(async () => (await api('GET', `/api/messages/${urgent.id}`)).insight.draftReply, { label: 'precomputed draft' });
  const focused = await api('GET', '/api/messages?view=unified&threads=0&filter=other');
  assert.ok(focused.items.some((m) => m.subject.includes('newsletter')), 'newsletter in Other');
  const status = await waitFor(async () => { const s = await api('GET', '/api/ai/status'); return s.index.count >= 4 && s; }, { label: 'embeddings' });
  assert.ok(status.usage.length > 0);
  // Thread summary (3 messages) generated in background.
  await waitFor(async () => (await api('GET', `/api/threads/${urgent.threadId}`)).summary, { label: 'thread summary' });
});

test('search: operators, full-text and semantic', async () => {
  let r = await api('GET', '/api/messages?q=' + encodeURIComponent('budget'));
  assert.equal(r.items[0].messageId, 'kick-3@test.local');
  r = await api('GET', '/api/messages?q=' + encodeURIComponent('from:news@shop.example'));
  assert.equal(r.items.length, 1);
  r = await api('GET', '/api/messages?q=' + encodeURIComponent('is:unread in:inbox kickoff'));
  assert.ok(r.items.length >= 2);
  r = await api('GET', '/api/messages?q=' + encodeURIComponent('category:newsletter'));
  assert.equal(r.items.length, 1);
});

test('flags, move, archive and trash propagate to IMAP', async () => {
  const kick1 = messages.find((m) => m.messageId === 'kick-1@test.local') || (await api('GET', '/api/messages?view=unified&threads=0')).items.find((m) => m.messageId === 'kick-1@test.local');
  await api('POST', '/api/messages/actions', { ids: [kick1.id], action: 'read' });
  await api('POST', '/api/messages/actions', { ids: [kick1.id], action: 'flag' });
  await waitFor(async () => (await listUids('alice@test.local', 'INBOX')).find((m) => m.subject === 'Project kickoff' && m.flags.includes('\\Seen') && m.flags.includes('\\Flagged')), { label: 'flags on server' });

  const news = (await api('GET', '/api/messages?q=from:news@shop.example')).items[0];
  await api('POST', '/api/messages/actions', { ids: [news.id], action: 'archive' });
  await waitFor(async () => (await listUids('alice@test.local', 'Archive')).length === 1, { label: 'archived on server' });
  // The local row keeps its id and gets the new UID (UIDPLUS).
  const after = await waitFor(async () => { const m = await api('GET', `/api/messages/${news.id}`); return m.uid && m.folder.specialUse === '\\Archive' && m; }, { label: 'uid remap' });
  assert.ok(after.insight, 'AI insight preserved after move');

  await api('POST', '/api/messages/actions', { ids: [news.id], action: 'trash' });
  await waitFor(async () => (await listUids('alice@test.local', 'Trash')).length === 1, { label: 'trashed on server' });
  await waitFor(async () => { const m = await api('GET', `/api/messages/${news.id}`); return m.uid && m.folder.specialUse === '\\Trash'; }, { label: 'trash uid' });
  await api('POST', '/api/messages/actions', { ids: [news.id], action: 'trash' }); // permanent from Trash
  await waitFor(async () => (await listUids('alice@test.local', 'Trash')).length === 0, { label: 'expunged' });
});

test('changes made by other clients are picked up (flags, new mail via IDLE, expunge)', async () => {
  const c = await imap('alice@test.local');
  const lock = await c.getMailboxLock('INBOX');
  try {
    const uid = (await c.search({ header: { 'message-id': 'kick-3@test.local' } }, { uid: true }))[0];
    await c.messageFlagsAdd([uid], ['\\Flagged'], { uid: true });
  } finally { lock.release(); await c.logout(); }
  await waitFor(async () => (await api('GET', '/api/messages?view=flagged&threads=0')).items.some((m) => m.messageId === 'kick-3@test.local'), { label: 'remote flag' });
  const fresh = rfc822({ from: 'Eve <eve@test.local>', to: 'alice@test.local', subject: 'Fresh arrival', body: 'Hello there' });
  await append('alice@test.local', fresh.raw);
  await waitFor(async () => (await api('GET', '/api/messages?view=unified&threads=0')).items.some((m) => m.subject === 'Fresh arrival'), { label: 'new mail' });
  const c2 = await imap('alice@test.local');
  const lock2 = await c2.getMailboxLock('INBOX');
  try { await c2.messageDelete({ header: { 'message-id': fresh.id } }); } finally { lock2.release(); await c2.logout(); }
  await waitFor(async () => !(await api('GET', '/api/messages?view=unified&threads=0')).items.some((m) => m.subject === 'Fresh arrival'), { label: 'remote expunge' });
});

test('send mail: delivery, Sent folder, undo-send and scheduled send', async () => {
  const before = smtp.delivered.length;
  const r = await api('POST', '/api/send', { accountId: account.id, to: [{ address: 'bob@test.local', name: 'Bob' }], cc: [], bcc: ['secret@test.local'], subject: 'Hello Bob', html: '<p>Hi <b>Bob</b></p>' });
  assert.ok(r.id);
  await waitFor(() => smtp.delivered.length > before, { label: 'smtp delivery' });
  const d = smtp.delivered.at(-1);
  assert.deepEqual(d.to.sort(), ['bob@test.local', 'secret@test.local']);
  assert.ok(!/^Bcc:/mi.test(d.raw.toString()), 'Bcc header stripped');
  await waitFor(async () => (await listUids('bob@test.local', 'INBOX')).some((m) => m.subject === 'Hello Bob'), { label: 'bob inbox' });
  await waitFor(async () => (await listUids('alice@test.local', 'Sent')).some((m) => m.subject === 'Hello Bob'), { label: 'sent copy' });

  await api('PATCH', '/api/settings', { mail: { undoSendSeconds: 30 } });
  const q = await api('POST', '/api/send', { accountId: account.id, to: ['bob@test.local'], subject: 'Oops', text: 'cancel me' });
  const cancelled = await api('POST', `/api/outbox/${q.id}/cancel`);
  assert.equal(cancelled.payload.subject, 'Oops');
  const sched = await api('POST', '/api/send', { accountId: account.id, to: ['bob@test.local'], subject: 'Later', text: 'scheduled', sendAt: Date.now() + 3600e3 });
  const outbox = await api('GET', '/api/outbox');
  assert.ok(outbox.some((o) => o.id === sched.id && o.status === 'queued'));
  await api('PATCH', '/api/settings', { mail: { undoSendSeconds: 0 } });
});

test('reply threads correctly and marks original answered', async () => {
  const kick3 = (await api('GET', '/api/messages?view=unified&threads=0')).items.find((m) => m.messageId === 'kick-3@test.local');
  const before = smtp.delivered.length;
  await api('POST', '/api/send', { accountId: account.id, to: ['carol@test.local'], subject: 'Re: Project kickoff', text: 'See you!', inReplyToId: kick3.id });
  await waitFor(() => smtp.delivered.length > before, { label: 'reply delivered' });
  const raw = smtp.delivered.at(-1).raw.toString();
  assert.match(raw, /In-Reply-To: <kick-3@test\.local>/);
  assert.match(raw, /References: <kick-1@test\.local> <kick-2@test\.local> <kick-3@test\.local>/);
  await waitFor(async () => (await api('GET', `/api/messages/${kick3.id}`)).isAnswered, { label: 'answered flag' });
});

test('calendar invitation: parse, accept, RSVP', async () => {
  const inv = (await api('GET', '/api/messages?q=' + encodeURIComponent('subject:"Design review"'))).items[0];
  assert.equal(inv.hasInvite, true);
  const info = await api('GET', `/api/messages/${inv.id}/invitation`);
  assert.equal(info.event.title, 'Design review');
  assert.equal(info.myStatus, 'needs-action');
  const before = smtp.delivered.length;
  const res = await api('POST', `/api/messages/${inv.id}/invitation/respond`, { response: 'accept' });
  assert.ok(res.eventId);
  await waitFor(() => smtp.delivered.length > before, { label: 'RSVP sent' });
  const rsvp = smtp.delivered.at(-1);
  assert.deepEqual(rsvp.to, ['dave@test.local']);
  assert.match(rsvp.raw.toString(), /METHOD:REPLY/);
  assert.match(rsvp.raw.toString(), /PARTSTAT=ACCEPTED/);
  const events = await api('GET', `/api/events?from=${now}&to=${now + 7 * 864e5}`);
  assert.ok(events.some((e) => e.title === 'Design review'));
});

test('calendar CRUD, recurrence, exceptions, ICS export/import, free slots', async () => {
  const start = new Date(); start.setHours(9, 0, 0, 0); start.setDate(start.getDate() + 1);
  const ev = await api('POST', '/api/events', { title: 'Standup', start: start.getTime(), end: start.getTime() + 15 * 60e3, rrule: 'FREQ=DAILY;COUNT=10' });
  let list = await api('GET', `/api/events?from=${start.getTime() - 1}&to=${start.getTime() + 20 * 864e5}`);
  assert.equal(list.filter((e) => e.title === 'Standup').length, 10);
  const second = start.getTime() + 864e5;
  await api('PATCH', `/api/events/${ev.id}`, { scope: 'this', occurrence: second, title: 'Standup (moved)', start: second + 3600e3, end: second + 3600e3 + 15 * 60e3 });
  await api('DELETE', `/api/events/${ev.id}?scope=this&occurrence=${start.getTime() + 2 * 864e5}`);
  list = await api('GET', `/api/events?from=${start.getTime() - 1}&to=${start.getTime() + 20 * 864e5}`);
  assert.equal(list.filter((e) => e.title === 'Standup').length, 8);
  assert.equal(list.filter((e) => e.title === 'Standup (moved)').length, 1);
  // Deleting the modified occurrence must not resurrect the original slot.
  const moved = list.find((e) => e.title === 'Standup (moved)');
  await api('DELETE', `/api/events/${moved.id}`);
  list = await api('GET', `/api/events?from=${start.getTime() - 1}&to=${start.getTime() + 20 * 864e5}`);
  assert.equal(list.filter((e) => e.title.startsWith('Standup')).length, 8);
  await api('PATCH', `/api/events/${ev.id}`, { scope: 'this', occurrence: second, title: 'Standup (moved)', start: second + 3600e3, end: second + 3600e3 + 15 * 60e3 });
  list = await api('GET', `/api/events?from=${start.getTime() - 1}&to=${start.getTime() + 20 * 864e5}`);
  const cals = await api('GET', '/api/calendars');
  const ics = await api('GET', `/api/calendars/${cals[0].id}/export.ics`);
  assert.match(ics, /RRULE:FREQ=DAILY;COUNT=10/);
  assert.match(ics, /RECURRENCE-ID/);
  const newCal = await api('POST', '/api/calendars', { name: 'Imported', color: '#f00' });
  const imp = await api('POST', `/api/calendars/${newCal.id}/import`, { ics });
  assert.ok(imp.imported >= 2);
  const slots = await api('GET', `/api/calendar/free-slots?from=${start.getTime() - 3600e3}&to=${start.getTime() + 864e5}&duration=30`);
  assert.ok(slots.length > 0);
  assert.ok(slots.every((s) => !(s.start < start.getTime() + 15 * 60e3 && s.end > start.getTime())), 'slots avoid busy standup');
});

test('contacts: auto-collected, CRUD, vCard round-trip, CSV import, autocomplete', async () => {
  const ac = await api('GET', '/api/contacts/autocomplete?q=bob');
  assert.ok(ac.some((c) => c.address === 'bob@test.local'), 'recipients are auto-collected');
  const c = await api('POST', '/api/contacts', { firstName: 'Zoë', lastName: 'Novak', emails: [{ type: 'work', value: 'zoe@firma.si' }], phones: [{ type: 'mobile', value: '+386 40 123 456' }], org: 'Firma d.o.o.', groups: ['Team'] });
  assert.equal(c.displayName, 'Zoë Novak');
  const vcf = await api('GET', '/api/contacts/export.vcf');
  assert.match(vcf, /FN:Zoë Novak/);
  const imported = await api('POST', '/api/contacts/import', { vcf: 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Jan Kos\r\nN:Kos;Jan;;;\r\nEMAIL;TYPE=INTERNET:jan@kos.si\r\nNOTE:Line1\\nLine2\\, with comma\r\nEND:VCARD\r\n' });
  assert.equal(imported.created, 1);
  const jan = (await api('GET', '/api/contacts?q=Jan')).find((x) => x.displayName === 'Jan Kos');
  assert.equal(jan.notes, 'Line1\nLine2, with comma');
  const csv = await api('POST', '/api/contacts/import', { vcf: 'First Name,Last Name,E-mail Address,Company\nAna,Horvat,ana@h.si,ACME\n' });
  assert.equal(csv.created, 1);
  const groups = await api('GET', '/api/contacts/groups');
  assert.deepEqual(groups.map((g) => g.name), ['Team']);
  const detail = await api('GET', `/api/contacts/${ac[0].contactId}`);
  assert.ok(detail.recentMessages.length >= 1);
});

test('tasks from AI action items', async () => {
  const kick1 = (await api('GET', '/api/messages?view=unified&threads=0')).items.find((m) => m.messageId === 'kick-1@test.local');
  const created = await api('POST', `/api/tasks/from-message/${kick1.id}`, {});
  assert.ok(created.length >= 1);
  const t = await api('PATCH', `/api/tasks/${created[0].id}`, { done: true });
  assert.equal(t.done, true);
});

test('AI on demand: streaming compose, rewrite, draft reply, ask inbox, brief', async () => {
  const kick3 = (await api('GET', '/api/messages?view=unified&threads=0')).items.find((m) => m.messageId === 'kick-3@test.local');
  let lines = ndjson(await api('POST', '/api/ai/draft-reply', { messageId: kick3.id, intent: 'accept and confirm', stream: true }));
  assert.ok(lines.some((l) => l.t));
  assert.ok(lines.at(-1).done);
  lines = ndjson(await api('POST', '/api/ai/compose', { instruction: 'invite the team to lunch on Friday' }));
  assert.ok(lines.at(-1).done && lines.at(-1).result.body);
  lines = ndjson(await api('POST', '/api/ai/rewrite', { text: 'hey can u send the file', mode: 'formal' }));
  assert.ok(typeof lines.at(-1).result === 'string');
  lines = ndjson(await api('POST', '/api/ai/ask', { question: 'What did Carol say about the budget?' }));
  const done = lines.at(-1);
  assert.ok(done.done && done.result.chatId, JSON.stringify(done));
  const chats = await api('GET', '/api/ai/chats');
  assert.equal(chats.length, 1);
  const brief = await api('GET', '/api/ai/brief?refresh=1');
  assert.ok(brief.content.length > 0);
  const ev = await api('POST', '/api/ai/extract-event', { messageId: kick3.id });
  assert.ok(ev.title);
});

test('rules: move matching messages on arrival', async () => {
  const f = await api('GET', '/api/folders');
  const archive = f.accounts[0].folders.find((x) => x.specialUse === '\\Archive');
  await api('POST', '/api/rules', { name: 'Receipts', conditions: [{ field: 'subject', op: 'contains', value: 'receipt' }], actions: [{ type: 'move', folderId: archive.id }, { type: 'markRead' }] });
  const m = rfc822({ from: 'shop@store.example', to: 'alice@test.local', subject: 'Your receipt #42', body: 'Thanks for your order' });
  await append('alice@test.local', m.raw);
  await waitFor(async () => (await listUids('alice@test.local', 'Archive')).some((x) => x.subject === 'Your receipt #42'), { label: 'rule moved on server' });
});

test('folders: create, rename, delete', async () => {
  await api('POST', '/api/folders', { accountId: account.id, name: 'Projects' });
  await waitFor(async () => (await api('GET', '/api/folders')).accounts[0].folders.some((x) => x.path === 'Projects'), { label: 'folder created' });
  let folder = (await api('GET', '/api/folders')).accounts[0].folders.find((x) => x.path === 'Projects');
  await api('PATCH', `/api/folders/${folder.id}`, { name: 'Projects 2026' });
  await waitFor(async () => (await api('GET', '/api/folders')).accounts[0].folders.some((x) => x.path === 'Projects 2026'), { label: 'folder renamed' });
  folder = (await api('GET', '/api/folders')).accounts[0].folders.find((x) => x.path === 'Projects 2026');
  await api('DELETE', `/api/folders/${folder.id}`);
  await waitFor(async () => !(await api('GET', '/api/folders')).accounts[0].folders.some((x) => x.path === 'Projects 2026'), { label: 'folder deleted' });
});

test('security: unauthenticated access is rejected and secrets are encrypted at rest', async () => {
  const r = await fetch(base + '/api/messages');
  assert.equal(r.status, 401);
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(path.join(dataDir, 'halcyon.db'), { readonly: true });
  const row = db.prepare('SELECT imap_pass_enc FROM accounts').get();
  assert.ok(row.imap_pass_enc.startsWith('v1:') && !row.imap_pass_enc.includes('secret123'));
  const accs = await api('GET', '/api/accounts');
  assert.ok(!JSON.stringify(accs).includes('secret123'));
  db.close();
});
