// Settings shape & helpers. Persistence is handled by main.js, which encrypts
// each user's settings with their password-derived key (see crypto.js).

export const MODEL_META = {
  openai: { label: 'ChatGPT', color: 'var(--openai)' },
  anthropic: { label: 'Claude', color: 'var(--claude)' },
  gemini: { label: 'Gemini', color: 'var(--gemini)' },
  grok: { label: 'Grok', color: 'var(--grok)' },
  local: { label: '로컬', color: 'var(--local)' },
};

export const MAX_LOCAL = 3;

export function defaultSettings() {
  return {
    customPrompt: '',
    masterId: 'openai',
    masterEnabled: false,
    viewMode: 'split', // 'split' | 'unified'
    webSearchEnabled: true,  // composer-level web search toggle (on by default)
    showCost: true,          // show token/cost estimates
    autoLockMinutes: 60,     // idle auto-logout (0 = off)
    prompts: [],             // saved prompt library: [{ id, title, text }]
    models: [
      { id: 'openai', type: 'openai', label: 'ChatGPT', apiKey: '', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4-mini', enabled: true, vision: true, priceIn: 0.75, priceOut: 4.5 },
      { id: 'anthropic', type: 'anthropic', label: 'Claude', apiKey: '', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-6', enabled: true, vision: true, priceIn: 3, priceOut: 15 },
      { id: 'gemini', type: 'gemini', label: 'Gemini', apiKey: '', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.5-flash', enabled: true, vision: true, priceIn: 1.5, priceOut: 9 },
      { id: 'grok', type: 'grok', label: 'Grok', apiKey: '', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.3', enabled: true, vision: true, priceIn: 1.25, priceOut: 2.5 },
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
  return { ...base, ...parsed, models, prompts };
}

export function localCount(settings) {
  return settings.models.filter((m) => m.type === 'local').length;
}

export function makeLocalModel(index) {
  return {
    id: 'local-' + Date.now() + '-' + index,
    type: 'local',
    label: '로컬 모델 ' + index,
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

// Approximate USD pricing per 1M tokens (input, output). Matched by substring
// of the model name; falls back to null (cost hidden) for unknown models.
// Order matters: more specific patterns first.
const PRICING = [
  // OpenAI
  [/gpt-5.*mini|gpt-4o-mini|gpt-4\.1-mini/i, 0.75, 4.50],
  [/gpt-5|gpt-4o|gpt-4\.1/i, 2.50, 10.00],
  [/o4-mini|o3-mini/i, 1.10, 4.40],
  // Anthropic
  [/claude.*haiku|haiku/i, 0.80, 4.00],
  [/claude.*opus|opus/i, 15.00, 75.00],
  [/claude.*sonnet|claude-3-7|sonnet/i, 3.00, 15.00],
  // Gemini
  [/gemini.*flash-lite|flash-8b/i, 0.075, 0.30],
  [/gemini.*flash/i, 1.50, 9.00],
  [/gemini.*pro/i, 1.25, 10.00],
  // xAI Grok
  [/grok-4|grok-3/i, 1.25, 2.50],
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
