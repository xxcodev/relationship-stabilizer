/**
 * @file Repository layer — every SQL statement in the project lives here; callers never write SQL.
 */
// Repository helpers — every DB read/write goes through here.
const db = require('./db');

const nowIso = () => new Date().toISOString();

// ---------- settings ----------
function getSetting(key, fallback = null) {
  const row = db.open().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch (e) {
    return row.value;
  }
}

function setSetting(key, value) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  db.open()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, raw);
}

// ---------- accounts ----------
function getAccount(label) {
  const conn = db.open();
  const row = label
    ? conn.prepare('SELECT * FROM accounts WHERE label = ?').get(label)
    : conn
        .prepare(
          `SELECT * FROM accounts
           ORDER BY (SELECT COUNT(*) FROM bands b WHERE b.account_id = accounts.id) DESC, id ASC
           LIMIT 1`
        )
        .get();
  return row || null;
}

function updateAccountDisplayName(accountId, name) {
  db.open().prepare('UPDATE accounts SET display_name = ? WHERE id = ?').run(String(name || '').trim(), accountId);
}

function listAccounts() {
  return db.open().prepare('SELECT * FROM accounts ORDER BY id').all();
}

function setAccountEnabled(accountId, enabled) {
  db.open().prepare('UPDATE accounts SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, accountId);
}

function upsertAccount({ label, profileDir, port, friend = '', enabled = true }) {
  const conn = db.open();
  conn
    .prepare(
      `INSERT INTO accounts (label, profile_dir, port, friend, enabled) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(label) DO UPDATE SET profile_dir = excluded.profile_dir, port = excluded.port,
         friend = excluded.friend, enabled = excluded.enabled`
    )
    .run(label, profileDir, port, friend, enabled ? 1 : 0);
  return getAccount(label);
}

// ---------- friends ----------
function listFriends(accountId) {
  return db
    .open()
    .prepare('SELECT * FROM friends WHERE account_id = ? ORDER BY sort, id')
    .all(accountId);
}

function listEnabledFriendNames(accountId) {
  return db
    .open()
    .prepare('SELECT name FROM friends WHERE account_id = ? AND enabled = 1 ORDER BY sort, id')
    .all(accountId)
    .map((r) => r.name);
}

function addFriend(accountId, name, userid = '') {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('好友昵称不能为空');
  const uid = String(userid || '').trim();
  db.open()
    .prepare(`INSERT INTO friends (account_id, name, enabled, sort, userid) VALUES (?, ?, 1, 0, ?)
      ON CONFLICT(account_id, name) DO UPDATE SET userid = CASE WHEN excluded.userid <> '' THEN excluded.userid ELSE friends.userid END`)
    .run(accountId, clean, uid);
  syncAccountFriend(accountId);
  return listFriends(accountId);
}

function getFriendByName(accountId, name) {
  return db.open().prepare('SELECT * FROM friends WHERE account_id = ? AND name = ?').get(accountId, String(name || '').trim()) || null;
}

function setFriendEnabled(accountId, friendId, enabled) {
  db.open()
    .prepare('UPDATE friends SET enabled = ? WHERE id = ? AND account_id = ?')
    .run(enabled ? 1 : 0, friendId, accountId);
  syncAccountFriend(accountId);
}

function removeFriend(accountId, friendId) {
  db.open().prepare('DELETE FROM friends WHERE id = ? AND account_id = ?').run(friendId, accountId);
  syncAccountFriend(accountId);
}

// keep accounts.friend as a compatibility default (first enabled friend)
function syncAccountFriend(accountId) {
  const names = listEnabledFriendNames(accountId);
  db.open().prepare('UPDATE accounts SET friend = ? WHERE id = ?').run(names[0] || '', accountId);
}

// ---------- pools ----------
function listPools() {
  return db.open().prepare('SELECT * FROM pools ORDER BY sort, id').all();
}

function seedPools(entries) {
  const conn = db.open();
  const stmt = conn.prepare('INSERT INTO pools (name, keyword, enabled, sort) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO NOTHING');
  entries.forEach((e, i) => stmt.run(e.name, e.keyword, e.enabled === false ? 0 : 1, i));
}

function setPoolEnabled(name, enabled) {
  db.open().prepare('UPDATE pools SET enabled = ? WHERE name = ?').run(enabled ? 1 : 0, name);
}

// ---------- bands ----------
function listBands(accountId) {
  return db.open().prepare('SELECT * FROM bands WHERE account_id = ? ORDER BY sort, id').all(accountId);
}

function replaceBands(accountId, bands) {
  // no transaction here: callers may already hold one
  const conn = db.open();
  conn.prepare('DELETE FROM bands WHERE account_id = ?').run(accountId);
  const stmt = conn.prepare(
    'INSERT INTO bands (account_id, name, start_min, end_min, min_count, max_count, sort) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  bands.forEach((b, i) => stmt.run(accountId, b.name, b.startMin, b.endMin, b.minCount, b.maxCount, i));
}

// ---------- plans ----------
function getPlan(accountId, day) {
  const row = db.open().prepare('SELECT * FROM plans WHERE account_id = ? AND day = ?').get(accountId, day);
  if (!row) return null;
  return {
    ...row,
    times: JSON.parse(row.times_json || '[]'),
    done: JSON.parse(row.done_json || '[]'),
    failed: JSON.parse(row.failed_json || '[]'),
    skipped: !!row.skipped,
  };
}

function savePlan(accountId, day, { times, done = [], failed = [], skipped = false }) {
  db.open()
    .prepare(
      `INSERT INTO plans (account_id, day, times_json, done_json, failed_json, skipped)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, day) DO UPDATE SET times_json = excluded.times_json,
         done_json = excluded.done_json, failed_json = excluded.failed_json, skipped = excluded.skipped`
    )
    .run(accountId, day, JSON.stringify(times), JSON.stringify(done), JSON.stringify(failed), skipped ? 1 : 0);
  return getPlan(accountId, day);
}

// ---------- sends ----------
function insertSend(s) {
  db.open()
    .prepare(
      `INSERT INTO sends (account_id, ts, bucket, title, author, likes, friend, ok, toast, shot, video_id, day)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      s.accountId, s.ts || nowIso(), s.bucket || '', s.title || '', s.author || '',
      s.likes || 0, s.friend || '', s.ok ? 1 : 0, s.toast || '', s.shot || null,
      s.videoId || null, s.day
    );
}

function listSends({ accountId = null, limit = 100 } = {}) {
  const conn = db.open();
  const sql = accountId
    ? 'SELECT * FROM sends WHERE account_id = ? ORDER BY ts DESC LIMIT ?'
    : 'SELECT * FROM sends ORDER BY ts DESC LIMIT ?';
  const rows = accountId ? conn.prepare(sql).all(accountId, limit) : conn.prepare(sql).all(limit);
  return rows.map((r) => ({ ...r, ok: !!r.ok }));
}

function countSendsByDay(day, accountId = null) {
  const conn = db.open();
  const row = accountId
    ? conn.prepare('SELECT COUNT(*) c FROM sends WHERE day = ? AND ok = 1 AND account_id = ?').get(day, accountId)
    : conn.prepare('SELECT COUNT(*) c FROM sends WHERE day = ? AND ok = 1').get(day);
  return row ? row.c : 0;
}

// Successful sends today per friend, used to rotate friends fairly.
function friendSendCounts(accountId, day) {
  const rows = db.open()
    .prepare('SELECT friend, COUNT(*) n FROM sends WHERE account_id = ? AND day = ? AND ok = 1 GROUP BY friend')
    .all(accountId, day);
  const counts = {};
  for (const row of rows) counts[row.friend] = row.n;
  return counts;
}

// Recently delivered videos (successful only), used to avoid sending the same clip again.
function listRecentSentVideos(accountId, days = 30) {
  const since = new Date(Date.now() - Math.max(1, Number(days) || 30) * 86400000).toISOString();
  return db.open()
    .prepare(
      `SELECT video_id, title, friend, ts FROM sends
       WHERE account_id = ? AND ok = 1 AND ts >= ?
       ORDER BY ts DESC`
    )
    .all(accountId, since);
}

function bucketStats(accountId = null) {
  const conn = db.open();
  const sql = accountId
    ? 'SELECT bucket, COUNT(*) n FROM sends WHERE account_id = ? GROUP BY bucket ORDER BY n DESC'
    : 'SELECT bucket, COUNT(*) n FROM sends GROUP BY bucket ORDER BY n DESC';
  return accountId ? conn.prepare(sql).all(accountId) : conn.prepare(sql).all();
}

// ---------- events ----------
function logEvent(event, payload = {}, ts = null) {
  // unique index on (ts, event, payload): real-time events get a fresh ts,
  // re-imported legacy events keep their original ts and are therefore idempotent
  db.open()
    .prepare('INSERT OR IGNORE INTO events (ts, event, payload) VALUES (?, ?, ?)')
    .run(ts || nowIso(), event, JSON.stringify(payload));
}

function listEvents(limit = 50) {
  return db.open().prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
}

module.exports = {
  nowIso,
  getSetting, setSetting,
  getAccount, upsertAccount, updateAccountDisplayName, listAccounts, setAccountEnabled,
  listFriends, listEnabledFriendNames, addFriend, getFriendByName, setFriendEnabled, removeFriend, syncAccountFriend,
  listPools, seedPools, setPoolEnabled,
  listBands, replaceBands,
  getPlan, savePlan,
  insertSend, listSends, countSendsByDay, friendSendCounts, listRecentSentVideos, bucketStats,
  logEvent, listEvents,
};
