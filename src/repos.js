/**
 * @file Repository layer — every SQL statement in the project lives here; callers never write SQL.
 */
// Repository helpers — every DB read/write goes through here.
const db = require('./db');

const dialect = () => db.dialect || 'sqlite';
const isMysql = () => dialect() === 'mysql';
const isPostgres = () => dialect() === 'postgres';
const isSqlite = () => dialect() === 'sqlite';
// MySQL treats KEY as a reserved word; PostgreSQL is happy with either but quoting is safest.
const keyCol = () => (isMysql() ? '`key`' : isPostgres() ? '"key"' : 'key');
const nowSql = () => (isSqlite() ? "datetime('now')" : 'CURRENT_TIMESTAMP');

const nowIso = () => new Date().toISOString();

// ---------- settings ----------
function parseValue(raw) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    return raw;
  }
}

function getSetting(key, fallback = null) {
  const row = db.open().prepare(`SELECT value FROM settings WHERE ${keyCol()} = ?`).get(key);
  if (!row) return fallback;
  return parseValue(row.value);
}

function setSetting(key, value) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  const sql = isMysql()
    ? `INSERT INTO settings (${keyCol()}, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)`
    : `INSERT INTO settings (${keyCol()}, value) VALUES (?, ?) ON CONFLICT (${keyCol()}) DO UPDATE SET value = excluded.value`;
  db.open().prepare(sql).run(key, raw);
}

// ---------- per-account settings ----------
// Reading order: account override -> global default -> caller fallback.
function getAccountSetting(accountId, name, fallback = null) {
  const conn = db.open();
  const row = conn
    .prepare('SELECT value FROM account_settings WHERE account_id = ? AND name = ?')
    .get(accountId, name);
  if (row) return parseValue(row.value);
  const global = conn.prepare(`SELECT value FROM settings WHERE ${keyCol()} = ?`).get(name);
  if (global) return parseValue(global.value);
  return fallback;
}

