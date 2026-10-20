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

// Reasoning models served by OpenAI-compatible servers put their chain of thought in <think>…</think>.
export const stripThink = (s) => String(s || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trimStart();

/** Wraps onToken so streamed <think>…</think> sections are not shown to the user. */
export function thinkFilter(onToken) {
  let buf = '', inThink = false, started = false;
  const filter = (t) => {
    buf += t;
    for (;;) {
      if (inThink) {
        const e = buf.indexOf('</think>');
        if (e < 0) { buf = buf.slice(-8); return; }
        buf = buf.slice(e + 8); inThink = false;
      } else {
        const s = buf.indexOf('<think>');
        if (s >= 0) { if (s) emit(buf.slice(0, s)); buf = buf.slice(s + 7); inThink = true; continue; }
        // Hold back a tail that could be the start of "<think>" until the next token decides.
        const keep = buf.lastIndexOf('<');
        const out = keep >= 0 && '<think>'.startsWith(buf.slice(keep)) ? buf.slice(0, keep) : buf;
        buf = buf.slice(out.length);
        if (out) emit(out);
        return;
      }
    }
  };
  filter.flush = () => { if (!inThink && buf) emit(buf); buf = ''; };
  return filter;
  function emit(s) { if (!started) { s = s.trimStart(); if (!s) return; started = true; } onToken(s); }
}
