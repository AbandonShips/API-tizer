// Web Crypto helpers: password-based key derivation (PBKDF2) and
// authenticated encryption (AES-256-GCM). Everything stays in the browser.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const PBKDF2_ITERATIONS = 600000;

export function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

// Chunked base64 — safe for multi-MB payloads (e.g. attached images),
// avoiding "Maximum call stack size exceeded" from String.fromCharCode(...big).
export function toB64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromB64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// URL-safe base64 (no padding) — used to carry a share's raw key + ids in the URL
// fragment, where '+' '/' '=' would be ambiguous or need escaping.
export function toB64url(bytes) {
  return toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s) {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const pad = t.length % 4 ? '='.repeat(4 - (t.length % 4)) : '';
  return fromB64(t + pad);
}

// Import raw bytes as an AES-GCM key. Used for share links, whose key is a fresh
// random value (NOT the account's password-derived Key A) generated per share and
// carried only in the URL fragment.
export function importAesKey(rawBytes, extractable = false) {
  return crypto.subtle.importKey('raw', rawBytes, { name: 'AES-GCM' }, extractable, ['encrypt', 'decrypt']);
}

// Derive an AES-GCM key from a password + salt. Non-extractable by default so
// the raw data key cannot be saved or copied out of Web Crypto by app code.
export async function deriveKey(password, saltBytes, iterations = PBKDF2_ITERATIONS, extractable = false) {
  const baseKey = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    extractable,
    ['encrypt', 'decrypt']
  );
}

// Encrypt any JSON-serialisable value -> { iv, ct } (base64 strings).
export async function encryptJSON(key, value) {
  const iv = randomBytes(12);
  const data = encoder.encode(JSON.stringify(value));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

// Decrypt { iv, ct } -> original value. Throws on tampering / wrong key.
export async function decryptJSON(key, env) {
  const iv = fromB64(env.iv);
  const ct = fromB64(env.ct);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(decoder.decode(pt));
}

// ---------------------------------------------------------------------------
// Zero-knowledge sync key derivation
// ---------------------------------------------------------------------------
// From one master password we deterministically derive TWO independent keys
// via PBKDF2 (slow, salted) followed by HKDF (cheap domain separation):
//
//   Key A  — AES-GCM data key. Encrypts/decrypts everything. NEVER leaves the
//            device; the server never sees it.
//   Key B  — auth token. The ONLY thing sent to the server, used purely to
//            prove "I know the password". Because it comes from a separate
//            HKDF context it cannot be used to derive Key A, so even a fully
//            compromised server learns nothing about the user's data.
//
// The same (password, salt, iterations) on any device yields the same Key A,
// so a phone can decrypt what a laptop encrypted — that is what enables sync.

const ENC_INFO = encoder.encode('apitizer-enc-key-v1');
const AUTH_INFO = encoder.encode('apitizer-auth-key-v1');

// PBKDF2(password) -> 256 raw bits, imported as an HKDF master key.
async function deriveMasterHkdfKey(password, saltBytes, iterations) {
  const baseKey = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const masterBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    baseKey, 256
  );
  return crypto.subtle.importKey('raw', masterBits, 'HKDF', false, ['deriveKey', 'deriveBits']);
}

// Derive { encKey, authToken } for zero-knowledge sync.
//  - encKey:    non-extractable AES-GCM CryptoKey (Key A). Stays on device.
//  - authToken: base64 string (Key B). Safe to send to the server.
export async function deriveSyncKeys(password, saltBytes, iterations = PBKDF2_ITERATIONS, extractable = false) {
  const master = await deriveMasterHkdfKey(password, saltBytes, iterations);

  const encKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: saltBytes, info: ENC_INFO },
    master,
    { name: 'AES-GCM', length: 256 },
    extractable,
    ['encrypt', 'decrypt']
  );

  const authBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: saltBytes, info: AUTH_INFO },
    master, 256
  );

  return { encKey, authToken: toB64(new Uint8Array(authBits)) };
}
