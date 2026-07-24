-- Public read-only share links (zero-knowledge). The decryption key lives only in
-- the share link's URL fragment (#), never on the server, so iv+ct are an opaque
-- snapshot. Title/date/messages are all encrypted inside ct; the row keeps only
-- routing metadata. Shares are frozen snapshots that auto-expire.
CREATE TABLE IF NOT EXISTS shares (
  id          TEXT    PRIMARY KEY,
  username    TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  iv          TEXT    NOT NULL,
  ct          TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shares_expires ON shares(expires_at);
