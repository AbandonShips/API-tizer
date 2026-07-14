// Lightweight local user accounts. Passwords are NEVER stored — only a
// per-user random salt and an encrypted "verifier". Login re-derives the key
// and tries to decrypt the verifier; success proves the password is correct.
// The derived key lives only in memory for the session and is what encrypts
// that user's settings and chat history.

import {
  deriveKey, encryptJSON, decryptJSON,
  randomBytes, toB64, fromB64, PBKDF2_ITERATIONS,
  deriveSyncKeys,
} from './crypto.js';
import { authParams, serverSignup, serverLogin } from './sync.js';
import { t } from './i18n.js';

const USERS_KEY = 'apitizer.users.v1';
const VERIFIER_TEXT = 'apitizer-verify-v1';
const MIN_PASSWORD_LENGTH = 8;
// Per-device cache for online accounts: stores the (non-secret) KDF params plus
// an encrypted verifier so the app can re-derive Key A and confirm the password
// even when the sync server is briefly unreachable (offline-capable login).
const ONLINE_PREFIX = 'apitizer.online.v1.';

function loadUsers() {
  try { return JSON.parse(localStorage.getItem(USERS_KEY)) || {}; }
  catch { return {}; }
}
function saveUsers(users) {
  localStorage.setItem(USERS_KEY, JSON.stringify(users));
}

function normalizeId(username) {
  return String(username || '').trim().toLowerCase();
}

function passwordProblem(password) {
  const value = String(password || '');
  if (value.length < MIN_PASSWORD_LENGTH) return t('ext.pw_min', { n: MIN_PASSWORD_LENGTH });
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(value)).length;
  if (value.length < 12 && classes < 3) return t('ext.pw_mix');
  if (/^(.)\1+$/.test(value)) return t('ext.pw_repeat');
  if (/password|1234|qwer|admin|apitizer/i.test(value)) return t('ext.pw_common');
  return '';
}

export function getDisplayName(username) {
  return loadUsers()[normalizeId(username)]?.displayName || username;
}

export async function signup(username, password, options = {}) {
  const display = String(username || '').trim();
  const id = normalizeId(username);
  if (!id) throw new Error(t('ext.id_required'));
  if (id.length < 2) throw new Error(t('ext.id_min'));
  const weak = passwordProblem(password);
  if (weak) throw new Error(weak);

  const users = loadUsers();
  if (users[id]) throw new Error(t('ext.id_exists'));

  const salt = randomBytes(16);
  const iterations = PBKDF2_ITERATIONS;
  const key = await deriveKey(password, salt, iterations, !!options.extractable);
  const verifier = await encryptJSON(key, VERIFIER_TEXT);

  users[id] = {
    id, displayName: display, salt: toB64(salt), iterations, verifier,
    createdAt: Date.now(),
  };
  saveUsers(users);
  return { id, displayName: display, key };
}

export async function login(username, password, options = {}) {
  const id = normalizeId(username);
  const users = loadUsers();
  const rec = users[id];
  if (!rec) throw new Error(t('ext.id_not_found'));

  const key = await deriveKey(password, fromB64(rec.salt), rec.iterations || PBKDF2_ITERATIONS, !!options.extractable);
  try {
    const v = await decryptJSON(key, rec.verifier);
    if (v !== VERIFIER_TEXT) throw new Error('mismatch');
  } catch {
    throw new Error(t('ext.pw_wrong'));
  }
  return { id, displayName: rec.displayName, key };
}

// Permanently remove an account record (its encrypted data is cleared
// separately by the caller).
export function deleteAccount(id) {
  const users = loadUsers();
  delete users[normalizeId(id)];
  saveUsers(users);
}

// Verify the current password and return both the existing key and a freshly
// derived key for the new password (plus its new salt). The caller is
// responsible for re-encrypting all of this user's data from oldKey -> newKey,
// then committing the new verifier via commitPasswordChange().
export async function preparePasswordChange(id, currentPassword, newPassword) {
  const nid = normalizeId(id);
  const users = loadUsers();
  const rec = users[nid];
  if (!rec) throw new Error(t('ext.account_not_found'));
  const weak = passwordProblem(newPassword);
  if (weak) throw new Error(weak);

  const oldKey = await deriveKey(currentPassword, fromB64(rec.salt), rec.iterations || PBKDF2_ITERATIONS);
  try {
    const v = await decryptJSON(oldKey, rec.verifier);
    if (v !== VERIFIER_TEXT) throw new Error('mismatch');
  } catch {
    throw new Error(t('ext.cur_pw_wrong'));
  }

  const newSalt = randomBytes(16);
  const iterations = PBKDF2_ITERATIONS;
  const newKey = await deriveKey(newPassword, newSalt, iterations);
  return { oldKey, newKey, newSalt: toB64(newSalt), iterations };
}

// Finalise a password change once all data has been re-encrypted with newKey.
export async function commitPasswordChange(id, newKey, newSalt, iterations) {
  const nid = normalizeId(id);
  const users = loadUsers();
  const rec = users[nid];
  if (!rec) throw new Error(t('ext.account_not_found'));
  rec.salt = newSalt;
  rec.iterations = iterations;
  rec.verifier = await encryptJSON(newKey, VERIFIER_TEXT);
  saveUsers(users);
}

// ===========================================================================
//  Online (zero-knowledge sync) accounts
// ===========================================================================
// These accounts live on the sync server. The password derives two keys:
//   Key A (encKey)  — encrypts all data, NEVER sent to the server.
//   Key B (authToken) — the only secret sent, used purely to authenticate.
// A small per-device cache keeps the KDF params + an encrypted verifier so the
// app can still open offline; full sync resumes once the server is reachable.

