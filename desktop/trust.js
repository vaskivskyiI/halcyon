// Certificates of the user's own server that Windows / the system does not trust: a CA certificate added in the
// Connection window (ca/), or the server's own certificate trusted by its fingerprint (pinned/<host>.pem — for a
// self-signed one). Either is accepted only for the configured server's host, and only when the name and dates fit;
// everything else is checked as usual. Like windows/Halcyon/Trust.cs.
const { app } = require('electron');
const { X509Certificate } = require('node:crypto');
const tls = require('node:tls');
const fs = require('node:fs');
const path = require('node:path');

const caDir = () => path.join(app.getPath('userData'), 'ca');
const pinDir = () => path.join(app.getPath('userData'), 'pinned');
const safeHost = (host) => String(host).toLowerCase().replace(/[^a-z0-9.-]/g, '_');

const pemOf = (der) => `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
/** Every certificate in a .pem/.crt/.cer file (PEM, also a bundle, or DER). */
function readCerts(file) {
  const buf = fs.readFileSync(file);
  const text = buf.toString('latin1');
  const pems = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  return (pems || [buf]).map((p) => new X509Certificate(p));
}
const loadDir = (dir) => { try { return fs.readdirSync(dir).flatMap((f) => { try { return readCerts(path.join(dir, f)); } catch { return []; } }); } catch { return []; } };

/** Adds the CA certificate(s) of a file; returns their subjects. A server certificate is refused (add its CA). */
function addCa(file) {
  const certs = readCerts(file).filter((c) => c.ca);
  if (!certs.length) throw new Error('This is not a CA certificate. Add the certificate of the authority that issued the server\'s certificate, or trust the server\'s certificate itself.');
  fs.mkdirSync(caDir(), { recursive: true });
  for (const c of certs) fs.writeFileSync(path.join(caDir(), `${c.fingerprint256.replace(/:/g, '').slice(0, 32)}.pem`), c.toString());
  return certs.map((c) => c.subject.replace(/\n/g, ', '));
}

/** The certificate a server presents (not checked), for the user to look at before trusting it. */
function inspect(url) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: u.hostname, port: Number(u.port) || 443, servername: u.hostname, rejectUnauthorized: false, timeout: 8000 }, () => {
      const c = s.getPeerX509Certificate();
      s.end();
      if (!c) { reject(new Error('The server sent no certificate')); return; }
      resolve({ host: u.hostname, subject: c.subject.replace(/\n/g, ', '), issuer: c.issuer.replace(/\n/g, ', '), selfSigned: c.subject === c.issuer,
        validTo: c.validTo, fingerprint: c.fingerprint256, nameOk: !!c.checkHost(u.hostname), pem: c.toString(), authorized: s.authorized });
    });
    s.on('timeout', () => { s.destroy(); reject(new Error('The server did not answer')); });
    s.on('error', reject);
  });
}

/** Trusts the server's certificate — only if it is still the one the user saw (same fingerprint). */
async function pin(url, fingerprint) {
  const c = await inspect(url);
  if (c.fingerprint !== fingerprint) throw new Error('The server now presents another certificate. Look at it again before trusting it.');
  if (!c.nameOk) throw new Error(`This certificate is not for ${c.host}.`);
  fs.mkdirSync(pinDir(), { recursive: true });
  fs.writeFileSync(path.join(pinDir(), `${safeHost(c.host)}.pem`), c.pem);
  return c;
}

function list() {
  return { cas: loadDir(caDir()).map((c) => c.subject.replace(/\n/g, ', ')), pinned: (() => { try { return fs.readdirSync(pinDir()).map((f) => f.replace(/\.pem$/, '')); } catch { return []; } })() };
}
function clear() { for (const d of [caDir(), pinDir()]) fs.rmSync(d, { recursive: true, force: true }); }

/** Whether a certificate Chromium did not accept is the user's server's, as trusted here. cert: Electron's Certificate. */
function accepts(cert, host) {
  try {
    const chain = [];
    for (let c = cert; c && chain.length < 8; c = c.issuerCert) { chain.push(new X509Certificate(c.data)); if (c.issuerCert === c) break; }
    const leaf = chain[0];
    const now = Date.now();
    if (!leaf.checkHost(host) || now < Date.parse(leaf.validFrom) || now > Date.parse(leaf.validTo)) return false;
    const pinFile = path.join(pinDir(), `${safeHost(host)}.pem`);
    if (fs.existsSync(pinFile) && readCerts(pinFile).some((p) => p.fingerprint256 === leaf.fingerprint256)) return true;
    // A chain up to one of the added CAs: each link signed by the next, the last one issued by the CA.
    for (const ca of loadDir(caDir())) {
      for (let i = 0; i < chain.length; i++) {
        const c = chain[i];
        const linked = chain.slice(0, i).every((x, k) => x.verify(chain[k + 1].publicKey));
        if (!linked) break;
        if (c.fingerprint256 === ca.fingerprint256 || (c.checkIssued(ca) && c.verify(ca.publicKey))) return true;
      }
    }
  } catch { /* unreadable: not accepted */ }
  return false;
}

/** From now on the session (pages, WebSocket, net.fetch) also accepts the server's certificate as trusted here. */
function install(session, serverUrl) {
  let host = '';
  try { host = new URL(serverUrl).hostname.toLowerCase(); } catch { /* no server */ }
  session.setCertificateVerifyProc((req, cb) => {
    if (req.verificationResult === 'net::OK') return cb(-3); // as Chromium decided
    if (host && req.hostname.toLowerCase() === host && accepts(req.certificate, host)) return cb(0);
    cb(-3);
  });
}

module.exports = { addCa, inspect, pin, list, clear, install, accepts };
