// "Sent on behalf of", invitations that carry only calendar data still show their text, and invitation answers with or
// without a response to the organiser (optionally with a note).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyon-r15-test-'));
process.env.HALCYON_DATA_DIR = dataDir;
process.env.HALCYON_LOG_LEVEL = 'error';

let app, base, cookie = '', db, account, inbox, ingestMessage, n = 0;
async function api(method, url, body) {
  const r = await fetch(base + url, { method, headers: body === undefined ? { cookie } : { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(data)}`);
  return data;
}
const ingest = async (headers, body = 'Hello') => (await ingestMessage({ account, folder: inbox, uid: ++n, flags: [], raw: Buffer.from(`Message-ID: <r15-${n}@x>\r\nTo: me@example.org\r\nDate: ${new Date().toUTCString()}\r\n${headers}\r\n\r\n${body}\r\n`) })).id;
const ICS = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:r15-ev\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20261022T080000Z\r\nDTEND:20261022T090000Z\r\nSUMMARY:Budget review\r\nDESCRIPTION:Please bring the Q3 numbers.\\nRoom 2.\r\nLOCATION:Room 2\r\nORGANIZER;CN=Ana:mailto:ana@x.example\r\nATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@example.org\r\nEND:VEVENT\r\nEND:VCALENDAR';

before(async () => {
  const { buildServer } = await import('../src/index.js');
  app = await buildServer({ background: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;
  ({ db } = await import('../src/db/index.js'));
  ({ ingestMessage } = await import('../src/mail/store.js'));
  await api('POST', '/api/auth/setup', { email: 'me@example.org', name: 'Me', password: 'password123' });
  const uid = db.prepare('SELECT id FROM users').get().id;
  await api('PATCH', '/api/settings', { mail: { undoSendSeconds: 600 }, ai: { enabled: false } });
  account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(db.prepare("INSERT INTO accounts (user_id, email, smtp_host, sync_enabled, created_at) VALUES (?, 'me@example.org', '127.0.0.1', 0, ?)").run(uid, Date.now()).lastInsertRowid);
  inbox = db.prepare('SELECT * FROM folders WHERE id = ?').get(db.prepare("INSERT INTO folders (account_id, path, name, special_use) VALUES (?, 'INBOX', 'INBOX', '\\Inbox')").run(account.id).lastInsertRowid);
});
after(async () => { await app?.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('a message sent on behalf of someone else says so; mailing lists and bounce addresses do not', async () => {
  const behalf = await ingest('From: Director <director@x.example>\r\nSender: Ana Assistant <ana@x.example>\r\nSubject: Board meeting');
  const list = await ingest('From: Bob <bob@y.example>\r\nSender: dev-list-bounces@lists.example\r\nList-Id: <dev.lists.example>\r\nSubject: [dev] Release');
  const bounce = await ingest('From: Shop <news@shop.example>\r\nSender: bounces+123@mailer.example\r\nSubject: Offer');
  const same = await ingest('From: Bob <bob@y.example>\r\nSender: bob@y.example\r\nSubject: Hi');
  const m = await api('GET', `/api/messages/${behalf}`);
  assert.deepEqual(m.onBehalfOf, { name: 'Ana Assistant', address: 'ana@x.example' });
  assert.equal(m.from.address, 'director@x.example');
  for (const id of [list, bounce, same]) assert.equal((await api('GET', `/api/messages/${id}`)).onBehalfOf, null);
  const row = (await api('GET', '/api/messages?view=unified&threads=0')).items.find((x) => x.id === behalf);
  assert.equal(row.onBehalfOf.address, 'ana@x.example', 'shown in the list too');
});

test('older mail gets its sender read from the stored message when opened', async () => {
  const id = await ingest('From: Director <director@x.example>\r\nSender: Ana Assistant <ana@x.example>\r\nSubject: Old');
  db.prepare('UPDATE messages SET sender_json = NULL WHERE id = ?').run(id);
  assert.equal((await api('GET', `/api/messages/${id}`)).onBehalfOf.address, 'ana@x.example');
  assert.ok(db.prepare('SELECT sender_json FROM messages WHERE id = ?').get(id).sender_json, 'kept');
});

let inviteId;
test('an invitation that is only calendar data shows its description as the message', async () => {
  inviteId = await ingest('From: Ana <ana@x.example>\r\nSubject: Budget review\r\nMIME-Version: 1.0\r\nContent-Type: text/calendar; charset=utf-8; method=REQUEST', ICS);
  const m = await api('GET', `/api/messages/${inviteId}`);
  assert.equal(m.hasInvite, true);
  assert.match(m.text, /Please bring the Q3 numbers\.\nRoom 2\./);
  assert.match(m.text, /Location: Room 2/);
  // Older mail stored without text: filled in when shown.
  db.prepare("UPDATE messages SET body_text = '' WHERE id = ?").run(inviteId);
  assert.match((await api('GET', `/api/messages/${inviteId}`)).text, /Q3 numbers/);
});

test('an invitation can be answered without telling the organiser, or with a note', async () => {
  const outbox = () => db.prepare('SELECT payload_json FROM outbox').all().map((r) => JSON.parse(r.payload_json));
  await api('POST', `/api/messages/${inviteId}/invitation/respond`, { response: 'accept', sendReply: false });
  assert.equal(outbox().length, 0, 'nothing sent');
  const ev = db.prepare("SELECT status FROM events WHERE uid = 'r15-ev'").get();
  assert.ok(ev, 'in the calendar');
  await api('POST', `/api/messages/${inviteId}/invitation/respond`, { response: 'tentative', comment: 'I may be 10 minutes late.' });
  const sent = outbox();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to.map((a) => a.address || a), ['ana@x.example']);
  assert.match(sent[0].text, /10 minutes late/);
  assert.equal(sent[0].icalEvent.method, 'REPLY');
});

test('an invitation with raw line breaks inside its description is still understood', async () => {
  const { parseIcs } = await import('../src/calendar/ics.js');
  const broken = ICS.replace('Please bring the Q3 numbers.\\nRoom 2.', 'Please bring the Q3 numbers.\r\nWe decide on the travel budget.');
  assert.notEqual(broken, ICS);
  const ev = parseIcs(broken).events[0];
  assert.equal(ev.title, 'Budget review');
  assert.equal(ev.description, 'Please bring the Q3 numbers.\nWe decide on the travel budget.');
});
