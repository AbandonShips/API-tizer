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
 *   POST /api/auth/change   {kdf_salt, kdf_iterations, auth_token}  (Bearer) -> {token, server_time}
 *   GET  /api/sync/pull?since=<ms>&limit=<n>   (Bearer)             -> {server_time, items, more}
 *   POST /api/sync/push     {items:[...]}      (Bearer)             -> {server_time, items}
 *   POST /api/share/create  {iv, ct}           (Bearer)             -> {id, expires_at}
 *   GET  /api/share/get?id=<id>                 (public, no auth)    -> {iv, ct, created_at, expires_at}
 *
 * Changing the password rotates Key B (auth) and Key A (data), bumps the
 * user's `auth_changed_at`, and wipes the server's items so the client can
 * re-push everything re-encrypted under the new Key A. Any still-valid token
 * issued before that moment is rejected (401), which forces other devices to
 * log in again with the new password.
 *
 * Share links stay zero-knowledge: the fresh per-share AES key travels only in
 * the link's URL fragment (never sent to the server), so the stored iv+ct are an
 * opaque snapshot. `GET /api/share/get` is the ONLY unauthenticated read — anyone
 * with the link can fetch the ciphertext, but only the fragment key decrypts it.
 * Shares are frozen snapshots that auto-expire; a Cron trigger purges expired rows.
 *
 * Required binding:  DB    (D1 database)
 * Required secret:   AUTH_SECRET   (HMAC key for session tokens)
 * Optional var:      ALLOW_ORIGIN  (CORS origin allow-list; default '*')
 */

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const AUTH_HASH_ITERATIONS = 100_000;
const PULL_LIMIT_DEFAULT = 500;
const PULL_LIMIT_MAX = 2000;
const SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // shared links auto-expire after 7 days
// D1 caps a row (and any single string/BLOB value) at 2,000,000 bytes. Keep the
// ciphertext comfortably under that so the whole row always fits; the client
// enforces a tighter plaintext budget and offers a text-only fallback.
const SHARE_MAX_CT_CHARS = 1_700_000;

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
      if (request.method === 'POST' && path === '/api/auth/change') return await handleChange(request, env, cors);
      if (request.method === 'GET' && path === '/api/sync/pull') return await handlePull(request, env, url, cors);
      if (request.method === 'POST' && path === '/api/sync/push') return await handlePush(request, env, cors);
      if (request.method === 'POST' && path === '/api/share/create') return await handleShareCreate(request, env, cors);
      if (request.method === 'GET' && path === '/api/share/get') return await handleShareGet(request, env, url, cors);

      return json({ error: 'not found' }, 404, cors);
    } catch (err) {
      return json({ code: 'server_error', error: 'server error', detail: String(err && err.message || err) }, 500, cors);
    }
  },

  // Cron trigger (see wrangler.toml [triggers]): purge expired share snapshots so
  // the table doesn't accumulate dead rows. Reads already reject expired shares, so
  // this is pure housekeeping / storage-cost control.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(env.DB.prepare('DELETE FROM shares WHERE expires_at < ?').bind(Date.now()).run());
  },
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleParams(request, env, cors) {
  const { username } = await readJson(request);
  const id = normId(username);
  if (!id) return errRes('id_required', 'A username is required.', 400, cors);

  const row = await env.DB.prepare(
    'SELECT kdf_salt, kdf_iterations FROM users WHERE username = ?'
  ).bind(id).first();

  if (!row) return json({ exists: false }, 200, cors);
  return json({ exists: true, kdf_salt: row.kdf_salt, kdf_iterations: row.kdf_iterations }, 200, cors);
}

async function handleSignup(request, env, cors) {
  const body = await readJson(request);
  const id = normId(body.username);
  if (!id || id.length < 2) return errRes('id_min', 'Username must be at least 2 characters.', 400, cors);
  if (!body.kdf_salt || !body.kdf_iterations || !body.auth_token) {
    return errRes('missing_fields', 'Required fields are missing.', 400, cors);
  }

  const existing = await env.DB.prepare('SELECT username FROM users WHERE username = ?').bind(id).first();
  if (existing) return errRes('id_exists', 'That username already exists.', 409, cors);

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
  if (!id || !body.auth_token) return errRes('id_pw_required', 'A username and auth token are required.', 400, cors);

  const row = await env.DB.prepare(
    'SELECT auth_salt, auth_hash FROM users WHERE username = ?'
  ).bind(id).first();
  if (!row) return errRes('id_not_found', 'That username does not exist.', 404, cors);

  const candidate = await hashAuthToken(body.auth_token, row.auth_salt);
  if (!timingSafeEqual(candidate, row.auth_hash)) {
    return errRes('auth_failed', 'Authentication failed.', 401, cors);
  }

  const token = await signToken(id, env);
  return json({ token }, 200, cors);
}

