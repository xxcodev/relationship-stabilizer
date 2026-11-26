/**
 * @file Database snapshot: SQLite uses VACUUM INTO; external backends export a logical JSON file.
 */
// Consistent snapshot of the database. SQLite: VACUUM INTO produces a clean file even with WAL.
// PostgreSQL/MySQL: a logical JSON export (the DB server's own backup tools remain authoritative).
const fs = require('fs');
const path = require('path');
const env = require('./env');
const db = require('./db');

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const requested = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(env.DATA_DIR, 'backups', `app-${stamp}.db`);

fs.mkdirSync(path.dirname(requested), { recursive: true });
const conn = db.open();

if (conn.isExternal) {
  const target = /\.json$/i.test(requested) ? requested : requested.replace(/\.[^.]+$/, '') + '.json';
  const tables = ['accounts', 'settings', 'pools', 'bands', 'plans', 'sends', 'events', 'friends', 'account_settings', 'account_pools'];
  const data = { exportedAt: new Date().toISOString(), driver: conn.dialect, tables: {} };
  for (const table of tables) data.tables[table] = conn.prepare(`SELECT * FROM ${table}`).all();
  fs.writeFileSync(target, JSON.stringify(data, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ backup: target, driver: conn.dialect, tables: tables.length, sends: data.tables.sends.length }, null, 2));
  db.close();
  return;
}

const target = requested;
conn.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

const { DatabaseSync } = require('node:sqlite');
const check = new DatabaseSync(target);
const tables = check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length;
const sends = check.prepare('SELECT COUNT(*) c FROM sends').get().c;
check.close();

const size = fs.statSync(target).size;
console.log(JSON.stringify({ backup: target, bytes: size, tables, sends }, null, 2));
db.close();
