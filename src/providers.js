// Streaming chat adapters for each provider.
// Common message format: [{ role: 'system'|'user'|'assistant', content }]
// streamChat(model, messages, { signal, onChunk }) -> Promise<fullText>
import { t } from './i18n.js';

async function* sseLines(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      yield line;
    }
  }
  if (buffer) yield buffer;
}

async function readError(response) {
  let detail = '';
  try {
    const text = await response.text();
    try { detail = JSON.parse(text)?.error?.message || JSON.parse(text)?.message || text; }
    catch { detail = text; }
  } catch { /* ignore */ }
  return `HTTP ${response.status} ${response.statusText}${detail ? ' — ' + detail.slice(0, 300) : ''}`;
}

// Split a data URL (data:image/png;base64,XXXX) into mime + base64 payload.
function splitDataUrl(url) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url || '');
  return m ? { mime: m[1], data: m[2] } : null;
}
function hasImages(m) { return Array.isArray(m.images) && m.images.length > 0; }

// Normalise a provider's citation array into [{ url, title }], deduped by url.
function normalizeCitations(citations) {
  if (!citations || !citations.length) return [];
  const seen = new Set();
  const out = [];
  for (const c of citations) {
    const url = typeof c === 'string' ? c : (c && (c.url || c.uri));
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = (c && typeof c === 'object' && c.title) ? c.title : '';
    out.push({ url, title });
  }
  return out;
}

// ---------- OpenAI-compatible (OpenAI, Grok, local Ollama/LM Studio) ----------
function openAIContent(m) {
  if (!hasImages(m)) return m.content;
  const parts = [];
  if (m.content) parts.push({ type: 'text', text: m.content });
  for (const url of m.images) parts.push({ type: 'image_url', image_url: { url } });
  return parts;
}

async function streamOpenAICompatible(model, messages, { signal, onChunk, onCitations, onActivity, webSearch }) {
  const base = (model.baseUrl || '').replace(/\/$/, '');
  const body = {
    model: model.model,
    messages: messages.map((m) => ({ role: m.role, content: openAIContent(m) })),
    stream: true,
  };
  // xAI/Grok Live Search: enable native web+X search (model decides when) and ask for
  // citations. This is xAI's documented search_parameters on /chat/completions — not the
  // OpenAI Responses `web_search` tool, which xAI ignores and streams back empty.
  if (webSearch && model.type === 'grok') {
    body.search_parameters = { mode: 'auto', return_citations: true };
  }
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...(model.apiKey ? { Authorization: `Bearer ${model.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(await readError(res));

  let full = '';
  let citations = null;
  for await (const line of sseLines(res)) {
    onActivity?.();
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') break;
    if (!data) continue;
    try {
      const json = JSON.parse(data);
      if (Array.isArray(json.citations)) citations = json.citations;
      const delta = json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.message?.content ?? '';
      if (delta) { full += delta; onChunk?.(delta, full); }
    } catch { /* partial json, ignore */ }
  }
  const urls = normalizeCitations(citations);
  if (urls.length) onCitations?.(urls);
  return full;
}

// ---------- OpenAI Responses API (web search tool) ----------
function responsesInput(messages) {
  // Convert chat messages -> Responses API input items. System -> instructions.
  const items = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const isUser = m.role !== 'assistant';
    // Only user turns carry images in this app; assistant turns are always plain
    // text. Guard on isUser so an assistant message is never mislabeled as user.
    if (isUser && hasImages(m)) {
      const content = [];
      if (m.content) content.push({ type: 'input_text', text: m.content });
      for (const url of m.images) content.push({ type: 'input_image', image_url: url });
      items.push({ role: 'user', content });
    } else {
      items.push({
        role: isUser ? 'user' : 'assistant',
        content: [{ type: isUser ? 'input_text' : 'output_text', text: m.content || '' }],
      });
    }
  }
  return items;
}

async function streamOpenAIResponses(model, messages, { signal, onChunk, onCitations, onActivity }) {
  const base = (model.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const instructions = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const res = await fetch(`${base}/responses`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...(model.apiKey ? { Authorization: `Bearer ${model.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: model.model,
      ...(instructions ? { instructions } : {}),
      tools: [{ type: 'web_search' }],
      input: responsesInput(messages),
      stream: true,
    }),
  });
  if (!res.ok || !res.body) throw new Error(await readError(res));

  let full = '';
  const cites = [];
  const pushCite = (ann) => {
    if (!ann) return;
    const url = ann.url || ann.uri;
    if (url) cites.push({ url, title: ann.title || '' });
  };
  for await (const line of sseLines(res)) {
    onActivity?.();
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const json = JSON.parse(data);
      if (json.type === 'response.output_text.delta' && json.delta) {
        full += json.delta; onChunk?.(json.delta, full);
      }
      // url_citation annotations: handle the several shapes the API emits.
      if (json.type === 'response.output_text.annotation.added') {
        pushCite(json.annotation || json.delta);
      }
      // Final event carries the full output with all annotations — harvest any
      // we might have missed during streaming.
      if (json.type === 'response.completed' && json.response?.output) {
        for (const item of json.response.output) {
          for (const part of (item.content || [])) {
            for (const ann of (part.annotations || [])) {
              if (ann.type === 'url_citation' || ann.url) pushCite(ann);
            }
          }
        }
      }
    } catch { /* ignore */ }
  }
  const urls = normalizeCitations(cites);
  if (urls.length) onCitations?.(urls);
  return full;
}

