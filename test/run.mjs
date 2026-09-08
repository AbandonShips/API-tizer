// Minimal, dependency-free unit tests for the pure logic that's easiest to break
// silently (the PRICING regex table, cost/token math, the bilingual master-verdict
// parser, and the ensemble similarity bands).
//
//   Run:  node test/run.mjs        (exits 1 on any failure)
//
// No package.json or test framework is needed — Node treats .mjs as ESM. The app
// stays browser-only; this just imports the pure modules directly.

// state.js → i18n.js reads navigator/localStorage (inside try/catch). Pin them so
// the import is deterministic across Node versions.
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.navigator ??= { language: 'ko' };

import { priceFor, effectivePrice, estimateCost, estimateTokens, checkPricingConsistency } from '../src/state.js';
import { masterVerdict, similaritySignal, buildShareSnapshot } from '../src/analysis.js';
import { errorDetail, isBillingExhausted, isGrokFallbackable } from '../src/providers.js';
import { renderMarkdown } from '../src/markdown.js';

let passed = 0, failed = 0;
const fails = [];
function ok(cond, msg) { if (cond) passed++; else { failed++; fails.push(msg); } }
function eqJSON(actual, expected, msg) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${msg} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// ---- state.js: PRICING table (regex order is fragile — more specific must win) ----
eqJSON(priceFor('gemini-3.5-flash-lite'), { in: 0.30, out: 2.50 }, 'gemini-3.5-flash-lite must precede gemini-3.5-flash');
eqJSON(priceFor('gemini-3.5-flash'), { in: 1.50, out: 9.00 }, 'gemini-3.5-flash price');
eqJSON(priceFor('gemini-3.6-flash'), { in: 1.50, out: 7.50 }, 'gemini-3.6-flash price');
eqJSON(priceFor('gemini-3.7-flash'), { in: 1.50, out: 7.50 }, 'gemini-3.7-flash price');
eqJSON(priceFor('gemini-3.8-flash'), { in: 1.50, out: 7.50 }, 'gemini-3.8-flash must precede the generic gemini flash fallback');
eqJSON(priceFor('grok-4.6'), { in: 2.00, out: 6.00 }, 'grok-4.6 must precede the generic grok-4 pattern');
eqJSON(priceFor('gpt-5.4-mini'), { in: 0.75, out: 4.50 }, 'gpt-5.4-mini price');
eqJSON(priceFor('gpt-6-astra'), { in: 10.00, out: 50.00 }, 'gpt-6-astra price');
eqJSON(priceFor('gpt-5.6-terra'), { in: 2.00, out: 12.00 }, 'gpt-5.6-terra price');
eqJSON(priceFor('gpt-5.6-luna'), { in: 0.20, out: 1.20 }, 'gpt-5.6-luna price');
eqJSON(priceFor('claude-opus-5'), { in: 5.00, out: 25.00 }, 'claude-opus-5 price');
eqJSON(priceFor('claude-fable-5-1'), { in: 10.00, out: 50.00 }, 'claude-fable-5-1 price');
eqJSON(priceFor('claude-sonnet-5'), { in: 2.00, out: 10.00 }, 'claude-sonnet-5 must precede the generic sonnet fallback');
ok(priceFor('totally-unknown-model') === null, 'unknown model → null price');

// effectivePrice: an object override wins over the name table
eqJSON(effectivePrice({ model: 'whatever', priceIn: 2, priceOut: 8 }), { in: 2, out: 8 }, 'effectivePrice honors object override');

// estimateCost: (in*pin + out*pout) / 1e6
ok(Math.abs(estimateCost({ model: 'x', priceIn: 1, priceOut: 2 }, 1_000_000, 1_000_000) - 3) < 1e-9, 'estimateCost math');
ok(estimateCost('totally-unknown-model', 100, 100) === null, 'estimateCost → null for unknown');

// estimateTokens: ~chars / 3
ok(estimateTokens('') === 0, 'estimateTokens("") → 0');
ok(estimateTokens('abcdef') === 2, 'estimateTokens(6 chars) → 2');

// ---- The critical guard: every preset price matches the PRICING table ----
eqJSON(checkPricingConsistency(), [], 'MODEL_PRESETS ↔ PRICING: no drift');

