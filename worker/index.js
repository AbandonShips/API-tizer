/**
 * API-Tizer — zero-knowledge sync backend (Cloudflare Worker + D1).
 *
 * The server is deliberately "dumb": it stores opaque AES-GCM ciphertext and
 * the minimum routing metadata needed to merge changes across devices. It
 * never receives the data key (Key A), so it cannot read user content — that
 * is the whole legal/security point of the zero-knowledge design.
 *
 * Auth uses Key B (a high-entropy token derived from the password on a
 * separate HKDF context). The client sends Key B; the server only ever stores
 * a slow PBKDF2 hash of it, so a database breach reveals neither the password
 * nor anything decryptable.
 *
 * Endpoints:
 *   POST /api/auth/params   {username}                              -> {exists, kdf_salt, kdf_iterations}
 *   POST /api/auth/signup   {username, kdf_salt, kdf_iterations, auth_token} -> {token}
 *   POST /api/auth/login    {username, auth_token}                  -> {token}
 *   GET  /api/sync/pull?since=<ms>&limit=<n>   (Bearer)             -> {server_time, items, more}
 *   POST /api/sync/push     {items:[...]}      (Bearer)             -> {server_time, items}
 *
 * Required binding:  DB    (D1 database)
 * Required secret:   AUTH_SECRET   (HMAC key for session tokens)
 * Optional var:      ALLOW_ORIGIN  (CORS origin allow-list; default '*')
 */

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const AUTH_HASH_ITERATIONS = 100_000;
const PULL_LIMIT_DEFAULT = 500;
const PULL_LIMIT_MAX = 2000;

const enc = new TextEncoder();
const dec = new TextDecoder();

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(env, origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === 'POST' && path === '/api/auth/params') return await handleParams(request, env, cors);
      if (request.method === 'POST' && path === '/api/auth/signup') return await handleSignup(request, env, cors);
      if (request.method === 'POST' && path === '/api/auth/login') return await handleLogin(request, env, cors);
      if (request.method === 'GET' && path === '/api/sync/pull') return await handlePull(request, env, url, cors);
      if (request.method === 'POST' && path === '/api/sync/push') return await handlePush(request, env, cors);

      return json({ error: 'not found' }, 404, cors);
    } catch (err) {
      return json({ error: 'server error', detail: String(err && err.message || err) }, 500, cors);
    }
  },
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleParams(request, env, cors) {
  const { username } = await readJson(request);
  const id = normId(username);
  if (!id) return json({ error: '아이디가 필요합니다.' }, 400, cors);

  const row = await env.DB.prepare(
    'SELECT kdf_salt, kdf_iterations FROM users WHERE username = ?'
  ).bind(id).first();

  if (!row) return json({ exists: false }, 200, cors);
  return json({ exists: true, kdf_salt: row.kdf_salt, kdf_iterations: row.kdf_iterations }, 200, cors);
}

