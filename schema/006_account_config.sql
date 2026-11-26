-- 006: per-account configuration + per-account pool selection.
-- The global settings table keeps defaults / app-level keys; account_settings overrides them.

CREATE TABLE IF NOT EXISTS account_settings (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, name)
);

CREATE TABLE IF NOT EXISTS account_pools (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  pool_id    INTEGER NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  enabled    INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (account_id, pool_id)
);

-- Copy the old global values once, so each account starts from today's behavior.
INSERT OR IGNORE INTO account_settings (account_id, name, value)
SELECT a.id, 'minGapMinutes', COALESCE((SELECT value FROM settings WHERE key = 'minGapMinutes'), '5')
FROM accounts a;

INSERT OR IGNORE INTO account_settings (account_id, name, value)
SELECT a.id, 'totalMin', COALESCE((SELECT value FROM settings WHERE key = 'totalMin'), '0')
FROM accounts a;

INSERT OR IGNORE INTO account_settings (account_id, name, value)
SELECT a.id, 'totalMax', COALESCE((SELECT value FROM settings WHERE key = 'totalMax'), '0')
FROM accounts a;

INSERT OR IGNORE INTO account_settings (account_id, name, value)
SELECT a.id, 'banWords', COALESCE((SELECT value FROM settings WHERE key = 'banWords'), '[]')
FROM accounts a;

INSERT OR IGNORE INTO account_settings (account_id, name, value)
SELECT a.id, 'maxVideoAgeDays', COALESCE((SELECT value FROM settings WHERE key = 'maxVideoAgeDays'), '7')
FROM accounts a;

INSERT OR IGNORE INTO account_settings (account_id, name, value)
SELECT a.id, 'poolDelayMs', COALESCE((SELECT value FROM settings WHERE key = 'poolDelayMs'), '2500')
FROM accounts a;

INSERT OR IGNORE INTO account_settings (account_id, name, value)
SELECT a.id, 'sendMode', COALESCE((SELECT value FROM settings WHERE key = 'sendMode'), 'auto')
FROM accounts a;

-- dailyTotal is the new simple schedule knob. Prefer the old upper bound when it was set;
-- otherwise derive a middle value from the band floors/caps (single-band installs get 1..30).
INSERT OR IGNORE INTO account_settings (account_id, name, value)
SELECT
  a.id,
  'dailyTotal',
  CASE
    WHEN COALESCE(CAST((SELECT value FROM settings WHERE key = 'totalMax') AS INTEGER), 0) > 0
      THEN (SELECT value FROM settings WHERE key = 'totalMax')
    ELSE CAST(
      MAX(1, MIN(30, (
        SELECT COALESCE(SUM(b.min_count + b.max_count), 0) / 2
        FROM bands b
        WHERE b.account_id = a.id
      ))) AS TEXT)
  END
FROM accounts a;

INSERT OR IGNORE INTO account_pools (account_id, pool_id, enabled)
SELECT a.id, p.id, p.enabled
FROM accounts a
CROSS JOIN pools p;
