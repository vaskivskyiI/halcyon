// Reading mail out of files into an archive (see archive.js): Outlook data files (.pst / .ost), MBOX (Thunderbird,
// Apple Mail, Google Takeout, Halcyon's export), single .eml files and ZIPs of .eml files (Halcyon's export, folders
// kept). Each importer calls add(folderPath, raw, { flags, date }) for every email.
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { registerImporter } from './archive.js';
import { zipEntries } from '../util/zip.js';

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

// pst-extractor reads synchronously: opening a large file and walking its folders would block the server for minutes.
// The file is read in a worker thread (pst-worker.js → pst.js); each email comes back here to be stored, at most a
// few at a time (the worker waits for each to be taken), so memory stays flat whatever the size of the file.
async function pstImport(file, { add, setTotal }) {
  const worker = new Worker(new URL('./pst-worker.js', import.meta.url), { workerData: { file } });
  let chain = Promise.resolve();
  try {
    await new Promise((resolve, reject) => {
      worker.on('message', (m) => {
        if (m.type === 'total') setTotal(m.total);
        else if (m.type === 'item') {
          chain = chain.then(() => add(m.where, m.raw ? Buffer.from(m.raw.buffer, m.raw.byteOffset, m.raw.byteLength) : null,
            m.error ? { error: new Error(m.error) } : m.skip ? { skip: true } : { flags: m.flags, date: m.date ? new Date(m.date) : undefined }))
            .finally(() => worker.postMessage('next'));
        } else if (m.type === 'done') chain.then(resolve, reject);
        else if (m.type === 'error') reject(new Error(m.message));
      });
      worker.on('error', reject);
      worker.on('exit', (code) => { if (code) reject(new Error(`The Outlook data file reader stopped (code ${code})`)); });
    });
  } finally { worker.terminate().catch(() => {}); }
}
registerImporter('pst', pstImport);
registerImporter('ost', pstImport);
