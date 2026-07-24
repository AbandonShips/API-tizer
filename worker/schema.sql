-- API-Tizer zero-knowledge sync — Cloudflare D1 schema.
-- The server only ever stores opaque ciphertext + routing metadata. It never
-- sees the data key (Key A) and therefore cannot read any user content.

CREATE TABLE IF NOT EXISTS users (
  username         TEXT    PRIMARY KEY,   -- normalised (lowercase) id
  kdf_salt         TEXT    NOT NULL,      -- base64 PBKDF2 salt (NOT secret)
  kdf_iterations   INTEGER NOT NULL,      -- PBKDF2 iteration count
  auth_salt        TEXT    NOT NULL,      -- base64 salt for the server-side auth hash
  auth_hash        TEXT    NOT NULL,      -- base64 PBKDF2 hash of Key B (auth token)
  created_at       INTEGER NOT NULL,
  auth_changed_at  INTEGER NOT NULL DEFAULT 0  -- ms of last credential change; tokens issued before this are rejected
);

-- One row per syncable record (chat / turn / settings). `iv`+`ct` hold the
-- AES-GCM envelope; everything human-readable lives inside that ciphertext.
CREATE TABLE IF NOT EXISTS items (
  username    TEXT    NOT NULL,
  id          TEXT    NOT NULL,          -- stable record id (uuid) or 'settings'
  type        TEXT    NOT NULL,          -- 'chat' | 'turn' | 'settings'
  parent_id   TEXT,                      -- chatId for turns, else NULL
  created_at  INTEGER,
  updated_at  INTEGER NOT NULL,          -- server-assigned, drives delta sync
  deleted     INTEGER NOT NULL DEFAULT 0,
  iv          TEXT,
  ct          TEXT,
  PRIMARY KEY (username, id)
);

-- The delta-sync hot path: "give me everything for this user changed since T".
CREATE INDEX IF NOT EXISTS idx_items_user_updated ON items(username, updated_at);

-- Public read-only share links (ChatGPT/Gemini-style). Same zero-knowledge rule:
-- the decryption key lives ONLY in the link's URL fragment (#), never reaches the
-- server, so `iv`+`ct` are an opaque snapshot the server cannot read. Everything
-- human-readable (title, date, messages) is encrypted INSIDE `ct` — the row keeps
-- only routing metadata. Shares are frozen snapshots and auto-expire.
CREATE TABLE IF NOT EXISTS shares (
  id          TEXT    PRIMARY KEY,      -- random public share id (URL-safe)
  username    TEXT    NOT NULL,         -- owner (server already knows it; NOT content metadata)
  created_at  INTEGER NOT NULL,         -- server time the share was created (NOT the conversation date)
  expires_at  INTEGER NOT NULL,         -- created_at + TTL; reads past this are rejected
  iv          TEXT    NOT NULL,         -- AES-GCM envelope; the fresh per-share key is never sent here
  ct          TEXT    NOT NULL          -- opaque ciphertext snapshot (title/date/messages all inside)
);

-- Cron cleanup path: "delete everything already expired".
CREATE INDEX IF NOT EXISTS idx_shares_expires ON shares(expires_at);
