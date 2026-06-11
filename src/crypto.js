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
