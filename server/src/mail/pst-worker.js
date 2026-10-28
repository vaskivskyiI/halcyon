// Worker thread: reads an Outlook data file (pst.js) and hands each email to the main thread, which stores it. One
// email at a time is outstanding — the next is read when the main thread has taken the previous one — so neither
// memory nor the main thread's queue grows with the size of the file, and the server keeps answering meanwhile.
import { parentPort, workerData } from 'node:worker_threads';
import { readPst } from './pst.js';

let release = null;
parentPort.on('message', (m) => { if (m === 'next' && release) { const r = release; release = null; r(); } });
const handOver = (msg, transfer) => new Promise((resolve) => { release = resolve; parentPort.postMessage(msg, transfer); });

try {
  await readPst(workerData.file, {
    setTotal: (total) => parentPort.postMessage({ type: 'total', total }),
    add: async (where, raw, opts = {}) => {
      if (!raw) return handOver({ type: 'item', where, skip: !!opts.skip, error: opts.error ? String(opts.error.message || opts.error) : null });
      const bytes = new Uint8Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
      return handOver({ type: 'item', where, raw: bytes, flags: opts.flags || [], date: opts.date ? new Date(opts.date).getTime() : null }, [bytes.buffer]);
    },
  });
  parentPort.postMessage({ type: 'done' });
} catch (e) {
  parentPort.postMessage({ type: 'error', message: String(e?.message || e) });
}