// ---------- Anthropic (Claude) ----------
function anthropicContent(m) {
  if (!hasImages(m)) return m.content;
  const parts = [];
  for (const url of m.images) {
    const s = splitDataUrl(url);
    if (s) parts.push({ type: 'image', source: { type: 'base64', media_type: s.mime, data: s.data } });
  }
  if (m.content) parts.push({ type: 'text', text: m.content });
  return parts;
}

async function streamAnthropic(model, messages, { signal, onChunk, onCitations, webSearch, maxTokens, onActivity }) {
  const base = (model.baseUrl || 'https://api.anthropic.com/v1').replace(/\/$/, '');
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const convo = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: anthropicContent(m) }));

  const body = {
    model: model.model,
    max_tokens: maxTokens && maxTokens > 0 ? maxTokens : 8192,
    ...(system ? { system } : {}),
    messages: convo,
    stream: true,
  };
  if (webSearch) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];
  }
  const res = await fetch(`${base}/messages`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': model.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(await readError(res));

  let full = '';
  const cites = [];
  for await (const line of sseLines(res)) {
    onActivity?.();
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    try {
      const json = JSON.parse(data);
      if (json.type === 'content_block_delta' && json.delta?.text) {
        full += json.delta.text;
        onChunk?.(json.delta.text, full);
      }
      // web_search_tool_result blocks carry the visited URLs
      if (json.type === 'content_block_start' && json.content_block?.type === 'web_search_tool_result') {
        const r = json.content_block.content;
        if (Array.isArray(r)) for (const item of r) { if (item?.url) cites.push(item.url); }
      }
      const cit = json.delta?.citation || json.content_block?.citations;
      if (cit) {
        const arr = Array.isArray(cit) ? cit : [cit];
        for (const c of arr) { if (c?.url) cites.push(c.url); }
      }
    } catch { /* ignore */ }
  }
  const urls = normalizeCitations(cites);
  if (urls.length) onCitations?.(urls);
  return full;
}

// ---------- Google Gemini ----------
function geminiParts(m) {
  const parts = [];
  if (m.content) parts.push({ text: m.content });
  if (hasImages(m)) {
    for (const url of m.images) {
      const s = splitDataUrl(url);
      if (s) parts.push({ inlineData: { mimeType: s.mime, data: s.data } });
    }
  }
  return parts.length ? parts : [{ text: '' }];
}