function setAccountSetting(accountId, name, value) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  const sql = isMysql()
    ? `INSERT INTO account_settings (account_id, name, value, updated_at)
       VALUES (?, ?, ?, ${nowSql()})
       ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`
    : `INSERT INTO account_settings (account_id, name, value, updated_at)
       VALUES (?, ?, ?, ${nowSql()})
       ON CONFLICT(account_id, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;
  db.open().prepare(sql).run(accountId, name, raw);
}

function listAccountSettings(accountId) {
  const rows = db.open()
    .prepare('SELECT name, value FROM account_settings WHERE account_id = ? ORDER BY name')
    .all(accountId);
  const out = {};
  for (const row of rows) out[row.name] = parseValue(row.value);
  return out;
}

function hasAccountSetting(accountId, name) {
  return !!db.open()
    .prepare('SELECT 1 AS hit FROM account_settings WHERE account_id = ? AND name = ?')
    .get(accountId, name);
}

function deleteAccountSetting(accountId, name) {
  db.open().prepare('DELETE FROM account_settings WHERE account_id = ? AND name = ?').run(accountId, name);
}

const DEFAULT_ACCOUNT_SETTINGS = {
  minGapMinutes: 5,
  totalMin: 0,
  totalMax: 0,
  dailyTotal: 6,
  banWords: [],
  maxVideoAgeDays: 7,
  recommendMaxAgeDays: 30,
  poolDelayMs: 2500,
  sendMode: 'auto',
};

function deriveDailyTotal(accountId) {
  const totalMax = Number(getAccountSetting(accountId, 'totalMax', getSetting('totalMax', 0))) || 0;
  if (totalMax > 0) return Math.min(200, Math.round(totalMax));
  const bands = listBands(accountId);
  if (!bands.length) return DEFAULT_ACCOUNT_SETTINGS.dailyTotal;
  const sum = bands.reduce((a, b) => a + Number(b.min_count || 0) + Number(b.max_count || 0), 0);
  return Math.max(1, Math.min(30, Math.round(sum / 2)));
}

// Seed a new account from the global defaults, then from its bands (if any).
function seedAccountDefaults(accountId, { overwrite = false, dailyTotal = null } = {}) {
  for (const [name, dflt] of Object.entries(DEFAULT_ACCOUNT_SETTINGS)) {
    if (!overwrite && hasAccountSetting(accountId, name)) continue;
    if (name === 'dailyTotal') continue;
    setAccountSetting(accountId, name, getSetting(name, dflt));
  }
  const existing = getAccountSetting(accountId, 'dailyTotal', null);
  if (overwrite || existing === null) {
    setAccountSetting(accountId, 'dailyTotal', dailyTotal == null ? deriveDailyTotal(accountId) : dailyTotal);
  }
  if (isMysql()) {
    // MySQL rejects selecting from the insert target in NOT EXISTS; INSERT IGNORE is the
    // portable duplicate-safe form here.
    db.open()
      .prepare('INSERT IGNORE INTO account_pools (account_id, pool_id, enabled) SELECT ?, p.id, p.enabled FROM pools p')
      .run(accountId);
  } else if (isPostgres()) {
    db.open()
      .prepare(
        `INSERT INTO account_pools (account_id, pool_id, enabled)
         SELECT ?, id, enabled FROM pools
         ON CONFLICT(account_id, pool_id) DO NOTHING`
      )
      .run(accountId);
  } else {
    db.open()
      .prepare('INSERT OR IGNORE INTO account_pools (account_id, pool_id, enabled) SELECT ?, id, enabled FROM pools')
      .run(accountId);
  }
}

// ---------- burst (定时连发) runtime state ----------
// Progress is a JSON blob in account_settings: one burst per account per day. It is runtime
// state, not configuration, so it is never seeded or listed as a config field.
const BURST_STATE_KEY = 'burstState';

function getBurstState(accountId) {
  const value = getAccountSetting(accountId, BURST_STATE_KEY, null);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function saveBurstState(accountId, state) {
  setAccountSetting(accountId, BURST_STATE_KEY, state);
  return state;
}

function clearBurstState(accountId) {
  deleteAccountSetting(accountId, BURST_STATE_KEY);
}

// ---------- slow mail (慢递) runtime state ----------
// One ad-hoc session per account: timing config is frozen inside the state, so the dashboard
// only writes it on start/stop. Like burstState it is runtime data, not a seeded config field.
const SLOW_MAIL_STATE_KEY = 'slowMailState';

function getSlowMailState(accountId) {
  const value = getAccountSetting(accountId, SLOW_MAIL_STATE_KEY, null);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function saveSlowMailState(accountId, state) {
  setAccountSetting(accountId, SLOW_MAIL_STATE_KEY, state);
  return state;
}

function clearSlowMailState(accountId) {
  deleteAccountSetting(accountId, SLOW_MAIL_STATE_KEY);
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
  const sql = isMysql()
    ? `INSERT INTO accounts (label, profile_dir, port, friend, enabled) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE profile_dir = VALUES(profile_dir), port = VALUES(port),
         friend = VALUES(friend), enabled = VALUES(enabled)`
    : `INSERT INTO accounts (label, profile_dir, port, friend, enabled) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(label) DO UPDATE SET profile_dir = excluded.profile_dir, port = excluded.port,
         friend = excluded.friend, enabled = excluded.enabled`;
  conn.prepare(sql).run(label, profileDir, port, friend, enabled ? 1 : 0);
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
  const sql = isMysql()
    ? `INSERT INTO friends (account_id, name, enabled, sort, userid) VALUES (?, ?, 1, 0, ?)
       ON DUPLICATE KEY UPDATE userid = IF(VALUES(userid) <> '', VALUES(userid), userid)`
    : `INSERT INTO friends (account_id, name, enabled, sort, userid) VALUES (?, ?, 1, 0, ?)
       ON CONFLICT(account_id, name) DO UPDATE SET userid = CASE WHEN excluded.userid <> '' THEN excluded.userid ELSE friends.userid END`;
  db.open().prepare(sql).run(accountId, clean, uid);
  syncAccountFriend(accountId);
  return listFriends(accountId);
}

function getFriendByName(accountId, name) {
  return db.open().prepare('SELECT * FROM friends WHERE account_id = ? AND name = ?').get(accountId, String(name || '').trim()) || null;
}

// UID is the stable identity; names are display labels and may change on Douyin. These helpers
// let the mutual-list sync keep a friend row current without ever matching by nickname alone.
function getFriendByUid(accountId, userid) {
  const uid = String(userid || '').trim();
  if (!uid) return null;
  return db.open().prepare('SELECT * FROM friends WHERE account_id = ? AND userid = ?').get(accountId, uid) || null;
}

function updateFriendName(accountId, friendId, name) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('好友昵称不能为空');
  db.open().prepare('UPDATE friends SET name = ? WHERE id = ? AND account_id = ?').run(clean, friendId, accountId);
  syncAccountFriend(accountId);
  return true;
}

function setFriendUserid(accountId, friendId, userid) {
  db.open().prepare('UPDATE friends SET userid = ? WHERE id = ? AND account_id = ?')
    .run(String(userid || '').trim(), friendId, accountId);
  return true;
}

/**
 * Add/refresh a friend using UID as the key. If the UID already exists, update its display
 * name (when free); if a name-only row exists, attach the UID instead of creating a duplicate.
 * A nickname already owned by a different UID is a conflict, never a silent overwrite.
 */
function upsertFriendByUid(accountId, name, userid) {
  const clean = String(name || '').trim();
  const uid = String(userid || '').trim();
  if (!clean) throw new Error('好友昵称不能为空');
  const conn = db.open();
  if (uid) {
    const byUid = conn.prepare('SELECT * FROM friends WHERE account_id = ? AND userid = ?').get(accountId, uid);
    if (byUid) {
      if (byUid.name !== clean) {
        const clash = conn.prepare('SELECT id FROM friends WHERE account_id = ? AND name = ? AND id <> ?').get(accountId, clean, byUid.id);
        if (clash) throw new Error(`昵称「${clean}」已被另一位好友占用`);
        conn.prepare('UPDATE friends SET name = ? WHERE id = ?').run(clean, byUid.id);
      }
      syncAccountFriend(accountId);
      return listFriends(accountId);
    }
    const byName = conn.prepare('SELECT * FROM friends WHERE account_id = ? AND name = ?').get(accountId, clean);
    if (byName) {
      const oldUid = String(byName.userid || '').trim();
      if (!oldUid) {
        conn.prepare('UPDATE friends SET userid = ? WHERE id = ?').run(uid, byName.id);
        syncAccountFriend(accountId);
        return listFriends(accountId);
      }
      if (oldUid === uid) return listFriends(accountId);
      throw new Error(`昵称「${clean}」已被另一位好友占用（UID 不同）`);
    }
  }
  return addFriend(accountId, clean, uid);
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

function batchAddFriends(accountId, entries = []) {
  const list = Array.isArray(entries) ? entries : [];
  const conn = db.open();
  let added = 0;
  let skipped = 0;
  const errors = [];
  conn.exec('BEGIN');
  try {
    for (const item of list) {
      const name = String((item && item.name) || '').trim();
      const userid = String((item && (item.userid || item.uid)) || '').trim();
      if (!name) { skipped++; continue; }
      try {
        if (userid) upsertFriendByUid(accountId, name, userid);
        else addFriend(accountId, name);
        added++;
      } catch (e) {
        errors.push(`${name}: ${(e && e.message) || '添加失败'}`);
      }
    }
    syncAccountFriend(accountId);
    conn.exec('COMMIT');
  } catch (e) {
    conn.exec('ROLLBACK');
    throw e;
  }
  return { added, skipped, failed: errors.length, errors, friends: listFriends(accountId) };
}

const RUNTIME_SETTING_KEYS = new Set([
  BURST_STATE_KEY,
  SLOW_MAIL_STATE_KEY,
  'autoReadState',
  'slowMailFriend',
  'slowMailFriendUid',
  'autoReadFriends',
  'autoReadEnabled',
]);

function copyAccountConfig(fromAccountId, toAccountId) {
  if (fromAccountId === toAccountId) return { copiedSettings: 0, copiedPools: 0 };
  const settings = listAccountSettings(fromAccountId);
  const pools = listAccountPools(fromAccountId);
  const conn = db.open();
  let copiedSettings = 0;
  let copiedPools = 0;
  conn.exec('BEGIN');
  try {
    for (const [name, value] of Object.entries(settings)) {
      if (RUNTIME_SETTING_KEYS.has(name)) continue;
      setAccountSetting(toAccountId, name, value);
      copiedSettings++;
    }
    for (const p of pools) {
      setAccountPoolEnabled(toAccountId, p.name, !!p.enabled);
      copiedPools++;
    }
    conn.exec('COMMIT');
  } catch (e) {
    conn.exec('ROLLBACK');
    throw e;
  }
  return { copiedSettings, copiedPools };
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
  const sql = isMysql()
    ? 'INSERT IGNORE INTO pools (name, keyword, enabled, sort) VALUES (?, ?, ?, ?)'
    : 'INSERT INTO pools (name, keyword, enabled, sort) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO NOTHING';
  const stmt = conn.prepare(sql);
  entries.forEach((e, i) => stmt.run(e.name, e.keyword, e.enabled === false ? 0 : 1, i));
}

function setPoolEnabled(name, enabled) {
  db.open().prepare('UPDATE pools SET enabled = ? WHERE name = ?').run(enabled ? 1 : 0, name);
}

// Per-account pool selection. Rows missing from account_pools fall back to pools.enabled
// (that is how pools added by a later version appear for existing accounts).
function listAccountPools(accountId) {
  return db
    .open()
    .prepare(
      `SELECT p.id, p.name, p.keyword, p.sort,
              ph.parent_id AS parent_id, parent.name AS parent_name,
              COALESCE(ap.enabled, p.enabled) AS enabled
       FROM pools p
       LEFT JOIN account_pools ap ON ap.pool_id = p.id AND ap.account_id = ?
       LEFT JOIN pool_hierarchy ph ON ph.pool_id = p.id
       LEFT JOIN pools parent ON parent.id = ph.parent_id
       ORDER BY p.sort, p.id`
    )
    .all(accountId)
    .map((row) => ({ ...row, enabled: !!row.enabled }));
}

function addPool({ name, keyword, parentName = null, enabled = false, sort = null } = {}) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) throw new Error('分类名不能为空');
  const conn = db.open();
  let row = conn.prepare('SELECT * FROM pools WHERE name = ?').get(clean);
  if (!row) {
    const max = conn.prepare('SELECT COALESCE(MAX(sort), 0) AS n FROM pools').get().n || 0;
    conn.prepare('INSERT INTO pools (name, keyword, enabled, sort) VALUES (?, ?, ?, ?)')
      .run(clean, String(keyword || clean).trim().slice(0, 80), enabled ? 1 : 0, sort == null ? max + 1 : sort);
    row = conn.prepare('SELECT * FROM pools WHERE name = ?').get(clean);
  }
  if (parentName) {
    const parent = conn.prepare('SELECT id, name FROM pools WHERE name = ?').get(String(parentName).trim());
    if (parent && parent.id !== row.id) {
      const sql = isMysql()
        ? 'INSERT INTO pool_hierarchy (pool_id, parent_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE parent_id = VALUES(parent_id)'
        : 'INSERT INTO pool_hierarchy (pool_id, parent_id) VALUES (?, ?) ON CONFLICT(pool_id) DO UPDATE SET parent_id = excluded.parent_id';
      conn.prepare(sql).run(row.id, parent.id);
      row.parent_id = parent.id;
      row.parent_name = parent.name;
    }
  }
  return row;
}

function setAccountPoolEnabled(accountId, poolName, enabled) {
  const conn = db.open();
  const pool = conn.prepare('SELECT id FROM pools WHERE name = ?').get(String(poolName || ''));
  if (!pool) return false;
  const sql = isMysql()
    ? `INSERT INTO account_pools (account_id, pool_id, enabled) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE enabled = VALUES(enabled)`
    : `INSERT INTO account_pools (account_id, pool_id, enabled) VALUES (?, ?, ?)
       ON CONFLICT(account_id, pool_id) DO UPDATE SET enabled = excluded.enabled`;
  conn.prepare(sql).run(accountId, pool.id, enabled ? 1 : 0);
  return true;
}

function deletePool(name) {
  const clean = String(name || '').trim();
  if (!clean) return { deleted: false, children: [] };
  const conn = db.open();
  const row = conn.prepare('SELECT id, name FROM pools WHERE name = ?').get(clean);
  if (!row) return { deleted: false, children: [] };
  const childIds = conn
    .prepare('SELECT pool_id FROM pool_hierarchy WHERE parent_id = ?')
    .all(row.id)
    .map((r) => r.pool_id);
  const childNames = childIds
    .map((id) => conn.prepare('SELECT name FROM pools WHERE id = ?').get(id))
    .filter(Boolean)
    .map((r) => r.name);
  for (const id of [row.id, ...childIds]) {
    conn.prepare('DELETE FROM pool_hierarchy WHERE pool_id = ? OR parent_id = ?').run(id, id);
    conn.prepare('DELETE FROM account_pools WHERE pool_id = ?').run(id);
    conn.prepare('DELETE FROM pools WHERE id = ?').run(id);
  }
  return { deleted: true, name: row.name, children: childNames };
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
  const sql = isMysql()
    ? `INSERT INTO plans (account_id, day, times_json, done_json, failed_json, skipped)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE times_json = VALUES(times_json), done_json = VALUES(done_json),
         failed_json = VALUES(failed_json), skipped = VALUES(skipped)`
    : `INSERT INTO plans (account_id, day, times_json, done_json, failed_json, skipped)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, day) DO UPDATE SET times_json = excluded.times_json,
         done_json = excluded.done_json, failed_json = excluded.failed_json, skipped = excluded.skipped`;
  db.open().prepare(sql).run(accountId, day, JSON.stringify(times), JSON.stringify(done), JSON.stringify(failed), skipped ? 1 : 0);
  return getPlan(accountId, day);
}

// ---------- sends ----------
function insertSend(s) {
  db.open()
    .prepare(
      `INSERT INTO sends (account_id, ts, bucket, title, author, likes, friend, ok, toast, shot, video_id, day, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      s.accountId, s.ts || nowIso(), s.bucket || '', s.title || '', s.author || '',
      s.likes || 0, s.friend || '', s.ok ? 1 : 0, s.toast || '', s.shot || null,
      s.videoId || null, s.day, s.source === 'recommend' ? 'recommend' : 'pool'
    );
}

