// IndexedDB storage for chats & turns — per user and encrypted at rest.
//
// Records keep only routing/sort fields in clear (id, user, chatId, createdAt);
// all human content (titles, prompts, answers, attachments) lives inside an
// AES-GCM envelope (`enc`) that can only be opened with the logged-in user's
// password-derived key. Turns of a chat are loaded lazily, so a year of
// history stays fast: only the open chat is ever decrypted.

import { encryptJSON, decryptJSON } from './crypto.js';

const DB_NAME = 'apitizer';
const DB_VERSION = 3;
let dbPromise = null;

// When true (online/sync mode), deletes become tombstones and every write is
// flagged `dirty` so the sync layer can ship just the changes. In local-only
// mode this stays false and the store behaves exactly as before.
let syncEnabled = false;
export function setSyncEnabled(on) { syncEnabled = !!on; }

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
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
      if (!chats.indexNames.contains('dirty')) {
        chats.createIndex('dirty', 'dirty', { unique: false });
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
      if (!turns.indexNames.contains('user')) {
        turns.createIndex('user', 'user', { unique: false });
      }
      if (!turns.indexNames.contains('dirty')) {
        turns.createIndex('dirty', 'dirty', { unique: false });
      }

      // Key/value store for sync bookkeeping (last_sync_timestamp per user) and
      // the synced copy of each user's encrypted settings blob.
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }

      // v2 -> v3: backfill sync metadata onto existing rows so they can later
      // be uploaded. `user` is copied onto turns from their parent chat.
      if (event.oldVersion < 3) {
        const chatUser = new Map();
        chats.openCursor().onsuccess = (e) => {
          const cur = e.target.result;
          if (cur) {
            const v = cur.value;
            chatUser.set(v.id, v.user);
            if (v.updatedAt == null) v.updatedAt = v.createdAt || Date.now();
            if (v.deleted == null) v.deleted = 0;
            if (v.dirty == null) v.dirty = 0;
            cur.update(v);
            cur.continue();
          } else {
            // chats fully walked -> now backfill turns (user + metadata)
            turns.openCursor().onsuccess = (te) => {
              const tc = te.target.result;
              if (!tc) return;
              const tv = tc.value;
              if (tv.user == null) tv.user = chatUser.get(tv.chatId) || '';
              if (tv.updatedAt == null) tv.updatedAt = tv.createdAt || Date.now();
              if (tv.deleted == null) tv.deleted = 0;
              if (tv.dirty == null) tv.dirty = 0;
              tc.update(tv);
              tc.continue();
            };
          }
        };
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
  const enc = await encryptJSON(key, { title, pinned: false, folder: '', chatPrompt: '', chatRichStyle: null });
  await wrapWrite(reqToPromise((await tx('chats', 'readwrite'))
    .add({ id, user, createdAt, updatedAt: createdAt, deleted: 0, dirty: 1, enc })));
  return { id, title, createdAt, pinned: false, folder: '', chatPrompt: '', chatRichStyle: null };
}

export async function listChats(user, key) {
  const store = await tx('chats', 'readonly');
  const idx = store.index('user');
  const rows = await reqToPromise(idx.getAll(IDBKeyRange.only(user)));
  const out = [];
  for (const r of rows) {
    if (r.deleted) continue; // hide tombstones
    let meta = { title: '(복호화 실패)', pinned: false, folder: '', chatPrompt: '', chatRichStyle: null };
    try { meta = { pinned: false, folder: '', chatPrompt: '', chatRichStyle: null, ...(await decryptJSON(key, r.enc)) }; }
    catch { /* skip undecryptable */ }
    out.push({ id: r.id, title: meta.title, pinned: !!meta.pinned, folder: meta.folder || '', chatPrompt: meta.chatPrompt || '', chatRichStyle: (meta.chatRichStyle === true || meta.chatRichStyle === false) ? meta.chatRichStyle : null, createdAt: r.createdAt });
  }
  // pinned first, then most-recent
  return out.sort((a, b) => (b.pinned - a.pinned) || (b.createdAt - a.createdAt));
}

// Persist title + pinned + folder for a chat.
export async function updateChatMeta(user, key, chat) {
  const enc = await encryptJSON(key, {
    title: chat.title,
    pinned: !!chat.pinned,
    folder: chat.folder || '',
    chatPrompt: chat.chatPrompt || '',
    chatRichStyle: (chat.chatRichStyle === true || chat.chatRichStyle === false) ? chat.chatRichStyle : null,
  });
  await wrapWrite(reqToPromise((await tx('chats', 'readwrite'))
    .put({ id: chat.id, user, createdAt: chat.createdAt, updatedAt: Date.now(), deleted: 0, dirty: 1, enc })));
}
// Back-compat alias.
export const updateChatTitle = updateChatMeta;

