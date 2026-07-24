// Read-only share links — zero-knowledge, ChatGPT/Gemini-style.
//
// A share is a FROZEN SNAPSHOT of a chat at the moment you press "share". It never
// auto-updates: if you keep chatting afterwards, the link still shows only what was
// said up to that point.
//
// Zero-knowledge is preserved by the classic "key-in-URL-fragment" trick:
//   1. We serialise the chat (title, dates, messages) into ONE JSON object.
//   2. We encrypt it with a FRESH random key (never the account's Key A).
//   3. We upload only the opaque { iv, ct } to the Worker → it returns a share id.
//   4. The link is  <app>/#s=<id>.<key>[.<endpoint>]  — the key lives in the URL
//      fragment (after '#'), which browsers NEVER send to any server. So the Worker
//      (and GitHub Pages, and any snooping proxy) only ever sees ciphertext; only a
//      person holding the full link can decrypt it locally.
//
// The snapshot builder (buildShareSnapshot) is pure and lives in analysis.js so it
// can be unit-tested; everything network/DOM/crypto-bound lives here.

import {
  encryptJSON, decryptJSON, importAesKey, randomBytes, toB64url, fromB64url,
} from './crypto.js';
import { buildShareSnapshot } from './analysis.js';
import { apiCreateShare, getEndpoint, DEFAULT_ENDPOINT } from './sync.js';

// Keep the plaintext snapshot under ~1.2 MB so the base64 ciphertext stays well
// below D1's 2 MB row limit. Text-only chats are tiny; this only bites when
// images are bundled — hence the text-only fallback the UI offers on overflow.
export const SHARE_MAX_PLAINTEXT_BYTES = 1_200_000;
const IMAGE_MAX_DIM = 1280;
const IMAGE_QUALITY = 0.8;

const utf8 = new TextEncoder();

function byteLength(str) {
  return utf8.encode(str).length;
}

function shareError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

// ---------------------------------------------------------------------------
// Image compression (create side only)
// ---------------------------------------------------------------------------

