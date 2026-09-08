// Manual, network-hitting Grok smoke test (NOT part of `node test/run.mjs`).
// It exercises the app's real streaming code path (src/providers.js → streamChat).
//
//   With a key (recommended — tests the full round-trip):
//     XAI_API_KEY=your-key node test/grok_live.mjs
//   Without a key (keyless diagnosis of xAI's current web-search endpoints):
//     node test/grok_live.mjs
//
// The key is read from the environment only; it is never printed.

globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.navigator ??= { language: 'en' };

const KEY = process.env.XAI_API_KEY || '';
const MODEL = process.env.GROK_MODEL || 'grok-4.6';
const BASE = 'https://api.x.ai/v1';

async function probe(label, path, body) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY || 'dummy-invalid-key'}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    console.log(`\n[${label}] HTTP ${res.status}`);
    console.log('  ' + text.slice(0, 240).replace(/\n/g, ' '));
  } catch (e) {
    console.log(`\n[${label}] fetch failed: ${e.message}`);
  }
}

async function keylessDiagnosis() {
  console.log('No XAI_API_KEY set — running keyless endpoint diagnosis.');
  console.log('(A 400 "Incorrect API key" means the request shape is VALID; only the key is rejected.)');
  const msgs = [{ role: 'user', content: 'hi' }];
  const input = [{ role: 'user', content: 'hi' }];
  await probe('chat/completions plain', '/chat/completions', { model: MODEL, messages: msgs, stream: true });
  await probe('chat/completions + search_parameters (deprecated?)', '/chat/completions',
    { model: MODEL, messages: msgs, stream: true, search_parameters: { mode: 'auto' } });
  await probe('responses + web_search tool (current method)', '/responses',
    { model: MODEL, stream: true, input, tools: [{ type: 'web_search' }] });
}

async function liveTest() {
  const { streamChat } = await import('../src/providers.js');
  const model = { id: 'grok', type: 'grok', label: 'Grok', apiKey: KEY, baseUrl: BASE, model: MODEL, vision: true };

  for (const webSearch of [false, true]) {
    const q = webSearch ? 'In one sentence, what did xAI announce most recently?' : 'Reply with exactly: pong';
    console.log(`\n=== streamChat(webSearch=${webSearch}) — "${q}" ===`);
    let out = '';
    const citations = [];
    try {
      const res = await streamChat(model, [{ role: 'user', content: q }], {
        webSearch,
        onChunk: (d) => { out += d; process.stdout.write(d); },
        onCitations: (urls) => { for (const u of urls) citations.push(u.url || u); },
        onRetry: (attempt, delay) => console.log(`\n  …retry ${attempt} in ${Math.round(delay / 1000)}s`),
      });
      console.log(`\n  -> OK, ${res.length} chars${citations.length ? `, ${citations.length} citation(s)` : ''}`);
      if (citations.length) console.log('  citations: ' + citations.slice(0, 5).join(', '));
    } catch (e) {
      console.log(`\n  -> FAILED: ${e.message}`);
    }
  }
}

if (KEY) await liveTest(); else await keylessDiagnosis();