async function streamGemini(model, messages, { signal, onChunk, onCitations, webSearch, onActivity }) {
  const base = (model.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: geminiParts(m) }));

  const body = {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents,
  };
  // Google Search grounding via the google_search tool (Gemini 2.x and 3.x).
  if (webSearch) body.tools = [{ google_search: {} }];

  const url = `${base}/models/${encodeURIComponent(model.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(model.apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(await readError(res));

  let full = '';
  let citations = null;
  for await (const line of sseLines(res)) {
    onActivity?.();
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    try {
      const json = JSON.parse(data);
      const cand = json.candidates?.[0];
      const parts = cand?.content?.parts || [];
      for (const p of parts) {
        if (p.text) { full += p.text; onChunk?.(p.text, full); }
      }
      const chunks = cand?.groundingMetadata?.groundingChunks;
      if (Array.isArray(chunks)) {
        // Gemini returns vertexaisearch redirect URLs — show the source title
        // instead so the list isn't 13× the same domain.
        citations = chunks
          .filter((c) => c?.web?.uri)
          .map((c) => ({ url: c.web.uri, title: c.web.title || '' }));
      }
    } catch { /* ignore */ }
  }
  const urls = normalizeCitations(citations);
  if (urls.length) onCitations?.(urls);
  return full;
}

function streamChatOnce(model, messages, opts = {}) {
  switch (model.type) {
    case 'anthropic': return streamAnthropic(model, messages, opts);
    case 'gemini': return streamGemini(model, messages, opts);
    case 'openai':
      // OpenAI web search runs through the Responses API (web_search tool).
      if (opts.webSearch) return streamOpenAIResponses(model, messages, opts);
      return streamOpenAICompatible(model, messages, opts);
    case 'grok':
      // xAI is OpenAI-compatible; web search uses its native search_parameters on
      // /chat/completions (handled in streamOpenAICompatible), which returns citations
      // inline. Routing Grok through the OpenAI Responses `web_search` tool came back empty.
      return streamOpenAICompatible(model, messages, opts);
    case 'local':
    default: return streamOpenAICompatible(model, messages, opts);
  }
}

// Transient upstream hiccups — e.g. Gemini's "high demand" / "model is overloaded" (503) or
// 429 rate limits — are common when a popular model (like gemini-3.6-flash) is busy, and they
// clear on their own. These spikes are server-side (they hit paid tiers too), so auto-retry a
// couple of times with a few seconds' backoff — but ONLY before any tokens have streamed (so
// output is never duplicated), never on auth/bad-request errors, and never after the user Stops.
const RETRYABLE_ERR = /HTTP (408|409|425|429|500|502|503|504|529)\b|overloaded|high demand|UNAVAILABLE|RESOURCE_EXHAUSTED|Failed to fetch|NetworkError|network error|ECONNRESET|ETIMEDOUT/i;

function retryDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
}

// Combine per-attempt error messages: identical errors collapse to one; distinct errors are
// listed in order so a "503 then 409 then 409" surfaces both causes to the user.
function combineErrors(errs) {
  const distinct = [];
  for (const e of errs) if (!distinct.includes(e)) distinct.push(e);
  if (distinct.length === 1) return distinct[0];
  return t('ext.all_attempts_failed', { n: errs.length }) + ' · ' + distinct.map((e, i) => `(${i + 1}) ${e}`).join(' · ');
}

const EMPTY_RESP = t('ext.empty_resp');

export async function streamChat(model, messages, opts = {}) {
  const maxAttempts = 3; // up to 2 retries on transient failures — for ANY provider (incl. local)
  let emitted = false;
  const wrapped = { ...opts, onChunk: (d, f) => { emitted = true; opts.onChunk?.(d, f); } };
  const errs = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let err = null;
    try {
      const result = await streamChatOnce(model, messages, wrapped);
      if (result && result.trim()) return result; // success (even after earlier errors) → return normally
      // Some servers reply 200 with an empty stream during hiccups (no error code). Treat a
      // blank result as a transient failure so it retries too — instead of silently showing nothing.
      err = new Error(EMPTY_RESP);
    } catch (e) {
      err = e;
    }
    const msg = String(err?.message || err);
    const retryable = msg === EMPTY_RESP || RETRYABLE_ERR.test(msg);
    errs.push(msg);
    // Stop once tokens started (avoid duplicates), on abort, on the last attempt, or for a
    // non-transient error. When retries are exhausted with multiple distinct errors, combine.
    if (emitted || opts.signal?.aborted || attempt >= maxAttempts || !retryable) {
      throw (attempt >= maxAttempts && errs.length > 1) ? new Error(combineErrors(errs)) : err;
    }
    const delay = (attempt === 1 ? 3000 : 5000) + Math.floor(Math.random() * 1000); // ~3s then ~5s (+jitter)
    opts.onRetry?.(attempt, delay);
    await retryDelay(delay, opts.signal);
  }
  throw new Error(combineErrors(errs)); // unreachable (loop always returns/throws) — keeps control flow total
}

// Which provider types support built-in web search in this app.
export const WEB_SEARCH_TYPES = new Set(['openai', 'anthropic', 'gemini', 'grok']);
export function supportsWebSearch(model) {
  return WEB_SEARCH_TYPES.has(model.type);
}
