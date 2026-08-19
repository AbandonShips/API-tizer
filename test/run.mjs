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
eqJSON(priceFor('gemini-3.7-flash'), { in: 1.50, out: 7.50 }, 'gemini-3.7-flash must precede the generic gemini flash fallback');
eqJSON(priceFor('grok-4.6'), { in: 2.00, out: 6.00 }, 'grok-4.6 must precede the generic grok-4 pattern');
eqJSON(priceFor('gpt-5.4-mini'), { in: 0.75, out: 4.50 }, 'gpt-5.4-mini price');
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
