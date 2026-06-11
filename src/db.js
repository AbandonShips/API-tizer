// IndexedDB storage for chats & turns — per user and encrypted at rest.
//
// Records keep only routing/sort fields in clear (id, user, chatId, createdAt);
// all human content (titles, prompts, answers, attachments) lives inside an
// AES-GCM envelope (`enc`) that can only be opened with the logged-in user's
// password-derived key. Turns of a chat are loaded lazily, so a year of
// history stays fast: only the open chat is ever decrypted.

import { encryptJSON, decryptJSON } from './crypto.js';

const DB_NAME = 'apitizer';
const DB_VERSION = 2;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const txn = req.transaction;
      let chats;
      if (!db.objectStoreNames.contains('chats')) {
        chats = db.createObjectStore('chats', { keyPath: 'id' });
      } else {
        chats = txn.objectStore('chats');
      }
      if (!chats.indexNames.contains('user')) {
        chats.createIndex('user', 'user', { unique: false });
      }

      let turns;
      if (!db.objectStoreNames.contains('turns')) {
        turns = db.createObjectStore('turns', { keyPath: 'id' });
      } else {
        turns = txn.objectStore('turns');
      }
      if (!turns.indexNames.contains('chatId')) {
        turns.createIndex('chatId', 'chatId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode) {
  return openDB().then((db) => db.transaction(store, mode).objectStore(store));
}

function reqToPromise(req) {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export const uid = () =>
  (crypto.randomUUID && crypto.randomUUID()) ||
  Date.now().toString(36) + Math.random().toString(36).slice(2);

// Surface quota problems with a friendly, actionable message.
function wrapWrite(promise) {
  return promise.catch((err) => {
    if (err && (err.name === 'QuotaExceededError' || /quota/i.test(String(err && err.message)))) {
      throw new Error('브라우저 저장 공간이 가득 찼습니다. 오래된 채팅이나 큰 첨부 파일을 삭제해주세요.');
    }
    throw err;
  });
}

// ---- Chats ----
export async function createChat(user, key, title = '새 채팅') {
  const createdAt = Date.now();
  const id = uid();
  const enc = await encryptJSON(key, { title, pinned: false, folder: '' });
  await wrapWrite(reqToPromise((await tx('chats', 'readwrite')).add({ id, user, createdAt, enc })));
  return { id, title, createdAt, pinned: false, folder: '' };
}

export async function listChats(user, key) {
  const store = await tx('chats', 'readonly');
  const idx = store.index('user');
  const rows = await reqToPromise(idx.getAll(IDBKeyRange.only(user)));
  const out = [];
  for (const r of rows) {
    let meta = { title: '(복호화 실패)', pinned: false, folder: '' };
    try { meta = { pinned: false, folder: '', ...(await decryptJSON(key, r.enc)) }; }
    catch { /* skip undecryptable */ }
    out.push({ id: r.id, title: meta.title, pinned: !!meta.pinned, folder: meta.folder || '', createdAt: r.createdAt });
  }
  // pinned first, then most-recent
  return out.sort((a, b) => (b.pinned - a.pinned) || (b.createdAt - a.createdAt));
}

// Persist title + pinned + folder for a chat.
export async function updateChatMeta(user, key, chat) {
  const enc = await encryptJSON(key, {
    title: chat.title, pinned: !!chat.pinned, folder: chat.folder || '',
  });
  await wrapWrite(reqToPromise((await tx('chats', 'readwrite'))
    .put({ id: chat.id, user, createdAt: chat.createdAt, enc })));
}
// Back-compat alias.
export const updateChatTitle = updateChatMeta;

export async function deleteChat(chatId) {
  await reqToPromise((await tx('chats', 'readwrite')).delete(chatId));
  const store = await tx('turns', 'readwrite');
  const idx = store.index('chatId');
  const keys = await reqToPromise(idx.getAllKeys(IDBKeyRange.only(chatId)));
  for (const k of keys) store.delete(k);
}

// ---- Turns ----
function splitTurn(turn) {
  const { id, chatId, createdAt, ...payload } = turn;
  return { id, chatId, createdAt, payload };
}

export async function addTurn(key, turn) {
  const { id, chatId, createdAt, payload } = splitTurn(turn);
  const enc = await encryptJSON(key, payload);
  await wrapWrite(reqToPromise((await tx('turns', 'readwrite')).put({ id, chatId, createdAt, enc })));
  return turn;
}

export async function updateTurn(key, turn) {
  return addTurn(key, turn);
}

export async function listTurns(chatId, key) {
  const store = await tx('turns', 'readonly');
  const idx = store.index('chatId');
  const rows = await reqToPromise(idx.getAll(IDBKeyRange.only(chatId)));
  rows.sort((a, b) => a.createdAt - b.createdAt);
  const out = [];
  for (const r of rows) {
    try {
      const payload = await decryptJSON(key, r.enc);
      out.push({ id: r.id, chatId: r.chatId, createdAt: r.createdAt, ...payload });
    } catch { /* skip undecryptable turn */ }
  }
  return out;
}

// ---- Maintenance ----
export async function clearUserData(user) {
  const userChats = await reqToPromise(
    (await tx('chats', 'readonly')).index('user').getAll(IDBKeyRange.only(user))
  );
  const db = await openDB();
  await new Promise((res, rej) => {
    const t = db.transaction(['chats', 'turns'], 'readwrite');
    const chats = t.objectStore('chats');
    const turns = t.objectStore('turns');
    const turnIdx = turns.index('chatId');
    for (const c of userChats) {
      chats.delete(c.id);
      const cursorReq = turnIdx.openKeyCursor(IDBKeyRange.only(c.id));
      cursorReq.onsuccess = (e) => {
        const cur = e.target.result;
        if (cur) { turns.delete(cur.primaryKey); cur.continue(); }
      };
    }
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
  return userChats.length;
}

export async function estimateUsage() {
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const { usage, quota } = await navigator.storage.estimate();
      return { usage: usage || 0, quota: quota || 0 };
    } catch { /* ignore */ }
  }
  return null;
}

// Re-encrypt every chat + turn for a user from oldKey to newKey (password change).
export async function reencryptUserData(user, oldKey, newKey) {
  const chatRows = await reqToPromise(
    (await tx('chats', 'readonly')).index('user').getAll(IDBKeyRange.only(user))
  );
  for (const row of chatRows) {
    let payload;
    try { payload = await decryptJSON(oldKey, row.enc); }
    catch { continue; } // skip unreadable
    const enc = await encryptJSON(newKey, payload);
    await wrapWrite(reqToPromise((await tx('chats', 'readwrite'))
      .put({ id: row.id, user, createdAt: row.createdAt, enc })));

    const turnRows = await reqToPromise(
      (await tx('turns', 'readonly')).index('chatId').getAll(IDBKeyRange.only(row.id))
    );
    for (const t of turnRows) {
      let tp;
      try { tp = await decryptJSON(oldKey, t.enc); }
      catch { continue; }
      const tenc = await encryptJSON(newKey, tp);
      await wrapWrite(reqToPromise((await tx('turns', 'readwrite'))
        .put({ id: t.id, chatId: t.chatId, createdAt: t.createdAt, enc: tenc })));
    }
  }
}

// Export a user's full data (decrypted in memory) for encrypted backup.
export async function exportUserData(user, key) {
  const chatRows = await reqToPromise(
    (await tx('chats', 'readonly')).index('user').getAll(IDBKeyRange.only(user))
  );
  const out = [];
  for (const row of chatRows) {
    let chatPayload;
    try { chatPayload = await decryptJSON(key, row.enc); }
    catch { continue; }
    const turnRows = await reqToPromise(
      (await tx('turns', 'readonly')).index('chatId').getAll(IDBKeyRange.only(row.id))
    );
    const turns = [];
    for (const t of turnRows) {
      try {
        const tp = await decryptJSON(key, t.enc);
        turns.push({ id: t.id, createdAt: t.createdAt, ...tp });
      } catch { /* skip */ }
    }
    out.push({ id: row.id, createdAt: row.createdAt, ...chatPayload, turns });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

// Import previously exported chats for a user, re-encrypting with their key.
// Returns the number of chats imported.
export async function importUserData(user, key, chatsArray) {
  if (!Array.isArray(chatsArray)) throw new Error('백업 형식이 올바르지 않습니다.');
  let count = 0;
  for (const c of chatsArray) {
    const newChatId = uid();
    const enc = await encryptJSON(key, {
      title: c.title || '가져온 채팅', pinned: !!c.pinned, folder: c.folder || '',
    });
    await wrapWrite(reqToPromise((await tx('chats', 'readwrite'))
      .put({ id: newChatId, user, createdAt: c.createdAt || Date.now(), enc })));
    for (const t of (c.turns || [])) {
      const { id: _id, createdAt, ...payload } = t;
      const tenc = await encryptJSON(key, payload);
      await wrapWrite(reqToPromise((await tx('turns', 'readwrite'))
        .put({ id: uid(), chatId: newChatId, createdAt: createdAt || Date.now(), enc: tenc })));
    }
    count++;
  }
  return count;
}
