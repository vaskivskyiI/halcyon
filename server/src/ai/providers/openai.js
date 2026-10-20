import { request, sseData, trimSlash, stripThink, thinkFilter } from './http.js';

// Works for OpenAI and any OpenAI-compatible endpoint (LM Studio, vLLM, LocalAI, llama.cpp server, Groq,
// Mistral, OpenRouter, DeepSeek, Together, Azure OpenAI v1 endpoints, ...).
export function openai({ baseUrl, apiKey, type }) {
  const official = type === 'openai';
  const base = trimSlash(baseUrl || 'https://api.openai.com/v1');
  const headers = apiKey ? { authorization: `Bearer ${apiKey}`, 'api-key': apiKey } : {};
  let jsonModeUnsupported = false;
  return {
    async chat({ model, system, messages, json, temperature = 0.3, maxTokens, onToken, signal }) {
      const body = { model, messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages], stream: !!onToken };
      if (official) {
        if (maxTokens) body.max_completion_tokens = maxTokens;
        if (/^gpt-4/.test(model)) body.temperature = temperature;
      } else {
        body.temperature = temperature;
        if (maxTokens) body.max_tokens = maxTokens;
      }
      if (onToken) body.stream_options = { include_usage: true };
      if (json && !jsonModeUnsupported) body.response_format = { type: 'json_object' };
      let r;
      try {
        r = await request(`${base}/chat/completions`, { headers, body, signal });
      } catch (e) {
        // Some compatible servers reject response_format / stream_options; retry once without them.
        if (e.status === 400 && (body.response_format || body.stream_options)) {
          jsonModeUnsupported = !!body.response_format;
          delete body.response_format; delete body.stream_options;
          r = await request(`${base}/chat/completions`, { headers, body, signal });
        } else throw e;
      }
      if (!onToken) {
        const d = await r.json();
        return { text: stripThink(d.choices?.[0]?.message?.content), usage: { input: d.usage?.prompt_tokens || 0, output: d.usage?.completion_tokens || 0 } };
      }
      let text = '', usage = { input: 0, output: 0 };
      const emit = thinkFilter(onToken);
      for await (const d of sseData(r)) {
        const t = d.choices?.[0]?.delta?.content || '';
        if (t) { text += t; emit(t); }
        if (d.usage) usage = { input: d.usage.prompt_tokens || 0, output: d.usage.completion_tokens || 0 };
      }
      emit.flush();
      return { text: stripThink(text), usage };
    },
    async embed({ model, input, signal }) {
      const r = await request(`${base}/embeddings`, { headers, body: { model, input }, signal });
      const d = await r.json();
      return d.data.sort((a, b) => a.index - b.index).map((x) => x.embedding);
    },
    async listModels() {
      const r = await request(`${base}/models`, { method: 'GET', headers, timeoutMs: 15e3 });
      const d = await r.json();
      return (d.data || []).map((m) => ({ id: m.id, embedding: /embed/i.test(m.id) })).sort((a, b) => a.id.localeCompare(b.id));
    },
  };
}
