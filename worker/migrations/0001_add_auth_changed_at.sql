-- Existing D1 databases created before v1.2 need this column for token
-- invalidation after online password changes.
ALTER TABLE users ADD COLUMN auth_changed_at INTEGER NOT NULL DEFAULT 0;