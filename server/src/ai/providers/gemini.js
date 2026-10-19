import { request, sseData, trimSlash } from './http.js';

export function gemini({ baseUrl, apiKey }) {
  const base = trimSlash(baseUrl || 'https://generativelanguage.googleapis.com/v1beta');
  const headers = { 'x-goog-api-key': apiKey || '' };
  const toContents = (messages) => messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const usageOf = (u) => ({ input: u?.promptTokenCount || 0, output: u?.candidatesTokenCount || 0 });
  const textOf = (d) => (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  return {
    async chat({ model, system, messages, json, temperature = 0.3, maxTokens, onToken, signal }) {
      const body = { contents: toContents(messages), generationConfig: { temperature, ...(maxTokens ? { maxOutputTokens: maxTokens } : {}) } };
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      if (json) body.generationConfig.responseMimeType = 'application/json';
      if (!onToken) {
        const r = await request(`${base}/models/${model}:generateContent`, { headers, body, signal });
        const d = await r.json();
        return { text: textOf(d), usage: usageOf(d.usageMetadata) };
      }
      const r = await request(`${base}/models/${model}:streamGenerateContent?alt=sse`, { headers, body, signal });
      let text = '', usage = { input: 0, output: 0 };
      for await (const d of sseData(r)) {
        const t = textOf(d);
        if (t) { text += t; onToken(t); }
        if (d.usageMetadata) usage = usageOf(d.usageMetadata);
      }
      return { text, usage };
    },
    async embed({ model, input }) {
      const r = await request(`${base}/models/${model}:batchEmbedContents`, {
        headers, body: { requests: input.map((text) => ({ model: `models/${model}`, content: { parts: [{ text }] } })) },
      });
      const d = await r.json();
      return d.embeddings.map((e) => e.values);
    },
    async listModels() {
      const r = await request(`${base}/models?pageSize=200`, { method: 'GET', headers, timeoutMs: 15e3 });
      const d = await r.json();
      return (d.models || []).map((m) => ({ id: m.name.replace(/^models\//, ''), name: m.displayName, embedding: (m.supportedGenerationMethods || []).includes('embedContent') }));
    },
  };
}