function loadOnlineCache(id) {
  try { return JSON.parse(localStorage.getItem(ONLINE_PREFIX + normalizeId(id))) || null; }
  catch { return null; }
}
function saveOnlineCache(id, data) {
  localStorage.setItem(ONLINE_PREFIX + normalizeId(id), JSON.stringify(data));
}

async function cacheOnlineVerifier(id, displayName, encKey, kdfSalt, iterations) {
  saveOnlineCache(id, {
    displayName,
    kdfSalt,
    iterations,
    verifier: await encryptJSON(encKey, VERIFIER_TEXT),
    cachedAt: Date.now(),
  });
}

// Create a brand-new online account on the sync server.
export async function onlineSignup(username, password, options = {}) {
  const display = String(username || '').trim();
  const id = normalizeId(username);
  if (!id) throw new Error(t('ext.id_required'));
  if (id.length < 2) throw new Error(t('ext.id_min'));
  const weak = passwordProblem(password);
  if (weak) throw new Error(weak);

  // Reject duplicates up-front (server also enforces this).
  const params = await authParams(id);
  if (params && params.exists) throw new Error(t('ext.id_exists'));

  const salt = randomBytes(16);
  const iterations = PBKDF2_ITERATIONS;
  const { encKey, authToken } = await deriveSyncKeys(password, salt, iterations, !!options.extractable);
  const kdfSalt = toB64(salt);

  const { token } = await serverSignup({ username: id, kdfSalt, kdfIterations: iterations, authToken });
  await cacheOnlineVerifier(id, display, encKey, kdfSalt, iterations);

  return { id, displayName: display, key: encKey, mode: 'online', token, authToken, kdfSalt, iterations, offline: false };
}

// Log in to an existing online account. Falls back to an offline-verified
// session (token = null) if the server can't be reached but this device has a
// cached verifier — the app stays usable and syncs when connectivity returns.
export async function onlineLogin(username, password, options = {}) {
  const id = normalizeId(username);
  if (!id) throw new Error(t('ext.id_required'));

  let params;
  try {
    params = await authParams(id);
  } catch (netErr) {
    const cache = loadOnlineCache(id);
    if (!cache) throw netErr; // no offline fallback available
    return offlineLogin(id, password, cache, options);
  }

  if (!params || !params.exists) throw new Error(t('ext.id_not_found'));

  const salt = fromB64(params.kdf_salt);
  const iterations = params.kdf_iterations || PBKDF2_ITERATIONS;
  const { encKey, authToken } = await deriveSyncKeys(password, salt, iterations, !!options.extractable);

  let token;
  try {
    ({ token } = await serverLogin({ username: id, authToken }));
  } catch (err) {
    if (err.status === 401 || err.status === 403) throw new Error(t('ext.pw_wrong'));
    throw err;
  }

  const cache = loadOnlineCache(id);
  const display = (cache && cache.displayName) || String(username).trim();
  await cacheOnlineVerifier(id, display, encKey, params.kdf_salt, iterations);

  return { id, displayName: display, key: encKey, mode: 'online', token, authToken, kdfSalt: params.kdf_salt, iterations, offline: false };
}

async function offlineLogin(id, password, cache, options = {}) {
  const salt = fromB64(cache.kdfSalt);
  const { encKey, authToken } = await deriveSyncKeys(password, salt, cache.iterations || PBKDF2_ITERATIONS, !!options.extractable);
  try {
    const v = await decryptJSON(encKey, cache.verifier);
    if (v !== VERIFIER_TEXT) throw new Error('mismatch');
  } catch {
    throw new Error(t('ext.pw_wrong'));
  }
  return {
    id, displayName: cache.displayName || id, key: encKey, mode: 'online',
    token: null, authToken, kdfSalt: cache.kdfSalt, iterations: cache.iterations || PBKDF2_ITERATIONS,
    offline: true,
  };
}

// Verify the current password against the live session's KDF params, then
// derive a fresh Key A (data) + Key B (auth) under a brand-new salt for the new
// password. The caller re-encrypts all local data with `newKey`, rotates the
// server credentials with `newAuthToken`/`newKdfSalt`, then re-pushes.
export async function onlineChangePassword({ currentPassword, newPassword, kdfSalt, iterations, currentAuthToken }) {
  const weak = passwordProblem(newPassword);
  if (weak) throw new Error(weak);

  // Re-derive Key B from the current password and compare to the session's
  // token — proves the user actually knows the current password.
  const { authToken: curAuth } = await deriveSyncKeys(
    currentPassword, fromB64(kdfSalt), iterations || PBKDF2_ITERATIONS
  );
  if (curAuth !== currentAuthToken) throw new Error(t('ext.cur_pw_wrong'));

  const newSalt = randomBytes(16);
  const newIterations = PBKDF2_ITERATIONS;
  const { encKey: newKey, authToken: newAuthToken } =
    await deriveSyncKeys(newPassword, newSalt, newIterations);

  return { newKey, newAuthToken, newKdfSalt: toB64(newSalt), iterations: newIterations };
}

// Refresh this device's offline-capable verifier after a password change so an
// offline login keeps working with the new key.
export async function refreshOnlineCache(username, displayName, encKey, kdfSalt, iterations) {
  await cacheOnlineVerifier(username, displayName, encKey, kdfSalt, iterations);
}
