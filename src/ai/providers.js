// ai/providers.js — one call shape for several AI providers:
//   complete({ provider, model, key, baseUrl, system, prompt, maxTokens })
//     → { text, inTokens, outTokens, refused }
// Providers:
//   anthropic — Claude, through the official SDK (@anthropic-ai/sdk). Opus/Sonnet
//               requests opt into the API's refusal fallback.
//   google    — Gemini, through Google's generateContent REST endpoint.
//   openai    — any OpenAI-compatible chat completions endpoint (OpenAI and
//               the many services and local servers that speak the same API);
//               baseUrl defaults to https://api.openai.com/v1.
import Anthropic from '@anthropic-ai/sdk';

export const PROVIDERS = {
  anthropic: { label: 'Anthropic (Claude)', defaultModel: 'claude-opus-5-5', needsKey: true },
  google:    { label: 'Google (Gemini)', defaultModel: '', needsKey: true },
  openai:    { label: 'OpenAI-compatible', defaultModel: '', needsKey: false, baseUrl: 'https://api.openai.com/v1' },
};
// Known list prices per million tokens (input / output), for the cost estimate.
export const KNOWN_PRICES = {
  'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5],
};

let anthropicClient = null, anthropicKey = null;

export async function complete({ provider, model, key, baseUrl, system, prompt, maxTokens = 2000, fetchImpl = fetch, anthropic = null }) {
  if (provider === 'anthropic') {
    if (!anthropic) {
      if (!anthropicClient || anthropicKey !== key) { anthropicClient = new Anthropic({ apiKey: key, maxRetries: 1, timeout: 30_000 }); anthropicKey = key; }
      anthropic = anthropicClient;
    }
    const req = { model, max_tokens: maxTokens, output_config: { effort: 'low' }, system, messages: [{ role: 'user', content: prompt }] };
    const fallback = /^claude-(opus|sonnet)-/.test(model);
    const res = fallback
      ? await anthropic.beta.messages.create({ ...req, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : await anthropic.messages.create(req);
    const u = res.usage ?? {};
    return {
      text: res.content.filter(b => b.type === 'text').map(b => b.text).join(' '),
      inTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      outTokens: u.output_tokens ?? 0,
      refused: res.stop_reason === 'refusal',
    };
  }
  if (provider === 'google') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const res = await fetchImpl(url, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens } }),
      signal: AbortSignal.timeout(30_000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw httpError(res.status, j?.error?.message);
    const cand = j.candidates?.[0];
    return {
      text: (cand?.content?.parts ?? []).map(p => p.text ?? '').join(' '),
      inTokens: j.usageMetadata?.promptTokenCount ?? 0, outTokens: j.usageMetadata?.candidatesTokenCount ?? 0,
      refused: !cand || cand.finishReason === 'SAFETY' || !!j.promptFeedback?.blockReason,
    };
  }
  if (provider === 'openai') {
    const base = (baseUrl || PROVIDERS.openai.baseUrl).replace(/\/+$/, '');
    const res = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(30_000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw httpError(res.status, j?.error?.message);
    const c = j.choices?.[0];
    return { text: c?.message?.content ?? '', inTokens: j.usage?.prompt_tokens ?? 0, outTokens: j.usage?.completion_tokens ?? 0, refused: c?.finish_reason === 'content_filter' };
  }
  throw new Error(`Unknown AI provider: ${provider}`);
}

function httpError(status, message) {
  const e = new Error(message || `HTTP ${status}`);
  e.status = status;
  return e;
}
