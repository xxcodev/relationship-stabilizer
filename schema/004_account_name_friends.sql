-- 004: account display names + per-account friend lists
ALTER TABLE accounts ADD COLUMN display_name TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS friends (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, name)
);

-- backfill the old single account.friend value
INSERT OR IGNORE INTO friends (account_id, name, enabled, sort)
SELECT id, friend, 1, 0 FROM accounts WHERE friend <> '';