// ---- analysis.js: masterVerdict (bilingual parser) ----
const verdict = (text, status = 'done') => masterVerdict({ master: { status, text } });
eqJSON(verdict('answer\n\n### 소수 의견\n특이한 소수 의견 없음'), { state: 'consensus' }, 'ko sentinel → consensus');
eqJSON(verdict('answer\n\n### Minority opinion\nNo notable minority opinion'), { state: 'consensus' }, 'en sentinel → consensus');
ok(verdict('answer\n\n### 소수 의견\nGrok은 답이 다르다고 봄').state === 'dissent', 'ko real dissent → dissent');
ok(verdict('answer\n\n### Minority opinion\nClaude disagrees about the date').state === 'dissent', 'en real dissent → dissent');
ok(verdict('just an answer, no section') === null, 'no minority section → null');
ok(masterVerdict({ master: { status: 'streaming', text: '### 소수 의견\n없음' } }) === null, 'not done → null');

// ---- analysis.js: similaritySignal (agreement bands) ----
ok(similaritySignal(['hello world', 'hello world']).state === 'agree', 'identical answers → agree');
ok(similaritySignal(['aaaaaa', 'zzzzzz']).state === 'diverge', 'disjoint answers → diverge');
ok(similaritySignal(['only one answer']) === null, 'single answer → null (nothing to compare)');

// ---- providers.js: errorDetail (xAI shape has a STRING error, not {message}) ----
eqJSON(errorDetail(JSON.stringify({ code: 'permission-denied', error: 'Your team T has either used all available credits or reached its monthly spending limit.' })), 'Your team T has either used all available credits or reached its monthly spending limit.', 'xAI string error is extracted (no raw JSON blob)');
eqJSON(errorDetail(JSON.stringify({ error: { message: 'boom', code: 500 } })), 'boom', 'OpenAI-style {error:{message}} is extracted');
eqJSON(errorDetail(JSON.stringify({ message: 'm' })), 'm', 'top-level {message} is extracted');
eqJSON(errorDetail('plain text failure'), 'plain text failure', 'non-JSON body passes through');
eqJSON(errorDetail(''), '', 'empty body → empty detail');

// ---- providers.js: isBillingExhausted (xAI 403 permission-denied = pay up, not a key bug) ----
ok(isBillingExhausted(403, 'permission-denied — Your team T has either used all available credits or reached its monthly spending limit.') === true, 'xAI 403 credits message → billing');
ok(isBillingExhausted(403, 'Incorrect API key provided') === false, 'plain 403 without billing words → not billing');
ok(isBillingExhausted(402, 'anything') === true, '402 → billing regardless of body');
ok(isBillingExhausted(500, 'used all available credits') === false, 'billing words on 500 → not billing (status-gated)');

// ---- providers.js: isGrokFallbackable (auth/billing must NOT retry via plain chat) ----
ok(isGrokFallbackable(new Error('HTTP 403 Forbidden — permission-denied')) === false, 'Grok 403 → no chat-completions fallback');
ok(isGrokFallbackable(new Error('HTTP 401 Unauthorized — Incorrect API key')) === false, 'Grok 401 → no fallback');
ok(isGrokFallbackable(new Error('HTTP 410 Gone')) === true, 'Grok 410 (deprecated endpoint) → fallback still allowed');
ok(isGrokFallbackable(new Error('empty response')) === true, 'empty Responses result → fallback still allowed');