export async function deleteChat(chatId) {
  if (syncEnabled) {
    // Tombstone so the deletion propagates to other devices, then re-syncs away.
    const store = await tx('chats', 'readwrite');
    const row = await reqToPromise(store.get(chatId));
    if (row) {
      row.deleted = 1;
      row.dirty = 1;
      row.updatedAt = Date.now();
      await reqToPromise((await tx('chats', 'readwrite')).put(row));
    }
    const tstore = await tx('turns', 'readwrite');
    const keys = await reqToPromise(tstore.index('chatId').getAll(IDBKeyRange.only(chatId)));
    for (const t of keys) {
      t.deleted = 1; t.dirty = 1; t.updatedAt = Date.now();
      await reqToPromise((await tx('turns', 'readwrite')).put(t));
    }
    return;
  }
  await reqToPromise((await tx('chats', 'readwrite')).delete(chatId));
  const store = await tx('turns', 'readwrite');
  const idx = store.index('chatId');
  const keys = await reqToPromise(idx.getAllKeys(IDBKeyRange.only(chatId)));
  for (const k of keys) store.delete(k);
}

export async function deleteAllChats(user) {
  const userChats = await reqToPromise(
    (await tx('chats', 'readonly')).index('user').getAll(IDBKeyRange.only(user))
  );

  if (syncEnabled) {
    const now = Date.now();
    for (const c of userChats) {
      c.deleted = 1;
      c.dirty = 1;
      c.updatedAt = now;
      await reqToPromise((await tx('chats', 'readwrite')).put(c));
    }
    const turnRows = await reqToPromise(
      (await tx('turns', 'readonly')).index('user').getAll(IDBKeyRange.only(user))
    );
    for (const t of turnRows) {
      t.deleted = 1;
      t.dirty = 1;
      t.updatedAt = now;
      await reqToPromise((await tx('turns', 'readwrite')).put(t));
    }
    return userChats.length;
  }

  const db = await openDB();
  await new Promise((res, rej) => {
    const t = db.transaction(['chats', 'turns'], 'readwrite');
    const chats = t.objectStore('chats');
    const turns = t.objectStore('turns');
    const turnIdx = turns.index('user');
    for (const c of userChats) chats.delete(c.id);
    const cursorReq = turnIdx.openKeyCursor(IDBKeyRange.only(user));
    cursorReq.onsuccess = (e) => {
      const cur = e.target.result;
      if (cur) { turns.delete(cur.primaryKey); cur.continue(); }
    };
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
  return userChats.length;
}

// ---- Turns ----
function splitTurn(turn) {
  const { id, chatId, createdAt, ...payload } = turn;
  return { id, chatId, createdAt, payload };
}

export async function addTurn(key, turn, user) {
  const { id, chatId, createdAt, payload } = splitTurn(turn);
  const enc = await encryptJSON(key, payload);
  // Preserve user when updating an existing turn (caller may omit it).
  let owner = user;
  if (owner == null) {
    const existing = await reqToPromise((await tx('turns', 'readonly')).get(id));
    owner = existing ? existing.user : '';
  }
  await wrapWrite(reqToPromise((await tx('turns', 'readwrite'))
    .put({ id, chatId, user: owner || '', createdAt, updatedAt: Date.now(), deleted: 0, dirty: 1, enc })));
  return turn;
}

export async function updateTurn(key, turn, user) {
  return addTurn(key, turn, user);
}

export async function listTurns(chatId, key) {
  const store = await tx('turns', 'readonly');
  const idx = store.index('chatId');
  const rows = await reqToPromise(idx.getAll(IDBKeyRange.only(chatId)));
  rows.sort((a, b) => a.createdAt - b.createdAt);
  const out = [];
  for (const r of rows) {
    if (r.deleted) continue; // hide tombstones
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
      .put({ id: row.id, user, createdAt: row.createdAt, updatedAt: Date.now(),
             deleted: row.deleted || 0, dirty: 1, enc })));

    const turnRows = await reqToPromise(
      (await tx('turns', 'readonly')).index('chatId').getAll(IDBKeyRange.only(row.id))
    );
    for (const t of turnRows) {
      let tp;
      try { tp = await decryptJSON(oldKey, t.enc); }
      catch { continue; }
      const tenc = await encryptJSON(newKey, tp);
      await wrapWrite(reqToPromise((await tx('turns', 'readwrite'))
        .put({ id: t.id, chatId: t.chatId, user: t.user || user, createdAt: t.createdAt,
               updatedAt: Date.now(), deleted: t.deleted || 0, dirty: 1, enc: tenc })));
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
    const now = Date.now();
    await wrapWrite(reqToPromise((await tx('chats', 'readwrite'))
      .put({ id: newChatId, user, createdAt: c.createdAt || now, updatedAt: now, deleted: 0, dirty: 1, enc })));
    for (const t of (c.turns || [])) {
      const { id: _id, createdAt, ...payload } = t;
      const tenc = await encryptJSON(key, payload);
      await wrapWrite(reqToPromise((await tx('turns', 'readwrite'))
        .put({ id: uid(), chatId: newChatId, user, createdAt: createdAt || now,
               updatedAt: now, deleted: 0, dirty: 1, enc: tenc })));
    }
    count++;
  }
  return count;
}

// ===========================================================================
//  Sync support — generic "items" view over chats/turns/settings for the
//  delta-sync layer (see sync.js). Items only ever carry CIPHERTEXT plus the
//  routing/ordering fields the server needs to merge by last-write-wins.
// ===========================================================================

const META_SETTINGS = (user) => `settings:${user}`;
const META_LASTSYNC = (user) => `lastSync:${user}`;

// Read/replace this user's synced settings blob (kept in the `meta` store so it
// rides along with chats/turns through the same sync pipeline).
export async function loadSyncSettings(user, key) {
  const row = await reqToPromise((await tx('meta', 'readonly')).get(META_SETTINGS(user)));
  if (!row || row.deleted || !row.enc) return null;
  try { return await decryptJSON(key, row.enc); }
  catch { return null; }
}

export async function saveSyncSettings(user, key, settings) {
  const enc = await encryptJSON(key, settings);
  const prev = await reqToPromise((await tx('meta', 'readonly')).get(META_SETTINGS(user)));
  await wrapWrite(reqToPromise((await tx('meta', 'readwrite')).put({
    key: META_SETTINGS(user), user, type: 'settings',
    createdAt: prev?.createdAt || Date.now(), updatedAt: Date.now(),
    deleted: 0, dirty: 1, enc,
  })));
}

export async function getLastSync(user) {
  const row = await reqToPromise((await tx('meta', 'readonly')).get(META_LASTSYNC(user)));
  return row?.value || 0;
}

export async function setLastSync(user, ts) {
  await reqToPromise((await tx('meta', 'readwrite')).put({ key: META_LASTSYNC(user), value: ts }));
}

// Collect every locally-changed record for a user as wire items:
//   { id, type:'chat'|'turn'|'settings', parentId, createdAt, updatedAt, deleted, iv, ct }
export async function getDirtyItems(user) {
  const items = [];

  const dirtyChats = await reqToPromise((await tx('chats', 'readonly')).index('dirty').getAll(IDBKeyRange.only(1)));
  for (const r of dirtyChats) {
    if (r.user !== user) continue;
    items.push({ id: r.id, type: 'chat', parentId: null, createdAt: r.createdAt,
      updatedAt: r.updatedAt, deleted: r.deleted ? 1 : 0, iv: r.enc.iv, ct: r.enc.ct });
  }

  const dirtyTurns = await reqToPromise((await tx('turns', 'readonly')).index('dirty').getAll(IDBKeyRange.only(1)));
  for (const r of dirtyTurns) {
    if (r.user !== user) continue;
    items.push({ id: r.id, type: 'turn', parentId: r.chatId, createdAt: r.createdAt,
      updatedAt: r.updatedAt, deleted: r.deleted ? 1 : 0, iv: r.enc.iv, ct: r.enc.ct });
  }

  const settingsRow = await reqToPromise((await tx('meta', 'readonly')).get(META_SETTINGS(user)));
  if (settingsRow && settingsRow.dirty) {
    items.push({ id: 'settings', type: 'settings', parentId: null, createdAt: settingsRow.createdAt,
      updatedAt: settingsRow.updatedAt, deleted: settingsRow.deleted ? 1 : 0,
      iv: settingsRow.enc.iv, ct: settingsRow.enc.ct });
  }

  return items;
}

// After a successful push, clear dirty flags and adopt the server's authoritative
// timestamps. Confirmed tombstones are pruned locally (the server keeps them).
export async function markSynced(user, confirmed) {
  for (const c of confirmed) {
    if (c.type === 'chat') {
      const row = await reqToPromise((await tx('chats', 'readonly')).get(c.id));
      if (!row) continue;
      if (row.deleted) { await reqToPromise((await tx('chats', 'readwrite')).delete(c.id)); continue; }
      row.dirty = 0; row.updatedAt = c.updatedAt;
      await reqToPromise((await tx('chats', 'readwrite')).put(row));
    } else if (c.type === 'turn') {
      const row = await reqToPromise((await tx('turns', 'readonly')).get(c.id));
      if (!row) continue;
      if (row.deleted) { await reqToPromise((await tx('turns', 'readwrite')).delete(c.id)); continue; }
      row.dirty = 0; row.updatedAt = c.updatedAt;
      await reqToPromise((await tx('turns', 'readwrite')).put(row));
    } else if (c.type === 'settings') {
      const row = await reqToPromise((await tx('meta', 'readonly')).get(META_SETTINGS(user)));
      if (!row) continue;
      row.dirty = 0; row.updatedAt = c.updatedAt;
      await reqToPromise((await tx('meta', 'readwrite')).put(row));
    }
  }
}

// Apply items pulled from the server. Last-write-wins: a remote item is applied
// only when it is strictly newer than the local copy AND the local copy isn't a
// pending (dirty) change that is at least as new.
export async function applyRemoteItems(user, items) {
  let applied = 0;
  for (const it of items) {
    const store = it.type === 'turn' ? 'turns' : (it.type === 'chat' ? 'chats' : 'meta');
    const id = it.type === 'settings' ? META_SETTINGS(user) : it.id;
    const local = await reqToPromise((await tx(store, 'readonly')).get(id));

    if (local) {
      const localTs = local.updatedAt || local.createdAt || 0;
      if (it.updatedAt <= localTs) continue;            // remote not newer -> keep local
      if (local.dirty && localTs >= it.updatedAt) continue; // local pending wins on ties
    }

    if (it.deleted) {
      if (it.type === 'settings') {
        await reqToPromise((await tx('meta', 'readwrite')).put({
          key: id, user, type: 'settings', createdAt: it.createdAt,
          updatedAt: it.updatedAt, deleted: 1, dirty: 0, enc: null,
        }));
      } else if (local) {
        await reqToPromise((await tx(store, 'readwrite')).delete(id));
      }
      applied++;
      continue;
    }

    const enc = { iv: it.iv, ct: it.ct };
    if (it.type === 'chat') {
      await wrapWrite(reqToPromise((await tx('chats', 'readwrite')).put({
        id: it.id, user, createdAt: it.createdAt, updatedAt: it.updatedAt, deleted: 0, dirty: 0, enc,
      })));
    } else if (it.type === 'turn') {
      await wrapWrite(reqToPromise((await tx('turns', 'readwrite')).put({
        id: it.id, chatId: it.parentId, user, createdAt: it.createdAt,
        updatedAt: it.updatedAt, deleted: 0, dirty: 0, enc,
      })));
    } else {
      await wrapWrite(reqToPromise((await tx('meta', 'readwrite')).put({
        key: id, user, type: 'settings', createdAt: it.createdAt,
        updatedAt: it.updatedAt, deleted: 0, dirty: 0, enc,
      })));
    }
    applied++;
  }
  return applied;
}

// Flag all of a user's existing local data for upload (used the first time a
// previously local-only account is linked to the sync server, and after an
// online password change re-encrypts all ciphertext under a new Key A).
export async function markAllDirty(user) {
  const chatRows = await reqToPromise((await tx('chats', 'readonly')).index('user').getAll(IDBKeyRange.only(user)));
  for (const r of chatRows) {
    r.dirty = 1; if (r.updatedAt == null) r.updatedAt = r.createdAt || Date.now();
    await reqToPromise((await tx('chats', 'readwrite')).put(r));
  }
  const turnRows = await reqToPromise((await tx('turns', 'readonly')).index('user').getAll(IDBKeyRange.only(user)));
  for (const r of turnRows) {
    r.dirty = 1; if (r.updatedAt == null) r.updatedAt = r.createdAt || Date.now();
    await reqToPromise((await tx('turns', 'readwrite')).put(r));
  }
  const settingsRow = await reqToPromise((await tx('meta', 'readonly')).get(META_SETTINGS(user)));
  if (settingsRow) {
    settingsRow.dirty = 1;
    if (settingsRow.updatedAt == null) settingsRow.updatedAt = settingsRow.createdAt || Date.now();
    await reqToPromise((await tx('meta', 'readwrite')).put(settingsRow));
  }
}