// Rotate credentials for the logged-in user (online password change).
// Requires a currently-valid Bearer token. Stamps `auth_changed_at` so every
// token issued earlier (i.e. on other devices) is immediately invalidated, and
// clears the user's items so the client can re-push them re-encrypted under the
// freshly derived Key A. Returns a new token for THIS device.
async function handleChange(request, env, cors) {
  const user = await requireAuth(request, env);
  if (!user) return errRes('auth_required', 'Authentication is required.', 401, cors);

  const body = await readJson(request);
  if (!body.kdf_salt || !body.kdf_iterations || !body.auth_token) {
    return errRes('missing_fields', 'Required fields are missing.', 400, cors);
  }

  const authSalt = randomB64(16);
  const authHash = await hashAuthToken(body.auth_token, authSalt);
  const now = Date.now();

  await env.DB.prepare(
    'UPDATE users SET kdf_salt = ?, kdf_iterations = ?, auth_salt = ?, auth_hash = ?, auth_changed_at = ? WHERE username = ?'
  ).bind(String(body.kdf_salt), Number(body.kdf_iterations), authSalt, authHash, now, user).run();

  // Clean overwrite: drop all old-Key-A ciphertext. The client re-pushes the
  // full, re-encrypted dataset immediately after this call succeeds.
  await env.DB.prepare('DELETE FROM items WHERE username = ?').bind(user).run();

  const token = await signToken(user, env);
  return json({ token, server_time: now }, 200, cors);
}

async function handlePull(request, env, url, cors) {
  const user = await requireAuth(request, env);
  if (!user) return errRes('auth_required', 'Authentication is required.', 401, cors);

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
  if (!user) return errRes('auth_required', 'Authentication is required.', 401, cors);

  const body = await readJson(request);
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length > 5000) return errRes('too_many_items', 'Too many items to send at once.', 413, cors);

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
// Share handlers (public read-only snapshot links)
// ---------------------------------------------------------------------------

// Create a share snapshot. Requires auth (only logged-in users can publish), but
// the stored row holds nothing readable: the decryption key lives solely in the
// link fragment on the client. Title/date/messages are all inside `ct`.
async function handleShareCreate(request, env, cors) {
  const user = await requireAuth(request, env);
  if (!user) return errRes('auth_required', 'Authentication is required.', 401, cors);

  const body = await readJson(request);
  const iv = typeof body.iv === 'string' ? body.iv : '';
  const ct = typeof body.ct === 'string' ? body.ct : '';
  if (!iv || !ct) return errRes('missing_fields', 'Required fields are missing.', 400, cors);
  if (ct.length > SHARE_MAX_CT_CHARS) return errRes('share_too_large', 'The shared conversation is too large.', 413, cors);

  const now = Date.now();
  const id = randomShareId();
  const expiresAt = now + SHARE_TTL_MS;
  await env.DB.prepare(
    'INSERT INTO shares (id, username, created_at, expires_at, iv, ct) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, user, now, expiresAt, iv, ct).run();

  return json({ id, expires_at: expiresAt }, 200, cors);
}

// Public read: anyone holding the link can fetch the opaque snapshot. No auth. The
// fragment key (never seen here) is what actually decrypts it. Expired rows are
// treated as gone (and lazily deleted) so a stale link reveals nothing.
async function handleShareGet(request, env, url, cors) {
  const id = String(url.searchParams.get('id') || '').trim();
  if (!id || id.length > 128) return errRes('share_not_found', 'This shared link was not found.', 404, cors);

  const row = await env.DB.prepare(
    'SELECT created_at, expires_at, iv, ct FROM shares WHERE id = ?'
  ).bind(id).first();
  if (!row) return errRes('share_not_found', 'This shared link was not found.', 404, cors);

  if (Number(row.expires_at || 0) < Date.now()) {
    // Lazy cleanup: drop the dead row on read so it can't linger past its TTL.
    await env.DB.prepare('DELETE FROM shares WHERE id = ?').bind(id).run();
    return errRes('share_expired', 'This shared link has expired.', 410, cors);
  }

  return json({ iv: row.iv, ct: row.ct, created_at: row.created_at, expires_at: row.expires_at }, 200, cors);
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

async function requireAuth(request, env) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const data = await verifyToken(m[1], env);
  if (!data) return null;
  // Reject tokens minted before the user's last credential change so that a
  // password change instantly logs out every other device (they get a 401).
  const row = await env.DB.prepare('SELECT auth_changed_at FROM users WHERE username = ?').bind(data.u).first();
  if (!row) return null;
  if (Number(row.auth_changed_at || 0) > Number(data.iat || 0)) return null;
  return data.u;
}

// Session token: base64url(payload).base64url(HMAC-SHA256(payload)). Stateless,
// but carries `iat` so a credential change can invalidate older tokens.
async function signToken(username, env) {
  const now = Date.now();
  const payload = b64urlEncode(enc.encode(JSON.stringify({ u: username, iat: now, exp: now + TOKEN_TTL_MS })));
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
  return data; // { u, iat, exp }
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

// Error response carrying a stable machine `code` (the client localises it) plus an English
// fallback `error` string for any client that doesn't recognise the code. Keeps the Worker
// language-agnostic so users see errors in their own UI language.
function errRes(code, message, status, cors) {
  return json({ code, error: message }, status, cors);
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

// URL-safe random id for public share links (128 bits of entropy).
function randomShareId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return b64Encode(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
