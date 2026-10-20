// Internet mail lines end in CRLF. Bodies built with plain "\n" pass SMTP (which converts them) but some IMAP servers
// refuse to store them ("Message contains bare newlines"). Byte-safe: works on the raw bytes, not decoded text.
export function crlf(buf) {
  const s = Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf);
  if (!/(^|[^\r])\n|\r(?!\n)/.test(s)) return Buffer.isBuffer(buf) ? buf : Buffer.from(s, 'latin1');
  return Buffer.from(s.replace(/\r\n|\r|\n/g, '\r\n'), 'latin1');
}
