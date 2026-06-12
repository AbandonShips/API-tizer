-- API-Tizer zero-knowledge sync — Cloudflare D1 schema.
-- The server only ever stores opaque ciphertext + routing metadata. It never
-- sees the data key (Key A) and therefore cannot read any user content.

CREATE TABLE IF NOT EXISTS users (
  username        TEXT    PRIMARY KEY,   -- normalised (lowercase) id
  kdf_salt        TEXT    NOT NULL,      -- base64 PBKDF2 salt (NOT secret)
  kdf_iterations  INTEGER NOT NULL,      -- PBKDF2 iteration count
  auth_salt       TEXT    NOT NULL,      -- base64 salt for the server-side auth hash
  auth_hash       TEXT    NOT NULL,      -- base64 PBKDF2 hash of Key B (auth token)
  created_at      INTEGER NOT NULL
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
