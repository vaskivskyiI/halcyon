import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { decrypt } from '../util/crypto.js';
import { accessToken, isOAuth } from './oauth.js';

export async function imapClient(account, opts = {}) {
  const auth = isOAuth(account)
    ? { user: account.imap_user || account.email, accessToken: await accessToken(account) }
    : { user: account.imap_user || account.email, pass: decrypt(account.imap_pass_enc) || '' };
  return new ImapFlow({
    host: account.imap_host, port: account.imap_port || 993, secure: !!account.imap_secure,
    auth, logger: false, emitLogs: false, disableAutoIdle: false,
    tls: { rejectUnauthorized: process.env.HALCYON_TLS_INSECURE !== '1' },
    socketTimeout: 5 * 60e3, greetingTimeout: 20e3, connectionTimeout: 30e3,
    ...opts,
  });
}

export async function smtpTransport(account) {
  const user = account.smtp_user || account.imap_user || account.email;
  const auth = isOAuth(account)
    ? { type: 'OAuth2', user, accessToken: await accessToken(account) }
    : { user, pass: decrypt(account.smtp_pass_enc) || decrypt(account.imap_pass_enc) || '' };
  return nodemailer.createTransport({
    host: account.smtp_host, port: account.smtp_port || 465, secure: !!account.smtp_secure,
    auth, requireTLS: !account.smtp_secure && Number(account.smtp_port) === 587,
    tls: { rejectUnauthorized: process.env.HALCYON_TLS_INSECURE !== '1' },
    connectionTimeout: 30e3,
  });
}

// Verify credentials for both servers; used by "Test connection" in account setup.
export async function testAccount(account) {
  const result = { imap: null, smtp: null };
  try {
    const c = await imapClient(account);
    await c.connect();
    const folders = await c.list();
    result.imap = { ok: true, folders: folders.length };
    await c.logout();
  } catch (e) { result.imap = { ok: false, error: e.responseText || e.message }; }
  try {
    const t = await smtpTransport(account);
    await t.verify();
    result.smtp = { ok: true };
    t.close();
  } catch (e) { result.smtp = { ok: false, error: e.message }; }
  return result;
}
