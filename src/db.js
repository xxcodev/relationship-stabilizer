/**
 * @file SQLite connection and the numbered migration runner (schema/*.sql, tracked in the meta table).
 */
// SQLite access layer (node:sqlite, no native build step).
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const env = require('./env');

const SCHEMA_DIR = path.join(env.ROOT, 'schema');

let db = null;

function open(file = env.DB_FILE) {
  if (db) return db;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(conn) {
  conn.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  const applied = new Set(
    conn.prepare("SELECT value FROM meta WHERE key LIKE 'schema:%'").all().map((r) => r.value)
  );
  const files = fs.existsSync(SCHEMA_DIR)
    ? fs.readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.sql')).sort()
    : [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(SCHEMA_DIR, f), 'utf8');
    conn.exec('BEGIN');
    try {
      conn.exec(sql);
      conn.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema:' + f, f);
      conn.exec('COMMIT');
    } catch (e) {
      conn.exec('ROLLBACK');
      throw new Error(`migration ${f} failed: ${e.message}`);
    }
  }
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { open, close, migrate };
