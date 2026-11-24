/**
 * @file Consistent database snapshot via VACUUM INTO.
 */
// Consistent snapshot of the database: VACUUM INTO produces a clean file even with WAL.
const fs = require('fs');
const path = require('path');
const env = require('./env');
const db = require('./db');

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const target = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(env.DATA_DIR, 'backups', `app-${stamp}.db`);

fs.mkdirSync(path.dirname(target), { recursive: true });
const conn = db.open();
conn.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

const { DatabaseSync } = require('node:sqlite');
const check = new DatabaseSync(target);
const tables = check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length;
const sends = check.prepare('SELECT COUNT(*) c FROM sends').get().c;
check.close();

const size = fs.statSync(target).size;
console.log(JSON.stringify({ backup: target, bytes: size, tables, sends }, null, 2));
db.close();
