// Zero-knowledge sync client.
//
// This module talks to the Cloudflare Worker backend (see worker/). It only
// ever ships CIPHERTEXT: the server stores opaque AES-GCM blobs keyed by a
// per-user auth token (Key B). The data key (Key A) never leaves the device,
// so the server — and anyone who breaches it — only sees noise.
//
// Sync is incremental ("delta sync"): each device remembers a
// last_sync_timestamp (the server's clock) and on each run it (1) pushes its
// locally-changed records, then (2) pulls everything the server has seen since
// that timestamp. Records are merged last-write-wins by the server-assigned
// updated_at, so a phone never has to download the whole history again.

import { encryptJSON, decryptJSON } from './crypto.js';
import * as db from './db.js';

// --- Payload crypto (thin, explicit names for the sync boundary) -----------
// A "payload" is any JSON value (API keys, settings, a chat turn). It is sealed
// into an { iv, ct } envelope; a fresh random IV is generated per call inside
// encryptJSON, and returned alongside the ciphertext.
export async function encryptPayload(key, value) {
  return encryptJSON(key, value);          // -> { iv: base64, ct: base64 }
}
export async function decryptPayload(key, envelope) {
  return decryptJSON(key, envelope);       // throws on tamper / wrong key
}

// --- Endpoint configuration -------------------------------------------------
// Set your deployed Worker URL here once, or override per-device at runtime via
// localStorage('apitizer.sync.endpoint') (handy for testing a staging worker).
// Example: 'https://api-tizer-sync.YOURNAME.workers.dev'
export const DEFAULT_ENDPOINT = 'https://api-tizer-sync.kangmin1152.workers.dev';
const ENDPOINT_KEY = 'apitizer.sync.endpoint';

export function getEndpoint() {
  return (localStorage.getItem(ENDPOINT_KEY) || DEFAULT_ENDPOINT).replace(/\/+$/, '');
}
export function setEndpoint(url) {
  if (url) localStorage.setItem(ENDPOINT_KEY, String(url).trim().replace(/\/+$/, ''));
  else localStorage.removeItem(ENDPOINT_KEY);
}
export function isConfigured() {
  return !!getEndpoint();
}

// --- Low-level REST helper --------------------------------------------------
async function api(path, { method = 'GET', token, body, signal } = {}) {
  const base = getEndpoint();
  if (!base) throw new Error('동기화 서버 주소가 설정되지 않았습니다.');
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(base + path, {
      method, headers, signal,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('동기화 서버에 연결할 수 없습니다. 네트워크를 확인하세요.');
  }

  let data = null;
  try { data = await res.json(); } catch { /* non-JSON / empty */ }
  if (!res.ok) {
    const msg = (data && data.error) || `서버 오류 (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data || {};
}

// --- Auth (server side of the zero-knowledge handshake) ---------------------
// Fetch the KDF parameters for a username so the client can derive the same
// keys it used on signup. The salt/iterations are NOT secret.
export async function authParams(username) {
  return api('/api/auth/params', { method: 'POST', body: { username } });
}

// Register a new account. `authToken` is Key B (base64); the server stores only
// a slow server-side hash of it, never the token itself.
export async function serverSignup({ username, kdfSalt, kdfIterations, authToken }) {
  return api('/api/auth/signup', {
    method: 'POST',
    body: { username, kdf_salt: kdfSalt, kdf_iterations: kdfIterations, auth_token: authToken },
  });
}

// Log in by proving knowledge of Key B. Returns a bearer { token }.
export async function serverLogin({ username, authToken }) {
  return api('/api/auth/login', { method: 'POST', body: { username, auth_token: authToken } });
}

// Rotate credentials (online password change). Authenticates with the current
// bearer token, hands the server the NEW KDF params + Key B, and gets back a
// fresh token for this device. The server also wipes the user's items so the
// client must re-push the full dataset re-encrypted under the new Key A.
export async function serverChangePassword({ token, kdfSalt, kdfIterations, authToken }) {
  return api('/api/auth/change', {
    method: 'POST',
    token,
    body: { kdf_salt: kdfSalt, kdf_iterations: kdfIterations, auth_token: authToken },
  });
}

// --- Delta sync orchestration ----------------------------------------------
let inFlight = null;

// Push local changes, then pull remote changes since last_sync_timestamp.
// `session` = { id, token }. Returns { pushed, pulled }.
export async function runSync(session) {
  if (!session || !session.token) throw new Error('로그인 세션이 없습니다.');
  if (!isConfigured()) throw new Error('동기화 서버 주소가 설정되지 않았습니다.');
  // Coalesce concurrent triggers (e.g. several quick edits) into one run.
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const user = session.id;
    const token = session.token;

    // 1) PUSH — upload everything flagged dirty since last time.
    const dirty = await db.getDirtyItems(user);
    if (dirty.length) {
      const res = await api('/api/sync/push', { method: 'POST', token, body: { items: dirty } });
      await db.markSynced(user, res.items || []);
    }

    // 2) PULL — download only what changed on the server since our last sync.
    //    Drain pages so a fresh device fully catches up in one run.
    let since = await db.getLastSync(user);
    let pulled = 0;
    let guard = 0;
    while (true) {
      const res = await api(`/api/sync/pull?since=${encodeURIComponent(since)}`, { token });
      const items = res.items || [];
      pulled += await db.applyRemoteItems(user, items);
      since = res.server_time || since;
      await db.setLastSync(user, since);
      if (!res.more || items.length === 0 || ++guard > 100) break;
    }

    return { pushed: dirty.length, pulled };
  })();
  try { return await inFlight; }
  finally { inFlight = null; }
}
