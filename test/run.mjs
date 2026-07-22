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
import { masterVerdict, similaritySignal } from '../src/analysis.js';
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

// ---- report ----
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.error('FAILURES:\n - ' + fails.join('\n - ')); process.exit(1); }