// ---- markdown.js: XSS safety (the renderer escapes everything first) ----
ok(!renderMarkdown('<script>alert(1)</script>').includes('<script>'), 'raw <script> is escaped');
ok(renderMarkdown('<script>alert(1)</script>').includes('&lt;script&gt;'), '<script> becomes &lt;script&gt;');
ok(!renderMarkdown('<img src=x onerror=alert(1)>').includes('<img'), 'raw <img onerror> is escaped');
ok(!/href=["']javascript:/i.test(renderMarkdown('[x](javascript:alert(1))')), 'javascript: markdown link is not turned into an href');
ok(!/href=["']javascript:/i.test(renderMarkdown('see javascript:alert(1) here')), 'bare javascript: is not autolinked');
ok(!renderMarkdown('```\n<script>alert(1)</script>\n```').includes('<script>'), 'code fence re-escapes <script>');
{
  const out = renderMarkdown('[ok](https://example.com)');
  ok(out.includes('href="https://example.com"') && out.includes('rel="noopener noreferrer"') && out.includes('target="_blank"'), 'safe http link gets rel=noopener + target=_blank');
}
ok(renderMarkdown('visit https://example.com now').includes('<a href="https://example.com"'), 'bare https URL is autolinked');
ok(!renderMarkdown('[x](https://e.com" onmouseover="alert(1))').includes('onmouseover="'), 'a quote inside the URL cannot break out of the href attribute');

// ---- markdown.js: <br> line break + h4–h6 headings ----
ok(renderMarkdown('a<br>b').includes('<br/>'), '<br> becomes a real line break');
ok(!renderMarkdown('a<br>b').includes('&lt;br&gt;'), '<br> is not shown as escaped text');
ok(renderMarkdown('a<br />b').includes('<br/>'), '<br /> (slash/space) also becomes a line break');
ok(renderMarkdown('#### Sub').includes('<h4>'), '#### renders as <h4>');
ok(renderMarkdown('###### Deep').includes('<h6>'), '###### renders as <h6>');
ok(!renderMarkdown('x<br onload=alert(1)>y').includes('<br onload'), '<br> with attributes stays escaped (no attribute injection)');

// ---- analysis.js: buildShareSnapshot (share-link projection; must never leak secrets) ----
{
  const chat = { title: 'My chat', createdAt: 111 };
  const turns = [
    {
      id: 't1', createdAt: 1, user: 'hi',
      attachments: [{ name: 'a.png', kind: 'image', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }],
      modelIds: ['openai', 'anthropic'],
      models: {
        openai: { id: 'openai', label: 'ChatGPT', model: 'gpt-x', type: 'openai', apiKey: 'SECRETKEY1' },
        anthropic: { id: 'anthropic', label: 'Claude', model: 'claude-x', type: 'anthropic', apiKey: 'SECRETKEY2' },
        master1: { id: 'master1', label: 'ChatGPT', model: 'gpt-x', type: 'openai' },
      },
      responses: {
        openai: { status: 'done', text: 'A1', citations: [{ url: 'https://x.com', title: 'X' }] },
        anthropic: { status: 'error', error: 'boom' },
      },
      masterEnabled: true, masterId: 'master1',
      master: { status: 'done', text: 'MASTER', by: 'master1' },
      crossCheck: { status: 'done', text: 'CC', by: 'openai' },
    },
    { kind: 'compaction', summary: 'old stuff', compactedCount: 4, coversUpTo: 0 },
  ];

  const textOnly = buildShareSnapshot(chat, turns, { includeImages: false, now: 999 });
  ok(textOnly.v === 1 && textOnly.title === 'My chat' && textOnly.createdAt === 111 && textOnly.sharedAt === 999, 'snapshot carries title/createdAt/sharedAt inside');
  ok(textOnly.turns[0].attachments[0].dataUrl === undefined, 'text-only snapshot drops image dataUrls');
  ok(textOnly.turns[0].answers.length === 2 && textOnly.turns[0].answers[0].text === 'A1', 'answers projected');
  ok(textOnly.turns[0].answers[0].citations && textOnly.turns[0].answers[0].citations[0].url === 'https://x.com', 'citations normalized');
  ok(textOnly.turns[0].answers[1].status === 'error' && textOnly.turns[0].answers[1].text === '' && textOnly.turns[0].answers[1].error === 'boom', 'error answer keeps error, drops text');
  ok(textOnly.turns[0].master.text === 'MASTER' && textOnly.turns[0].master.label === 'ChatGPT', 'master projected');
  ok(textOnly.turns[0].crossCheck.text === 'CC', 'crossCheck projected');
  ok(textOnly.turns[1].kind === 'compaction' && textOnly.turns[1].summary === 'old stuff', 'compaction marker preserved');
  ok(!JSON.stringify(textOnly).includes('SECRETKEY'), 'snapshot NEVER contains API keys');

  const withImages = buildShareSnapshot(chat, turns, { includeImages: true, now: 1 });
  ok(withImages.turns[0].attachments[0].dataUrl === 'data:image/png;base64,AAAA', 'include-images snapshot keeps image dataUrls');
}

// ---- report ----
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.error('FAILURES:\n - ' + fails.join('\n - ')); process.exit(1); }
