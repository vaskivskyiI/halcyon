// Test fixtures: an SMTP relay that delivers into the local IMAP server, and IMAP helpers.
import { SMTPServer } from 'smtp-server';
import { ImapFlow } from 'imapflow';

export const IMAP = { host: '127.0.0.1', port: Number(process.env.TEST_IMAP_PORT || 1143), secure: false };
export const PASSWORD = process.env.TEST_IMAP_PASSWORD || 'secret123';

export async function imap(user) {
  const c = new ImapFlow({ ...IMAP, auth: { user, pass: PASSWORD }, logger: false });
  await c.connect();
  return c;
}

export async function append(user, raw, folder = 'INBOX', flags = []) {
  const c = await imap(user);
  try { return await c.append(folder, raw, flags); } finally { await c.logout(); }
}

export async function listUids(user, folder) {
  const c = await imap(user);
  const lock = await c.getMailboxLock(folder);
  try {
    const out = [];
    for await (const m of c.fetch('1:*', { uid: true, flags: true, envelope: true })) out.push({ uid: m.uid, flags: [...m.flags], subject: m.envelope.subject });
    return out;
  } catch { return []; } finally { lock.release(); await c.logout(); }
}

export async function clearMailbox(user) {
  const c = await imap(user);
  try {
    for (const box of await c.list()) {
      const lock = await c.getMailboxLock(box.path);
      try { if (c.mailbox.exists) await c.messageDelete('1:*'); } finally { lock.release(); }
      if (!box.specialUse && box.path !== 'INBOX') await c.mailboxDelete(box.path).catch(() => {});
    }
  } finally { await c.logout(); }
}

export function startSmtp(port = 0) {
  const delivered = [];
  const server = new SMTPServer({
    authOptional: true, disabledCommands: ['STARTTLS'], onAuth: (a, s, cb) => cb(null, { user: a.username }),
    onData(stream, session, cb) {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', async () => {
        const raw = Buffer.concat(chunks);
        delivered.push({ from: session.envelope.mailFrom.address, to: session.envelope.rcptTo.map((r) => r.address), raw });
        for (const r of session.envelope.rcptTo) {
          if (r.address.endsWith('@test.local')) await append(r.address, raw).catch(() => {});
        }
        cb();
      });
    },
  });
  return new Promise((resolve, reject) => {
    server.server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, delivered, port: server.server.address().port }));
  });
}

export function rfc822({ from, to, subject, body, date = new Date(), messageId, inReplyTo, references, headers = {}, html, ics }) {
  const id = messageId || `${Math.random().toString(36).slice(2)}@test.local`;
  const lines = [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Date: ${date.toUTCString()}`, `Message-ID: <${id}>`];
  if (inReplyTo) lines.push(`In-Reply-To: <${inReplyTo}>`);
  if (references) lines.push(`References: ${references.map((r) => `<${r}>`).join(' ')}`);
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  lines.push('MIME-Version: 1.0');
  if (ics) {
    lines.push('Content-Type: multipart/alternative; boundary="b1"', '', '--b1', 'Content-Type: text/plain; charset=utf-8', '', body, '--b1', 'Content-Type: text/calendar; charset=utf-8; method=REQUEST', '', ics, '--b1--');
  } else if (html) {
    lines.push('Content-Type: text/html; charset=utf-8', '', html);
  } else {
    lines.push('Content-Type: text/plain; charset=utf-8', '', body);
  }
  return { raw: Buffer.from(lines.join('\r\n') + '\r\n'), id };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 20000, interval = 250, label = 'condition' } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${label}: ${last instanceof Error ? last.message : JSON.stringify(last)?.slice(0, 200)}`);
}
