import { ollama } from './ollama.js';
import { openai } from './openai.js';
import { anthropic } from './anthropic.js';
import { gemini } from './gemini.js';
import { mock } from './mock.js';

export const PROVIDER_TYPES = {
  ollama: { label: 'Ollama (self-hosted)', defaultBaseUrl: 'http://localhost:11434', needsKey: false, defaultModel: 'llama3.1:8b', defaultEmbed: 'nomic-embed-text', local: true },
  openai: { label: 'OpenAI', defaultBaseUrl: 'https://api.openai.com/v1', needsKey: true, defaultModel: 'gpt-4.1-mini', defaultEmbed: 'text-embedding-3-small' },
  'openai-compatible': { label: 'OpenAI-compatible (LM Studio, vLLM, Groq, Mistral, OpenRouter, ...)', defaultBaseUrl: 'http://localhost:1234/v1', needsKey: false, defaultModel: '', defaultEmbed: '' },
  anthropic: { label: 'Anthropic Claude', defaultBaseUrl: 'https://api.anthropic.com', needsKey: true, defaultModel: 'claude-haiku-5-5', defaultEmbed: null },
  gemini: { label: 'Google Gemini', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta', needsKey: true, defaultModel: 'gemini-2.5-flash', defaultEmbed: 'gemini-embedding-001' },
  mock: { label: 'Built-in demo (no AI, for testing)', defaultBaseUrl: '', needsKey: false, defaultModel: 'mock', defaultEmbed: 'mock', local: true, hidden: true },
};

export function makeProvider({ type, baseUrl, apiKey }) {
  switch (type) {
    case 'ollama': return ollama({ baseUrl, apiKey });
    case 'openai': case 'openai-compatible': return openai({ baseUrl, apiKey, type });
    case 'anthropic': return anthropic({ baseUrl, apiKey });
    case 'gemini': return gemini({ baseUrl, apiKey });
    case 'mock': return mock();
    default: throw new Error(`Unknown provider type ${type}`);
  }
}

// True when the endpoint is on this machine or a private network (used by privacy mode).
export function isLocalEndpoint(type, baseUrl) {
  if (type === 'mock') return true;
  try {
    const h = new URL(baseUrl || PROVIDER_TYPES[type]?.defaultBaseUrl).hostname;
    return h === 'localhost' || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.internal') || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h);
  } catch { return false; }
}
