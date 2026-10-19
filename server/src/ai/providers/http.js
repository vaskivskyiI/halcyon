// Shared HTTP helpers for AI providers: timeouts, error extraction, SSE / NDJSON streaming.
export class AIError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export async function request(url, { method = 'POST', headers = {}, body, signal, timeoutMs = 180e3 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(new Error('AI request timed out')), timeoutMs);
  const onAbort = () => ctl.abort(signal.reason);
  signal?.addEventListener('abort', onAbort);
  try {
    const r = await fetch(url, {
      method, signal: ctl.signal,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) {
      let msg = `${r.status} ${r.statusText}`;
      try {
        const txt = await r.text();
        const j = JSON.parse(txt);
        msg = j.error?.message || j.error || j.message || txt.slice(0, 300);
      } catch { /* keep status text */ }
      throw new AIError(typeof msg === 'string' ? msg : JSON.stringify(msg), r.status);
    }
    return r;
  } catch (e) {
    if (e.name === 'AbortError' || e.name === 'TimeoutError') throw new AIError(e.message || 'Request aborted', 499);
    if (e instanceof AIError) throw e;
    throw new AIError(`Cannot reach AI provider: ${e.cause?.code || e.message}`, 503);
  } finally {
    clearTimeout(t);
    signal?.removeEventListener('abort', onAbort);
  }
}

// Yields complete lines from a streaming body.
export async function* lines(response) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of response.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      yield line;
    }
  }
  if (buf.trim()) yield buf;
}

export async function* sseData(response) {
  for await (const line of lines(response)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try { yield JSON.parse(data); } catch { /* ignore keep-alives */ }
  }
}

export const trimSlash = (s) => String(s || '').replace(/\/+$/, '');
