// Settings shape & helpers. Persistence is handled by main.js, which encrypts
// each user's settings with their password-derived key (see crypto.js).
import { t } from './i18n.js';

// App version — shown on the login screen (index.html #authVersion). Keep in sync with
// the README "변경 사항" changelog heading.
export const APP_VERSION = 'v1.5.4';

export const MODEL_META = {
  openai: { label: 'ChatGPT', color: 'var(--openai)', apiConsoleUrl: 'https://platform.openai.com/api-keys' },
  anthropic: { label: 'Claude', color: 'var(--claude)', apiConsoleUrl: 'https://console.anthropic.com/settings/keys' },
  gemini: { label: 'Gemini', color: 'var(--gemini)', apiConsoleUrl: 'https://aistudio.google.com/app/apikey' },
  grok: { label: 'Grok', color: 'var(--grok)', apiConsoleUrl: 'https://console.x.ai/' },
  local: { label: t('ext.local_label'), color: 'var(--local)' },
};

export const MAX_LOCAL = 3;

export const MODEL_PRESETS = {
  openai: [
    { model: 'gpt-6-astra', label: 'GPT-6 Astra', priceIn: 10, priceOut: 50, vision: true },
    { model: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', priceIn: 5, priceOut: 30, vision: true },
    { model: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', priceIn: 2, priceOut: 12, vision: true },
    { model: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', priceIn: 0.2, priceOut: 1.2, vision: true },
    { model: 'gpt-5.5', label: 'GPT-5.5', priceIn: 5, priceOut: 30, vision: true },
    { model: 'gpt-5.5-pro', label: 'GPT-5.5 Pro', priceIn: 30, priceOut: 180, vision: true },
    { model: 'gpt-5.4', label: 'GPT-5.4', priceIn: 2.5, priceOut: 15, vision: true },
    { model: 'gpt-5.4-pro', label: 'GPT-5.4 Pro', priceIn: 30, priceOut: 180, vision: true },
    { model: 'gpt-5.4-mini', label: 'GPT-5.4 mini', priceIn: 0.75, priceOut: 4.5, vision: true },
    { model: 'gpt-5.4-nano', label: 'GPT-5.4 nano', priceIn: 0.2, priceOut: 1.25, vision: true },
  ],
  anthropic: [
    { model: 'claude-fable-5-1', label: 'Claude Fable 5.1', priceIn: 10, priceOut: 50, vision: true },
    { model: 'claude-opus-5', label: 'Claude Opus 5', priceIn: 5, priceOut: 25, vision: true },
    { model: 'claude-fable-5', label: 'Claude Fable 5', priceIn: 10, priceOut: 50, vision: true },
    { model: 'claude-opus-4-8', label: 'Claude Opus 4.8', priceIn: 5, priceOut: 25, vision: true },
    { model: 'claude-sonnet-5', label: 'Claude Sonnet 5', priceIn: 2, priceOut: 10, vision: true },
    { model: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', priceIn: 1, priceOut: 5, vision: true },
  ],
  gemini: [
    { model: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', priceIn: 1.5, priceOut: 7.5, vision: true },
    { model: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', priceIn: 1.5, priceOut: 7.5, vision: true },
    { model: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', priceIn: 1.5, priceOut: 7.5, vision: true },
    { model: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', priceIn: 1.5, priceOut: 9, vision: true },
    { model: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', priceIn: 0.3, priceOut: 2.5, vision: true },
    { model: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview', priceIn: 2, priceOut: 12, vision: true },
    { model: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', priceIn: 0.25, priceOut: 1.5, vision: true },
    { model: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview', priceIn: 0.5, priceOut: 3, vision: true },
    { model: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', priceIn: 1.25, priceOut: 10, vision: true },
    { model: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', priceIn: 0.3, priceOut: 2.5, vision: true },
    { model: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', priceIn: 0.1, priceOut: 0.4, vision: true },
  ],
  grok: [
    { model: 'grok-4.6', label: 'Grok 4.6', priceIn: 2, priceOut: 6, vision: true },
    { model: 'grok-4.5', label: 'Grok 4.5', priceIn: 2, priceOut: 6, vision: true },
    { model: 'grok-4.3', label: 'Grok 4.3', priceIn: 1.25, priceOut: 2.5, vision: true },
  ],
};

export function modelPresetFor(type, modelName) {
  return (MODEL_PRESETS[type] || []).find((p) => p.model === modelName) || null;
}

export function defaultSettings() {
  return {
    customPrompt: '',
    richStyle: true,         // inject rich formatting instruction (emojis, tables, structure) so API responses feel closer to web ChatGPT
    timeoutMs: 120000,       // idle timeout for model responses & master summary (ms): the per-model timer resets on stream activity (incl. reasoning), so slow reasoning models aren't cut off. 0 or falsy to disable.
    maxTokens: 8192,         // max output tokens per response. Anthropic requires an explicit cap (was hardcoded 4096, which truncated long master summaries); other providers keep their own default.
    masterId: 'openai',
    masterEnabled: false,
    viewMode: 'split', // 'split' | 'unified'
    webSearchEnabled: true,  // composer-level web search toggle (on by default)
    showCost: true,          // show token/cost estimates
    autoLockMinutes: 60,     // idle auto-logout (0 = off)
    collapsedFolders: [],    // sidebar folder names that are collapsed (UI state, encrypted with the rest of settings)
    prompts: [],             // saved prompt library: [{ id, title, text }]
    models: [
      { id: 'openai', type: 'openai', label: 'ChatGPT', apiKey: '', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-luna', enabled: true, vision: true, priceIn: 0.2, priceOut: 1.2 },
      { id: 'anthropic', type: 'anthropic', label: 'Claude', apiKey: '', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5', enabled: true, vision: true, priceIn: 2, priceOut: 10 },
      { id: 'gemini', type: 'gemini', label: 'Gemini', apiKey: '', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.8-flash', enabled: true, vision: true, priceIn: 1.5, priceOut: 7.5 },
      { id: 'grok', type: 'grok', label: 'Grok', apiKey: '', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.6', enabled: true, vision: true, priceIn: 2, priceOut: 6 },
    ],
  };
}

// Merge a (possibly older / partial) parsed settings object with defaults.
export function normalizeSettings(parsed) {
  const base = defaultSettings();
  if (!parsed || typeof parsed !== 'object') return base;
  const models = (Array.isArray(parsed.models) && parsed.models.length ? parsed.models : base.models)
    .map((m) => ({
      ...m,
      vision: typeof m.vision === 'boolean'
        ? m.vision
        : (m.type === 'openai' || m.type === 'anthropic' || m.type === 'gemini' || m.type === 'grok'),
    }));
  const prompts = Array.isArray(parsed.prompts) ? parsed.prompts : [];
  const collapsedFolders = Array.isArray(parsed.collapsedFolders) ? parsed.collapsedFolders.filter((x) => typeof x === 'string') : [];
  return { ...base, ...parsed, models, prompts, collapsedFolders };
}

export function localCount(settings) {
  return settings.models.filter((m) => m.type === 'local').length;
}

export function makeLocalModel(index) {
  return {
    id: 'local-' + Date.now() + '-' + index,
    type: 'local',
    label: t('ext.local_model', { n: index }),
    apiKey: '',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.1',
    enabled: true,
    vision: false,
  };
}

export function enabledModels(settings) {
  return settings.models.filter((m) => m.enabled);
}

// ---------------------------------------------------------------------------
// Rough token & cost estimation (client-side, approximate — no API needed).
// Korean text averages fewer chars/token than English; ~3 chars/token is a
// reasonable mixed-language heuristic for display purposes only.
// ---------------------------------------------------------------------------
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.round(text.length / 3));
}

// Rough per-image prompt-token estimate for vision inputs. Real cost depends on
// each provider's tiling; ~1000 is a reasonable mixed default for display only.
export const IMAGE_TOKEN_ESTIMATE = 1000;

// Approximate USD pricing per 1M tokens (input, output). Matched by substring
// of the model name; falls back to null (cost hidden) for unknown models.
// Order matters: more specific patterns first.
const PRICING = [
  // OpenAI
  [/gpt-6-astra|gpt-6/i, 10.00, 50.00],
  [/gpt-5\.6-terra/i, 2.00, 12.00],
  [/gpt-5\.6-luna/i, 0.20, 1.20],
  [/gpt-5\.6-sol|gpt-5\.6/i, 5.00, 30.00],
  [/gpt-5\.5-pro/i, 30.00, 180.00],
  [/gpt-5\.5/i, 5.00, 30.00],
  [/gpt-5\.4-pro/i, 30.00, 180.00],
  [/gpt-5.*mini|gpt-4o-mini|gpt-4\.1-mini/i, 0.75, 4.50],
  [/gpt-5\.4-nano/i, 0.20, 1.25],
  [/gpt-5\.4/i, 2.50, 15.00],
  [/gpt-5|gpt-4o|gpt-4\.1/i, 2.50, 10.00],
  [/chat-latest/i, 5.00, 30.00],
  [/o4-mini|o3-mini/i, 1.10, 4.40],
  // Anthropic
  [/claude-fable-5|claude-mythos-5/i, 10.00, 50.00],
  [/claude.*haiku|haiku/i, 1.00, 5.00],
  [/claude.*opus|opus/i, 5.00, 25.00],
  [/claude-sonnet-5/i, 2.00, 10.00],
  [/claude.*sonnet|claude-3-7|sonnet/i, 3.00, 15.00],
  // Gemini
  [/gemini-3\.8-flash/i, 1.50, 7.50],
  [/gemini-3\.7-flash/i, 1.50, 7.50],
  [/gemini-3\.6-flash/i, 1.50, 7.50],
  [/gemini-3\.5-flash-lite/i, 0.30, 2.50],
  [/gemini-3\.5-flash/i, 1.50, 9.00],
  [/gemini-3\.1-pro/i, 2.00, 12.00],
  [/gemini-3\.1-flash-lite/i, 0.25, 1.50],
  [/gemini-3-flash/i, 0.50, 3.00],
  [/gemini-2\.5-flash-lite/i, 0.10, 0.40],
  [/gemini-2\.5-flash/i, 0.30, 2.50],
  [/gemini-2\.5-pro/i, 1.25, 10.00],
  [/gemini.*flash-lite|flash-8b/i, 0.075, 0.30],
  [/gemini.*flash/i, 1.50, 9.00],
  [/gemini.*pro/i, 1.25, 10.00],
  // xAI Grok
  [/grok-4\.6/i, 2.00, 6.00],
  [/grok-4\.5/i, 2.00, 6.00],
  [/grok-4\.3|grok-4|grok-3/i, 1.25, 2.50],
  [/grok-2|grok/i, 2.00, 10.00],
];

export function priceFor(modelName) {
  for (const [re, inp, out] of PRICING) {
    if (re.test(modelName || '')) return { in: inp, out: out };
  }
  return null;
}

// Effective price for a model object: a user-set override on the model wins,
// otherwise fall back to the built-in table matched by model name.
export function effectivePrice(model) {
  if (model && typeof model === 'object') {
    const pin = parseFloat(model.priceIn);
    const pout = parseFloat(model.priceOut);
    if (Number.isFinite(pin) && Number.isFinite(pout)) return { in: pin, out: pout };
    return priceFor(model.model);
  }
  return priceFor(model); // string model name
}

// Dev/test sanity check: every MODEL_PRESETS entry's priceIn/out should match what
// the PRICING table resolves for its model name. If they drift, a user who types the
// same model name by hand would be billed at a different rate than the preset (it
// usually means a new PRICING regex is missing or mis-ordered). Returns a list of
// mismatches ([] when consistent). See test/run.mjs and the dev boot check in main.js.
export function checkPricingConsistency() {
  const issues = [];
  for (const [type, presets] of Object.entries(MODEL_PRESETS)) {
    for (const p of presets) {
      const table = priceFor(p.model);
      if (!table) { issues.push({ type, model: p.model, preset: [p.priceIn, p.priceOut], table: null }); continue; }
      if (table.in !== p.priceIn || table.out !== p.priceOut) {
        issues.push({ type, model: p.model, preset: [p.priceIn, p.priceOut], table: [table.in, table.out] });
      }
    }
  }
  return issues;
}

// Estimate cost in USD for a single exchange given prompt + completion tokens.
// `model` may be a model object (preferred, supports overrides) or a name.
export function estimateCost(model, promptTokens, completionTokens) {
  const p = effectivePrice(model);
  if (!p) return null;
  return (promptTokens * p.in + completionTokens * p.out) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Cumulative usage accumulation (per user, stored in their encrypted settings).
// Runs until the user manually resets — no automatic monthly rollover, since
// "a month" is ambiguous for a locally-run tool.
// settings.usage = { modelId: { in, out, cost, calls } }
// settings.usageSince = ISO timestamp of when counting started / last reset
// ---------------------------------------------------------------------------

// Migrate older month-bucketed usage ({ "YYYY-MM": {modelId:{...}} }) into the
// new flat cumulative shape, summing all months together.
function flattenUsage(usage) {
  if (!usage || typeof usage !== 'object') return {};
  // already flat if values look like {in,out,cost,calls}
  const vals = Object.values(usage);
  const isFlat = vals.length > 0 && vals.every((v) => v && typeof v === 'object'
    && ('in' in v || 'cost' in v || 'calls' in v) && !looksLikeMonthBucket(v));
  if (isFlat) return usage;
  const flat = {};
  for (const bucket of vals) {
    if (!bucket || typeof bucket !== 'object') continue;
    for (const [id, slot] of Object.entries(bucket)) {
      if (!slot || typeof slot !== 'object') continue;
      const cur = flat[id] || { in: 0, out: 0, cost: 0, calls: 0 };
      cur.in += slot.in || 0; cur.out += slot.out || 0;
      cur.cost += slot.cost || 0; cur.calls += slot.calls || 0;
      flat[id] = cur;
    }
  }
  return flat;
}
function looksLikeMonthBucket(v) {
  // a month bucket's values are themselves {in,out,cost,calls} objects
  return Object.values(v).some((x) => x && typeof x === 'object' && ('in' in x || 'cost' in x));
}

export function addUsage(settings, modelId, modelOrName, promptTokens, completionTokens) {
  settings.usage = flattenUsage(settings.usage);
  if (!settings.usageSince) settings.usageSince = new Date().toISOString();
  const slot = settings.usage[modelId] || { in: 0, out: 0, cost: 0, calls: 0 };
  slot.in += promptTokens || 0;
  slot.out += completionTokens || 0;
  const cost = estimateCost(modelOrName, promptTokens || 0, completionTokens || 0);
  if (cost != null) slot.cost += cost;
  slot.calls += 1;
  settings.usage[modelId] = slot;
  return slot;
}

// Returns { total, perModel: { modelId: { cost, in, out, calls } }, since }.
export function getUsage(settings) {
  const perModel = flattenUsage(settings.usage);
  let total = 0;
  for (const id of Object.keys(perModel)) total += perModel[id].cost || 0;
  return { total, perModel, since: settings.usageSince || null };
}

// Wipe accumulated usage and restart the counter.
export function resetUsage(settings) {
  settings.usage = {};
  settings.usageSince = new Date().toISOString();
}
