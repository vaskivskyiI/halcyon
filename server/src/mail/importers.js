// Reading mail out of files into an archive (see archive.js): Outlook data files (.pst / .ost), MBOX (Thunderbird,
// Apple Mail, Google Takeout, Halcyon's export), single .eml files and ZIPs of .eml files (Halcyon's export, folders
// kept). Each importer calls add(folderPath, raw, { flags, date }) for every email.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { registerImporter } from './archive.js';
import { zipEntries } from '../util/zip.js';

const require = createRequire(import.meta.url);
const tick = () => new Promise((r) => setImmediate(r));
const baseName = (name) => path.basename(String(name || 'Imported')).replace(/\.(mbox|mbx|eml|zip|pst|ost)$/i, '') || 'Imported';

// Status / X-Status headers of MBOX files (R = read, F = flagged, A = answered).
function mboxFlags(raw) {
  const head = raw.subarray(0, 16384).toString('latin1').split(/\r?\n\r?\n/)[0];
  const st = `${(head.match(/^Status:\s*(\S*)/mi) || [])[1] || ''}${(head.match(/^X-Status:\s*(\S*)/mi) || [])[1] || ''}`;
  return [st.includes('R') && '\\Seen', st.includes('F') && '\\Flagged', st.includes('A') && '\\Answered'].filter(Boolean);
}

/** MBOX: messages start at lines "From …"; mboxrd-escaped ">From " lines are restored. Read in chunks (any size). */
async function mboxImport(file, { add, folder, name }) {
  const target = folder || baseName(name);
  const fd = fs.openSync(file, 'r');
  const one = async (buf) => {
    const nl = buf.indexOf(10);
    let body = buf.subarray(nl + 1).toString('latin1').replace(/^>(>*From )/gm, '$1');
    body = body.replace(/\r?\n$/, '');
    if (body.trim()) { const raw = Buffer.from(body, 'latin1'); await add(target, raw, { flags: mboxFlags(raw) }); }
  };
  try {
    let pending = Buffer.alloc(0);
    const chunk = Buffer.alloc(4 << 20);
    for (let n; (n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0;) {
      pending = Buffer.concat([pending, chunk.subarray(0, n)]);
      // Every complete message in what has been read so far: up to the last "\nFrom " line start.
      let start = pending.indexOf('From ') === 0 ? 0 : pending.indexOf('\nFrom ') + 1;
      if (start <= 0 && pending.indexOf('From ') !== 0) continue;
      for (;;) {
        const next = pending.indexOf('\nFrom ', start + 5);
        if (next < 0) break;
        await one(pending.subarray(start, next + 1));
        start = next + 1;
      }
      pending = pending.subarray(start);
      await tick();
    }
    if (pending.length && pending.indexOf('From ') === 0) await one(pending);
  } finally { fs.closeSync(fd); }
}
registerImporter('mbox', mboxImport);

registerImporter('eml', async (file, { add, folder }) => {
  await add(folder || 'Imported', fs.readFileSync(file), { flags: ['\\Seen'] });
});

/** A ZIP of .eml files (and .mbox files): the folders inside the ZIP become archive folders. */
registerImporter('zip', async (file, { add, setTotal, folder, name }) => {
  const entries = zipEntries(file);
  try {
    const mails = entries.filter((e) => /\.(eml|mbox)$/i.test(e.name));
    setTotal(mails.filter((e) => /\.eml$/i.test(e.name)).length || null);
    const root = folder || '';
    for (const e of mails) {
      const dir = path.posix.dirname(e.name).replace(/^\.$/, '');
      const where = [root, dir].filter(Boolean).join('/') || baseName(name);
      if (/\.eml$/i.test(e.name)) { const raw = e.read(); await add(where, raw, { flags: mboxFlags(raw).length ? mboxFlags(raw) : ['\\Seen'] }); }
      else {
        // An MBOX inside the ZIP: written out and read like any MBOX file.
        const tmp = `${file}.${Date.now()}.mbox`;
        fs.writeFileSync(tmp, e.read());
        try { await mboxImport(tmp, { add, folder: [root, dir, path.posix.basename(e.name).replace(/\.mbox$/i, '')].filter(Boolean).join('/') }); } finally { fs.rmSync(tmp, { force: true }); }
      }
      await tick();
    }
  } finally { entries.close(); }
});

// ---- Outlook data files

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

async function pstImport(file, { add, setTotal }) {
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
registerImporter('pst', pstImport);
registerImporter('ost', pstImport);