function buildSendWhere({ accountId = null, bucket = '', ok = null, search = '' } = {}) {
  const where = [];
  const params = [];
  if (accountId != null) { where.push('account_id = ?'); params.push(accountId); }
  const b = String(bucket || '').trim();
  if (b) { where.push('bucket = ?'); params.push(b); }
  if (ok === true || ok === 1) { where.push('ok = 1'); }
  else if (ok === false || ok === 0) { where.push('ok = 0'); }
  const q = String(search || '').trim().toLowerCase();
  if (q) {
    const like = `%${q}%`;
    where.push('(LOWER(title) LIKE ? OR LOWER(author) LIKE ? OR LOWER(friend) LIKE ?)');
    params.push(like, like, like);
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

function countSends(filters = {}) {
  const { clause, params } = buildSendWhere(filters);
  const row = db.open().prepare(`SELECT COUNT(*) AS c FROM sends ${clause}`).get(...params);
  return row ? Number(row.c) : 0;
}

function countSendsByAccount() {
  const rows = db.open().prepare('SELECT account_id, COUNT(*) AS c FROM sends GROUP BY account_id').all();
  const out = {};
  for (const r of rows) out[r.account_id] = Number(r.c);
  return out;
}

function querySends({ accountId = null, bucket = '', ok = null, search = '', limit = 20, offset = 0 } = {}) {
  const { clause, params } = buildSendWhere({ accountId, bucket, ok, search });
  const safeLimit = Math.min(5000, Math.max(1, Math.round(Number(limit) || 20)));
  const safeOffset = Math.max(0, Math.round(Number(offset) || 0));
  const rows = db.open()
    .prepare(`SELECT * FROM sends ${clause} ORDER BY ts DESC LIMIT ? OFFSET ?`)
    .all(...params, safeLimit, safeOffset);
  return rows.map((r) => ({ ...r, ok: !!r.ok }));
}

function listSendBuckets(accountId = null) {
  const conn = db.open();
  const rows = accountId != null
    ? conn.prepare("SELECT DISTINCT bucket FROM sends WHERE account_id = ? AND bucket <> '' ORDER BY bucket").all(accountId)
    : conn.prepare("SELECT DISTINCT bucket FROM sends WHERE bucket <> '' ORDER BY bucket").all();
  return rows.map((r) => r.bucket).filter(Boolean);
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
  return row ? Number(row.c) : 0;
}

// Successful sends today per friend, used to rotate friends fairly.
function friendSendCounts(accountId, day) {
  const rows = db.open()
    .prepare('SELECT friend, COUNT(*) n FROM sends WHERE account_id = ? AND day = ? AND ok = 1 GROUP BY friend')
    .all(accountId, day);
  const counts = {};
  for (const row of rows) counts[row.friend] = Number(row.n);
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
  const rows = accountId ? conn.prepare(sql).all(accountId) : conn.prepare(sql).all();
  return rows.map((row) => ({ ...row, n: Number(row.n) }));
}

// ---------- events ----------
function logEvent(event, payload = {}, ts = null) {
  // Explicit duplicate check works on SQLite/PostgreSQL/MySQL without relying on an
  // INSERT OR IGNORE / ON CONFLICT variant. Real-time events get a fresh ts; re-imported
  // legacy events keep their original ts and are therefore idempotent.
  const conn = db.open();
  const at = ts || nowIso();
  const raw = JSON.stringify(payload);
  const exists = conn.prepare('SELECT 1 AS hit FROM events WHERE ts = ? AND event = ? AND payload = ?').get(at, event, raw);
  if (!exists) conn.prepare('INSERT INTO events (ts, event, payload) VALUES (?, ?, ?)').run(at, event, raw);
}

function listEvents(limit = 50) {
  return db.open().prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
}

module.exports = {
  nowIso,
  getSetting, setSetting,
  getAccountSetting, setAccountSetting, listAccountSettings, hasAccountSetting, deleteAccountSetting,
  getBurstState, saveBurstState, clearBurstState,
  getSlowMailState, saveSlowMailState, clearSlowMailState,
  seedAccountDefaults, deriveDailyTotal, DEFAULT_ACCOUNT_SETTINGS,
  getAccount, upsertAccount, updateAccountDisplayName, listAccounts, setAccountEnabled,
  listFriends, listEnabledFriendNames, addFriend, getFriendByName, getFriendByUid,
  updateFriendName, setFriendUserid, upsertFriendByUid,
  setFriendEnabled, removeFriend, batchAddFriends, copyAccountConfig, syncAccountFriend,
  listPools, seedPools, setPoolEnabled, addPool, deletePool, listAccountPools, setAccountPoolEnabled,
  listBands, replaceBands,
  getPlan, savePlan,
  insertSend, listSends, countSends, countSendsByAccount, querySends, listSendBuckets,
  countSendsByDay, friendSendCounts, listRecentSentVideos, bucketStats,
  logEvent, listEvents,
};
