/**
 * @file Database connection + migration runner.
 *
 * Default: embedded SQLite via node:sqlite (synchronous, zero native build step).
 * Optional: PostgreSQL / MySQL on a single machine. The rest of the app keeps its synchronous
 * repository API; db.js exposes a small worker-backed facade for external drivers.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { Worker } = require('worker_threads');
const env = require('./env');
const dbConfig = require('./db-config');
const externalSchema = require('./external-schema');

const SCHEMA_DIR = path.join(env.ROOT, 'schema');
const RESULT_BYTES = 8 * 1024 * 1024;

const INITIAL_CONFIG = dbConfig.load();
let db = null;
let worker = null;
let workerError = null;
// Calls are serialized by the synchronous main thread, so one buffer pair is enough and avoids
// allocating 8 MB per query. A timed-out call may race with the next one; timeouts are fatal
// by design (the caller reports a clear error instead of silently retrying).
const WORKER_SIGNAL = new SharedArrayBuffer(4);
const WORKER_RESULT = new SharedArrayBuffer(RESULT_BYTES);

function workerCall(payload, timeoutMs = 30000) {
  if (!worker) throw new Error('外部数据库未连接');
  if (workerError) throw new Error(workerError);
  const signal = WORKER_SIGNAL;
  const result = WORKER_RESULT;
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  new Int32Array(signal, 0, 1)[0] = 0;
  new Int32Array(result, 0, 1)[0] = 0;
  worker.postMessage({ id, ...payload, signal, result });
  const flag = new Int32Array(signal);
  const status = Atomics.wait(flag, 0, 0, timeoutMs);
  if (status === 'timed-out') throw new Error(`数据库请求超时（${timeoutMs}ms）`);
  const length = new Int32Array(result, 0, 1)[0];
  if (!length) throw new Error(workerError || '数据库请求没有返回');
  const text = Buffer.from(result, 4, length).toString();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('数据库返回格式错误');
  }
  if (!data.ok) throw new Error(data.error || '数据库请求失败');
  return data;
}

function externalFacade(config) {
  const facade = {
    dialect: config.driver,
    isExternal: true,
    prepare(sql) {
      return {
        get: (...params) => workerCall({ op: 'queryOne', sql, params }).row || undefined,
        all: (...params) => workerCall({ op: 'query', sql, params }).rows || [],
        run: (...params) => {
          const r = workerCall({ op: 'query', sql, params });
          return { changes: r.changes || 0, lastInsertRowid: r.lastInsertRowid == null ? null : r.lastInsertRowid };
        },
      };
    },
    exec(sql) {
      return workerCall({ op: 'exec', sql });
    },
    close() {
      try { workerCall({ op: 'close' }, 5000); } catch (e) {}
    },
  };
  return facade;
}

function open(file = process.env.DB_FILE || env.DB_FILE) {
  if (db) return db;
  const config = dbConfig.load();
  module.exports.dialect = config.driver;
  if (config.driver === 'postgres' || config.driver === 'mysql') {
    workerError = null;
    worker = new Worker(path.join(__dirname, 'db-worker.js'), { workerData: { config } });
    worker.on('error', (e) => { workerError = `数据库进程错误：${(e.message || e).split('\n')[0]}`; });
    worker.on('exit', (code) => {
      if (code !== 0 && !workerError) workerError = `数据库进程退出（code ${code}）`;
    });
    const facade = externalFacade(config);
    try {
      workerCall({ op: 'ping' }, 20000);
      migrate(facade);
    } catch (e) {
      try { worker.terminate(); } catch (e2) {}
      worker = null;
      db = null;
      throw new Error(`连接 ${config.driver} 失败：${(e.message || e).split('\n')[0]}`);
    }
    db = facade;
    return db;
  }

  const target = file === env.DB_FILE && process.env.DB_FILE
    ? process.env.DB_FILE
    : (process.env.DB_FILE || config.sqliteFile || env.DB_FILE || file);
  if (target !== ':memory:') fs.mkdirSync(path.dirname(target), { recursive: true });
  // Dashboard and scheduler run concurrently in the app shell; a short busy timeout keeps
  // a transient write lock from surfacing as "database is locked". The option is newer than
  // the minimum supported Node, so fall back to the plain constructor.
  try {
    db = new DatabaseSync(target, { timeout: 5000 });
  } catch (e) {
    db = new DatabaseSync(target);
  }
  db.dialect = 'sqlite';
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(conn) {
  if (module.exports.dialect !== 'sqlite') {
    externalSchema.ensureSchema(conn, module.exports.dialect);
    return;
  }
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
  if (!db) return;
  if (db.isExternal) {
    db.close();
    try { worker.terminate(); } catch (e) {}
    worker = null;
    db = null;
    return;
  }
  db.close();
  db = null;
}

module.exports = { open, close, migrate, dialect: INITIAL_CONFIG.driver };
