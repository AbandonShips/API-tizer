// Streaming chat adapters for each provider.
// Common message format: [{ role: 'system'|'user'|'assistant', content }]
// streamChat(model, messages, { signal, onChunk }) -> Promise<fullText>

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

async function streamOpenAICompatible(model, messages, { signal, onChunk, onCitations }) {
  const base = (model.baseUrl || '').replace(/\/$/, '');
  const body = {
    model: model.model,
    messages: messages.map((m) => ({ role: m.role, content: openAIContent(m) })),
    stream: true,
  };
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
    if (hasImages(m)) {
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

async function streamOpenAIResponses(model, messages, { signal, onChunk, onCitations }) {
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

async function streamAnthropic(model, messages, { signal, onChunk, onCitations, webSearch }) {
  const base = (model.baseUrl || 'https://api.anthropic.com/v1').replace(/\/$/, '');
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const convo = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: anthropicContent(m) }));

  const body = {
    model: model.model,
    max_tokens: 4096,
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

async function streamGemini(model, messages, { signal, onChunk, onCitations, webSearch }) {
  const base = (model.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: geminiParts(m) }));

  const body = {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents,
  };
  // Google Search grounding (works on Gemini 2.x models).
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

export function streamChat(model, messages, opts = {}) {
  switch (model.type) {
    case 'anthropic': return streamAnthropic(model, messages, opts);
    case 'gemini': return streamGemini(model, messages, opts);
    case 'openai':
    case 'grok':
      // OpenAI & xAI/Grok web search both run through the Responses API.
      // (Grok's old Chat Completions `search_parameters` was deprecated → HTTP 410.)
      if (opts.webSearch) return streamOpenAIResponses(model, messages, opts);
      return streamOpenAICompatible(model, messages, opts);
    case 'local':
    default: return streamOpenAICompatible(model, messages, opts);
  }
}

// Which provider types support built-in web search in this app.
export const WEB_SEARCH_TYPES = new Set(['openai', 'anthropic', 'gemini', 'grok']);
export function supportsWebSearch(model) {
  return WEB_SEARCH_TYPES.has(model.type);
}
