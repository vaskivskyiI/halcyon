import { request, lines, trimSlash } from './http.js';

export function ollama({ baseUrl, apiKey }) {
  const base = trimSlash(baseUrl || 'http://localhost:11434');
  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  return {
    async chat({ model, system, messages, json, temperature = 0.3, maxTokens, onToken, signal }) {
      const body = {
        model, stream: !!onToken, keep_alive: '30m',
        messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
        options: { temperature, num_ctx: 8192, ...(maxTokens ? { num_predict: maxTokens } : {}) },
      };
      if (json) body.format = 'json';
      const r = await request(`${base}/api/chat`, { headers, body, signal, timeoutMs: 600e3 });
      if (!onToken) {
        const d = await r.json();
        return { text: d.message?.content || '', usage: { input: d.prompt_eval_count || 0, output: d.eval_count || 0 } };
      }
      let text = '', usage = { input: 0, output: 0 };
      for await (const line of lines(r)) {
        if (!line.trim()) continue;
        const d = JSON.parse(line);
        if (d.error) throw new Error(d.error);
        const t = d.message?.content || '';
        if (t) { text += t; onToken(t); }
        if (d.done) usage = { input: d.prompt_eval_count || 0, output: d.eval_count || 0 };
      }
      return { text, usage };
    },
    async embed({ model, input }) {
      const r = await request(`${base}/api/embed`, { headers, body: { model, input, keep_alive: '30m' }, timeoutMs: 300e3 });
      const d = await r.json();
      return d.embeddings;
    },
    async listModels() {
      const r = await request(`${base}/api/tags`, { method: 'GET', headers, timeoutMs: 15e3 });
      const d = await r.json();
      return (d.models || []).map((m) => ({ id: m.name, size: m.size, family: m.details?.family, embedding: /embed|bge|minilm|e5|gte|arctic/i.test(m.name) }));
    },
    async pull(model) {
      const r = await request(`${base}/api/pull`, { headers, body: { model, stream: false }, timeoutMs: 3600e3 });
      return r.json();
    },
  };
}
