-- 001_init.sql — base schema for the Douyin forwarder
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- one row per sending account; profile_dir is a Playwright user data dir
CREATE TABLE IF NOT EXISTS accounts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  label       TEXT NOT NULL UNIQUE,
  profile_dir TEXT NOT NULL,
  port        INTEGER NOT NULL,
  friend      TEXT NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- tunables that are not per-account
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- video sources; keyword is a douyin search term, '@acg' means the 二次元 category page
CREATE TABLE IF NOT EXISTS pools (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL UNIQUE,
  keyword TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort    INTEGER NOT NULL DEFAULT 0
);

-- time bands per account; counts and window are all derived from these rows
CREATE TABLE IF NOT EXISTS bands (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  start_min  INTEGER NOT NULL,
  end_min    INTEGER NOT NULL,
  min_count  INTEGER NOT NULL DEFAULT 1,
  max_count  INTEGER NOT NULL DEFAULT 3,
  sort       INTEGER NOT NULL DEFAULT 0
);

-- one row per day per account: the concrete schedule that was generated
CREATE TABLE IF NOT EXISTS plans (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  day        TEXT NOT NULL,
  times_json TEXT NOT NULL DEFAULT '[]',
  done_json  TEXT NOT NULL DEFAULT '[]',
  skipped    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, day)
);

CREATE TABLE IF NOT EXISTS sends (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ts         TEXT NOT NULL,
  bucket     TEXT NOT NULL DEFAULT '',
  title      TEXT NOT NULL DEFAULT '',
  author     TEXT NOT NULL DEFAULT '',
  likes      INTEGER NOT NULL DEFAULT 0,
  friend     TEXT NOT NULL DEFAULT '',
  ok         INTEGER NOT NULL DEFAULT 0,
  toast      TEXT NOT NULL DEFAULT '',
  shot       TEXT,
  video_id   TEXT,
  day        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sends_day ON sends(day);
CREATE INDEX IF NOT EXISTS idx_sends_account ON sends(account_id, ts);

CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL DEFAULT (datetime('now')),
  event   TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
