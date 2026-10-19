import { request, sseData, trimSlash } from './http.js';

export function anthropic({ baseUrl, apiKey }) {
  const base = trimSlash(baseUrl || 'https://api.anthropic.com');
  const headers = { 'x-api-key': apiKey || '', 'anthropic-version': '2023-06-01' };
  // The Messages API requires alternating roles starting with "user".
  const normalize = (messages) => {
    const out = [];
    for (const m of messages) {
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += `\n\n${m.content}`;
      else out.push({ role, content: m.content });
    }
    if (out[0]?.role !== 'user') out.unshift({ role: 'user', content: '(continue)' });
    return out;
  };
  return {
    async chat({ model, system, messages, json, temperature = 0.3, maxTokens = 2048, onToken, signal }) {
      const sys = [system, json ? 'Respond with a single valid JSON object only, no prose, no code fences.' : null].filter(Boolean).join('\n\n');
      const body = { model, max_tokens: maxTokens, messages: normalize(messages), stream: !!onToken, temperature };
      if (sys) body.system = sys;
      const r = await request(`${base}/v1/messages`, { headers, body, signal });
      if (!onToken) {
        const d = await r.json();
        return { text: (d.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(''), usage: { input: d.usage?.input_tokens || 0, output: d.usage?.output_tokens || 0 } };
      }
      let text = '';
      const usage = { input: 0, output: 0 };
      for await (const d of sseData(r)) {
        if (d.type === 'content_block_delta' && d.delta?.type === 'text_delta') { text += d.delta.text; onToken(d.delta.text); }
        else if (d.type === 'message_start') usage.input = d.message?.usage?.input_tokens || 0;
        else if (d.type === 'message_delta') usage.output = d.usage?.output_tokens || usage.output;
        else if (d.type === 'error') throw new Error(d.error?.message || 'Anthropic stream error');
      }
      return { text, usage };
    },
    async embed() { throw new Error('Anthropic does not provide an embeddings API — route embeddings to Ollama, OpenAI or Gemini'); },
    async listModels() {
      const r = await request(`${base}/v1/models?limit=100`, { method: 'GET', headers, timeoutMs: 15e3 });
      const d = await r.json();
      return (d.data || []).map((m) => ({ id: m.id, name: m.display_name }));
    },
  };
}
