// Route helpers.
export const ids = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map(Number).filter(Boolean);

export function httpError(reply, code, message) {
  return reply.code(code).send({ error: message });
}

/** Streams NDJSON: {"t": token} and {"s": status text} lines, then {"done": true, result} or {"error": msg}. */
export async function streamNdjson(req, reply, fn) {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
  const ctl = new AbortController();
  req.raw.on('close', () => { if (!res.writableEnded) ctl.abort(); });
  const write = (o) => { if (!res.writableEnded) res.write(JSON.stringify(o) + '\n'); };
  try {
    const result = await fn((t) => write({ t }), ctl.signal, (s) => write({ s }));
    write({ done: true, result });
  } catch (e) {
    write({ error: e.message, code: e.code });
  } finally {
    res.end();
  }
}