// Downscale a raster image dataURL to at most IMAGE_MAX_DIM on its longest side and
// re-encode as JPEG. Cuts multi-MB photos down to a few hundred KB so a share with
// images still fits. Returns the original dataURL unchanged if anything fails.
export function compressImageDataUrl(dataUrl, maxDim = IMAGE_MAX_DIM, quality = IMAGE_QUALITY) {
  return new Promise((resolve) => {
    if (typeof dataUrl !== 'string' || !/^data:image\//i.test(dataUrl)) { resolve(dataUrl); return; }
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth || img.width;
        const hgt = img.naturalHeight || img.height;
        if (!w || !hgt) { resolve(dataUrl); return; }
        const scale = Math.min(1, maxDim / Math.max(w, hgt));
        const cw = Math.max(1, Math.round(w * scale));
        const ch = Math.max(1, Math.round(hgt * scale));
        const canvas = document.createElement('canvas');
        canvas.width = cw; canvas.height = ch;
        const ctx = canvas.getContext('2d');
        // JPEG has no alpha — paint a white backdrop so transparent PNGs don't go black.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, cw, ch);
        ctx.drawImage(img, 0, 0, cw, ch);
        const out = canvas.toDataURL('image/jpeg', quality);
        // Only keep the re-encode if it actually helped.
        resolve(out && out.length < dataUrl.length ? out : dataUrl);
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

// Return a copy of `turns` whose image attachments carry compressed dataURLs. When
// images are excluded we return the input untouched (buildShareSnapshot drops the
// dataURLs anyway). Never mutates the live app state.
async function prepareShareTurns(turns, includeImages) {
  if (!includeImages) return turns;
  const out = [];
  for (const tn of (turns || [])) {
    if (!tn.attachments || !tn.attachments.length) { out.push(tn); continue; }
    const attachments = [];
    for (const a of tn.attachments) {
      if (a.kind === 'image' && a.dataUrl) {
        attachments.push({ ...a, dataUrl: await compressImageDataUrl(a.dataUrl) });
      } else {
        attachments.push(a);
      }
    }
    out.push({ ...tn, attachments });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

// Build + encrypt + upload a snapshot, returning { url, expiresAt, bytes }.
// Throws shareError('share_too_large') if it won't fit (caller can retry text-only).
export async function createShareLink({ chat, turns, includeImages, token }) {
  const prepared = await prepareShareTurns(turns, includeImages);
  const snapshot = buildShareSnapshot(chat, prepared, { includeImages });
  const json = JSON.stringify(snapshot);
  const bytes = byteLength(json);
  if (bytes > SHARE_MAX_PLAINTEXT_BYTES) throw shareError('share_too_large');

  const rawKey = randomBytes(32);
  const key = await importAesKey(rawKey);
  const envelope = await encryptJSON(key, snapshot); // { iv, ct } — opaque to the server

  const { id, expires_at: expiresAt } = await apiCreateShare(token, envelope);

  const base = location.origin + location.pathname;
  let frag = `#s=${id}.${toB64url(rawKey)}`;
  // Self-hosters run a different Worker; embed it (validated on read) so their links
  // resolve. Official links stay short and just fall back to DEFAULT_ENDPOINT.
  const ep = getEndpoint();
  if (ep && ep !== DEFAULT_ENDPOINT) frag += '.' + toB64url(utf8.encode(ep));

  return { url: base + frag, expiresAt, bytes };
}

// ---------------------------------------------------------------------------
// View (public, no auth)
// ---------------------------------------------------------------------------

// Only fetch from Workers (or localhost in dev). The CSP already blocks anything
// else, but we fail fast with a clear error rather than a console CSP violation.
function isAllowedEndpoint(ep) {
  try {
    const u = new URL(ep);
    if (u.protocol === 'https:' && /(^|\.)workers\.dev$/i.test(u.hostname)) return true;
    if (/^https?:$/.test(u.protocol) && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true;
  } catch { /* fall through */ }
  return false;
}

// Parse a "#s=<id>.<key>[.<endpoint>]" fragment → { id, keyRaw, endpoint } | null.
export function parseShareHash(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  if (!raw.startsWith('s=')) return null;
  const parts = raw.slice(2).split('.');
  if (parts.length < 2) return null;
  const [id, keyB64, epB64] = parts;
  if (!id || !keyB64) return null;
  let keyRaw;
  try { keyRaw = fromB64url(keyB64); } catch { return null; }
  if (keyRaw.length !== 32) return null;
  let endpoint = null;
  if (epB64) {
    try { endpoint = new TextDecoder().decode(fromB64url(epB64)).replace(/\/+$/, ''); } catch { return null; }
  }
  return { id, keyRaw, endpoint };
}

// True if the current URL is a share link (used to switch into viewer mode on boot).
export function isShareUrl() {
  return !!parseShareHash(location.hash);
}

async function fetchShareEnvelope(endpoint, id) {
  let res;
  try {
    res = await fetch(`${endpoint}/api/share/get?id=${encodeURIComponent(id)}`, { headers: { Accept: 'application/json' } });
  } catch {
    throw shareError('share_offline');
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) throw shareError((data && data.code) || 'share_not_found');
  if (!data || !data.iv || !data.ct) throw shareError('share_not_found');
  return data; // { iv, ct, created_at, expires_at }
}

// Resolve the current share link → { snapshot, createdAt, expiresAt }.
// Throws shareError with a stable `code` the viewer maps to a localised message.
export async function loadShareFromLocation() {
  const parsed = parseShareHash(location.hash);
  if (!parsed) throw shareError('share_invalid');

  const endpoint = (parsed.endpoint || getEndpoint() || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  if (!isAllowedEndpoint(endpoint)) throw shareError('share_endpoint');

  const env = await fetchShareEnvelope(endpoint, parsed.id);

  let snapshot;
  try {
    const key = await importAesKey(parsed.keyRaw);
    snapshot = await decryptJSON(key, { iv: env.iv, ct: env.ct });
  } catch {
    throw shareError('share_invalid'); // wrong/garbled key → link tampered or truncated
  }
  if (!snapshot || snapshot.v !== 1 || !Array.isArray(snapshot.turns)) throw shareError('share_invalid');

  return { snapshot, createdAt: env.created_at, expiresAt: env.expires_at };
}
