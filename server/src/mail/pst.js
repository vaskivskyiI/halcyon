// Outlook data files (.pst / .ost) read with pst-extractor: each mail item as an RFC 822 email, with its folder path,
// read / flagged state and date. No database here — it runs in a worker thread (pst-worker.js), because the library
// reads synchronously and would otherwise hold up the whole server for a large file.
import { createRequire } from 'node:module';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';

const require = createRequire(import.meta.url);

const PR = { SENDER_SMTP: 0x5d01, SENT_REPR_SMTP: 0x5d02, FLAG_STATUS: 0x1090 };
const smtpLike = (s) => (/^[^\s@]+@[^\s@]+$/.test(String(s || '').trim()) ? String(s).trim() : '');

function headerOf(headers, name) {
  const m = String(headers || '').replace(/\r?\n[ \t]+/g, ' ').match(new RegExp(`^${name}:[ \\t]*(.*)$`, 'mi'));
  return m ? m[1].trim() : '';
}

/** One Outlook item as an RFC 822 email (original headers where Outlook kept them). */
async function pstToRaw(msg, depth = 0) {
  const headers = msg.transportMessageHeaders || '';
  const fromSmtp = smtpLike(msg.getStringItem?.(PR.SENDER_SMTP)) || (msg.senderAddrtype === 'SMTP' && smtpLike(msg.senderEmailAddress))
    || smtpLike(msg.getStringItem?.(PR.SENT_REPR_SMTP)) || smtpLike(msg.sentRepresentingEmailAddress);
  const from = headerOf(headers, 'From') || (fromSmtp ? { name: msg.senderName || '', address: fromSmtp } : msg.senderName ? `"${msg.senderName.replace(/"/g, '')}" <unknown@outlook.invalid>` : undefined);
  const rcpt = { 1: [], 2: [], 3: [] };
  for (let i = 0; i < msg.numberOfRecipients; i++) {
    const r = msg.getRecipient(i);
    if (!r) continue;
    const address = smtpLike(r.smtpAddress) || (r.addrType === 'SMTP' && smtpLike(r.emailAddress));
    if (address) rcpt[r.recipientType]?.push({ name: r.displayName || '', address });
  }
  const attachments = [];
  for (let i = 0; i < msg.numberOfAttachments; i++) {
    const a = msg.getAttachment(i);
    if (!a) continue;
    if (a.attachMethod === 5 && a.embeddedPSTMessage && depth < 3) {
      // An email attached to an email (forwarded as attachment).
      const inner = await pstToRaw(a.embeddedPSTMessage, depth + 1);
      attachments.push({ filename: `${(a.embeddedPSTMessage.subject || 'message').replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80)}.eml`, content: inner, contentType: 'message/rfc822' });
      continue;
    }
    const s = a.fileInputStream;
    if (!s) continue;
    const buf = Buffer.alloc(a.filesize);
    s.readCompletely(buf);
    attachments.push({ filename: a.longFilename || a.filename || `attachment-${i + 1}`, content: buf, contentType: a.mimeTag || 'application/octet-stream', ...(a.contentId ? { cid: a.contentId } : {}) });
  }
  const date = msg.clientSubmitTime || msg.messageDeliveryTime || new Date();
  const mid = msg.internetMessageId || headerOf(headers, 'Message-ID');
  const mail = new MailComposer({
    from, to: rcpt[1].length ? rcpt[1] : headerOf(headers, 'To') || undefined, cc: rcpt[2].length ? rcpt[2] : headerOf(headers, 'Cc') || undefined, bcc: rcpt[3].length ? rcpt[3] : undefined,
    subject: msg.subject || '', date, messageId: mid || undefined, inReplyTo: msg.inReplyToId || headerOf(headers, 'In-Reply-To') || undefined,
    references: headerOf(headers, 'References') || undefined,
    text: msg.body || undefined, html: msg.bodyHTML || undefined, attachments,
  });
  return { raw: await mail.compile().build(), date };
}

export async function readPst(file, { add, setTotal }) {
  const { PSTFile } = require('pst-extractor');
  let pst;
  try { pst = new PSTFile(file); } catch (e) {
    // The library quotes the file's first bytes; what matters is that it is not a readable Outlook data file.
    throw new Error(/header|magic/i.test(e.message) ? 'This is not an Outlook data file (.pst / .ost), or it is damaged or incomplete' : e.message);
  }
  try {
    let total = 0;
    const count = (f) => { total += f.contentCount || 0; if (f.hasSubfolders) f.getSubFolders().forEach(count); };
    const root = pst.getRootFolder();
    count(root);
    setTotal(total);
    const walk = async (f, trail) => {
      // The store's own top folders ("Top of Personal Folders", "Root - Mailbox") are not part of the paths.
      const name = (f.displayName || '').replace(/\//g, '-').trim();
      const here = trail === null ? [] : [...trail, name].filter(Boolean);
      const top = trail === null || /^(top of (personal|outlook data) folders?|root - (mailbox|public)|ipm_subtree)$/i.test(name);
      const where = top && trail !== null ? trail : here;
      if (f.contentCount > 0) {
        for (let m = f.getNextChild(); m; m = f.getNextChild()) {
          // Mail only (calendar items, contacts, tasks and notes are skipped).
          if (!/^IPM\.(Note|Schedule\.Meeting|Post)/i.test(m.messageClass || 'IPM.Note')) { await add(null, null, { skip: true }); continue; }
          try {
            const { raw, date } = await pstToRaw(m);
            const flags = [m.isRead && '\\Seen', m.getIntItem?.(PR.FLAG_STATUS) === 2 && '\\Flagged'].filter(Boolean);
            await add(where.join('/') || 'Inbox', raw, { flags, date });
          } catch (e) { await add(null, null, { error: e }); }
        }
      }
      if (f.hasSubfolders) for (const s of f.getSubFolders()) await walk(s, where);
    };
    await walk(root, null);
  } finally { try { pst.close(); } catch { /* already closed */ } }
}