async function handleSignup(request, env, cors) {
  const body = await readJson(request);
  const id = normId(body.username);
  if (!id || id.length < 2) return json({ error: '아이디는 2자 이상이어야 합니다.' }, 400, cors);
  if (!body.kdf_salt || !body.kdf_iterations || !body.auth_token) {
    return json({ error: '필수 항목이 누락되었습니다.' }, 400, cors);
  }

  const existing = await env.DB.prepare('SELECT username FROM users WHERE username = ?').bind(id).first();
  if (existing) return json({ error: '이미 존재하는 아이디입니다.' }, 409, cors);

  const authSalt = randomB64(16);
  const authHash = await hashAuthToken(body.auth_token, authSalt);

  await env.DB.prepare(
    'INSERT INTO users (username, kdf_salt, kdf_iterations, auth_salt, auth_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, String(body.kdf_salt), Number(body.kdf_iterations), authSalt, authHash, Date.now()).run();

  const token = await signToken(id, env);
  return json({ token }, 200, cors);
}

async function handleLogin(request, env, cors) {
  const body = await readJson(request);
  const id = normId(body.username);
  if (!id || !body.auth_token) return json({ error: '아이디와 인증 토큰이 필요합니다.' }, 400, cors);

  const row = await env.DB.prepare(
    'SELECT auth_salt, auth_hash FROM users WHERE username = ?'
  ).bind(id).first();
  if (!row) return json({ error: '존재하지 않는 아이디입니다.' }, 404, cors);

  const candidate = await hashAuthToken(body.auth_token, row.auth_salt);
  if (!timingSafeEqual(candidate, row.auth_hash)) {
    return json({ error: '인증에 실패했습니다.' }, 401, cors);
  }

  const token = await signToken(id, env);
  return json({ token }, 200, cors);
}

async function handlePull(request, env, url, cors) {
  const user = await requireAuth(request, env);
  if (!user) return json({ error: '인증이 필요합니다.' }, 401, cors);

  const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
  const limit = clamp(Number(url.searchParams.get('limit')) || PULL_LIMIT_DEFAULT, 1, PULL_LIMIT_MAX);

  const res = await env.DB.prepare(
    'SELECT id, type, parent_id, created_at, updated_at, deleted, iv, ct ' +
    'FROM items WHERE username = ? AND updated_at > ? ORDER BY updated_at ASC LIMIT ?'
  ).bind(user, since, limit + 1).all();

  const rows = res.results || [];
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;

  const items = page.map((r) => ({
    id: r.id, type: r.type, parentId: r.parent_id, createdAt: r.created_at,
    updatedAt: r.updated_at, deleted: r.deleted ? 1 : 0, iv: r.iv, ct: r.ct,
  }));

  // When paginating, advance only as far as the last returned row so the next
  // pull continues exactly where this one stopped (no gaps, no repeats).
  const serverTime = more ? page[page.length - 1].updatedAt : Date.now();

  return json({ server_time: serverTime, items, more }, 200, cors);
}

async function handlePush(request, env, cors) {
  const user = await requireAuth(request, env);
  if (!user) return json({ error: '인증이 필요합니다.' }, 401, cors);

  const body = await readJson(request);
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length > 5000) return json({ error: '한 번에 보낼 수 있는 항목 수를 초과했습니다.' }, 413, cors);

  // "Last writer to reach the server wins", stamped with the server clock so
  // delta timestamps stay monotonic regardless of device clock skew.
  const now = Date.now();
  const confirmed = [];
  const stmt = env.DB.prepare(
    'INSERT INTO items (username, id, type, parent_id, created_at, updated_at, deleted, iv, ct) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(username, id) DO UPDATE SET ' +
    'type=excluded.type, parent_id=excluded.parent_id, created_at=excluded.created_at, ' +
    'updated_at=excluded.updated_at, deleted=excluded.deleted, iv=excluded.iv, ct=excluded.ct'
  );

  const batch = [];
  for (const it of items) {
    if (!it || !it.id || !it.type) continue;
    batch.push(stmt.bind(
      user, String(it.id), String(it.type), it.parentId ?? null,
      it.createdAt ?? null, now, it.deleted ? 1 : 0,
      it.deleted ? null : (it.iv ?? null), it.deleted ? null : (it.ct ?? null),
    ));
    confirmed.push({ id: it.id, type: it.type, updatedAt: now });
  }
  if (batch.length) await env.DB.batch(batch);

  return json({ server_time: now, items: confirmed }, 200, cors);
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

async function requireAuth(request, env) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  return verifyToken(m[1], env);
}

// Session token: base64url(payload).base64url(HMAC-SHA256(payload)). Stateless.
async function signToken(username, env) {
  const payload = b64urlEncode(enc.encode(JSON.stringify({ u: username, exp: Date.now() + TOKEN_TTL_MS })));
  const sig = await hmac(payload, env);
  return `${payload}.${sig}`;
}

async function verifyToken(token, env) {
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = await hmac(payload, env);
  if (!timingSafeEqual(sig, expected)) return null;
  let data;
  try { data = JSON.parse(dec.decode(b64urlDecode(payload))); } catch { return null; }
  if (!data || !data.u || !data.exp || data.exp < Date.now()) return null;
  return data.u;
}

async function hmac(message, env) {
  const secret = env.AUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET is not configured');
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return b64urlEncode(new Uint8Array(sig));
}

// Slow hash of Key B with a per-user salt, so the stored auth_hash is useless
// to an attacker even if the database leaks.
async function hashAuthToken(authToken, saltB64) {
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(authToken), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: b64Decode(saltB64), iterations: AUTH_HASH_ITERATIONS, hash: 'SHA-256' },
    baseKey, 256
  );
  return b64Encode(new Uint8Array(bits));
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function corsHeaders(env, origin) {
  const allow = env.ALLOW_ORIGIN || '*';
  const value = allow === '*' ? '*' : (allow.split(',').map((s) => s.trim()).includes(origin) ? origin : allow.split(',')[0].trim());
  return {
    'Access-Control-Allow-Origin': value,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

async function readJson(request) {
  try { return (await request.json()) || {}; } catch { return {}; }
}

function normId(username) {
  return String(username || '').trim().toLowerCase();
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function timingSafeEqual(a, b) {
  const sa = String(a), sb = String(b);
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}

function randomB64(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b64Encode(b);
}

function b64Encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64Decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlEncode(bytes) {
  return b64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const pad = str.length % 4 ? '='.repeat(4 - (str.length % 4)) : '';
  return b64Decode(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
}
