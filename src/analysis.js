// Pure, dependency-free analysis helpers extracted from main.js so they can be
// unit-tested in isolation (see test/run.mjs). Behaviour is identical to the
// former in-file versions — no DOM, no i18n, no app state.

// Read the master's "### 소수 의견 / ### Minority opinion" section to judge whether
// the models converged. Returns { state:'dissent', text } | { state:'consensus' } |
// null (no verdict yet: still running, errored, or the section was omitted so we
// claim nothing). Matches either language so control flow survives a lang switch.
export function masterVerdict(turn) {
  const r = turn && turn.master;
  if (!(r && r.status === 'done' && r.text)) return null;
  const m = /###\s*(?:소수\s*의견|minority\s*opinion)\s*\n?([\s\S]*)$/i.exec(r.text);
  if (!m) return null;
  const body = m[1].replace(/[\s*_`>#-]+$/, '').trim();
  if (!body) return null;
  // "No meaningful dissent": the instructed sentinels ('특이한 소수 의견 없음' / 'No notable
  // minority opinion') and common paraphrases in either language.
  const noDissent =
    /(소수\s*의견|이견|차이|다른\s*점|반대|이의|불일치)\s*(은|는|이|가|점)?\s*(거의|딱히|특별히|크게)?\s*(없|관찰되지\s*않|발견되지\s*않|나타나지\s*않|존재하지\s*않|보이지\s*않)/.test(body)
    || /특이\s*(한|사항)?\s*(점|것|의견)?\s*(은|는|이|가)?\s*없/.test(body)
    || (body.length <= 12 && /^[\s·\-*]*없(음|습니다|다)?[.!]?$/.test(body))
    || /\bno\b[\s\S]{0,40}\b(minority|dissent|disagree|difference|diverg|conflict)/i.test(body)
    || (body.length <= 16 && /^[\s·\-*]*(none|n\/a)[.!]?$/i.test(body));
  if (noDissent) return { state: 'consensus' };
  return { state: 'dissent', text: body };
}

// Pairwise char-bigram similarity over finished answers → { state, score } or null.
export function similaritySignal(texts) {
  const sets = texts.map(ensembleGrams);
  let sum = 0, pairs = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      if (!sets[i].size || !sets[j].size) continue; // skip answers with no comparable words (code/emoji only)
      sum += jaccardSim(sets[i], sets[j]); pairs++;
    }
  }
  if (pairs === 0) return null; // nothing comparable → no similarity number
  const score = sum / pairs;
  // Conservative bands: only flag clear agreement/divergence, else neutral "mixed".
  const state = score >= 0.30 ? 'agree' : (score <= 0.12 ? 'diverge' : 'mixed');
  return { state, score };
}

function ensembleGrams(text) {
  // Character bigrams over letters/numbers — robust across Korean (agglutinative: particle
  // differences barely change bigrams), English, and code. Pure emoji/punctuation → empty set.
  const norm = String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const grams = new Set();
  for (let i = 0; i < norm.length - 1; i++) grams.add(norm.slice(i, i + 2));
  if (norm.length === 1) grams.add(norm);
  return grams;
}

function jaccardSim(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}
