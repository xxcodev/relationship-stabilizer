/**
 * @file Database backend configuration (SQLite by default, optionally MySQL/PostgreSQL).
 * Stored under DATA_DIR/database.json with mode 0600; env vars can override it.
 */
const fs = require('fs');
const path = require('path');
const env = require('./env');

const FILE = path.join(env.DATA_DIR, 'database.json');
const DRIVERS = ['sqlite', 'postgres', 'mysql'];
const DEFAULTS = {
  driver: 'sqlite',
  sqliteFile: env.DB_FILE,
  host: '127.0.0.1',
  port: null,
  database: '',
  user: '',
  password: '',
  ssl: false,
  url: '',
};

function envConfig() {
  const out = {};
  if (process.env.DB_DRIVER) out.driver = String(process.env.DB_DRIVER);
  if (process.env.DB_URL) out.url = String(process.env.DB_URL);
  if (process.env.DB_HOST) out.host = String(process.env.DB_HOST);
  if (process.env.DB_PORT) out.port = Number(process.env.DB_PORT);
  if (process.env.DB_NAME) out.database = String(process.env.DB_NAME);
  if (process.env.DB_USER) out.user = String(process.env.DB_USER);
  if (process.env.DB_PASSWORD) out.password = String(process.env.DB_PASSWORD);
  if (process.env.DB_SSL != null) out.ssl = /^(1|true|yes|on)$/i.test(String(process.env.DB_SSL));
  return out;
}

function load() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {}
  const cfg = { ...DEFAULTS, ...file, ...envConfig() };
  cfg.driver = DRIVERS.includes(cfg.driver) ? cfg.driver : 'sqlite';
  cfg.port = cfg.port == null ? (cfg.driver === 'mysql' ? 3306 : 5432) : Number(cfg.port);
  return cfg;
}

function save(patch = {}) {
  const current = load();
  const next = { ...current, ...patch };
  if (!DRIVERS.includes(next.driver)) throw new Error('driver must be sqlite|postgres|mysql');
  if (next.driver !== 'sqlite' && !next.url) {
    if (!next.host) throw new Error('数据库主机不能为空');
    if (!next.database) throw new Error('数据库名不能为空');
    if (!next.user) throw new Error('数据库用户不能为空');
  }
  // An empty password means "keep the current one" (the UI never receives the real password).
  if (patch.password == null || patch.password === '' || /^\*+$/.test(String(patch.password))) next.password = current.password;
  const data = {
    driver: next.driver,
    sqliteFile: String(next.sqliteFile || env.DB_FILE),
    host: String(next.host || '127.0.0.1'),
    port: Number(next.port) || (next.driver === 'mysql' ? 3306 : 5432),
    database: String(next.database || ''),
    user: String(next.user || ''),
    password: String(next.password || ''),
    ssl: !!next.ssl,
    url: String(next.url || ''),
  };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { fs.chmodSync(FILE, 0o600); } catch (e) {}
  return publicConfig(data);
}

function publicConfig(cfg = load()) {
  return {
    driver: cfg.driver,
    sqliteFile: cfg.sqliteFile,
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    hasPassword: !!cfg.password,
    ssl: !!cfg.ssl,
    hasUrl: !!cfg.url,
    file: FILE,
  };
}

function external(cfg = load()) {
  return cfg.driver === 'mysql' || cfg.driver === 'postgres';
}

function connectionOptions(cfg = load()) {
  if (cfg.url) return { url: cfg.url, ssl: cfg.ssl };
  return {
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    ssl: cfg.ssl,
  };
}

async function testConnection(cfg = load()) {
  if (cfg.driver === 'sqlite') {
    const { DatabaseSync } = require('node:sqlite');
    const file = cfg.sqliteFile || env.DB_FILE;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const conn = new DatabaseSync(file);
    try {
      conn.prepare('SELECT 1 AS ok').get();
      return { ok: true, driver: 'sqlite', detail: file };
    } finally {
      conn.close();
    }
  }
  const opts = connectionOptions(cfg);
  if (cfg.driver === 'postgres') {
    const { Client } = require('pg');
    const client = new Client(opts.url
      ? { connectionString: opts.url, ssl: opts.ssl ? { rejectUnauthorized: false } : undefined }
      : { host: opts.host, port: opts.port, database: opts.database, user: opts.user, password: opts.password, ssl: opts.ssl ? { rejectUnauthorized: false } : undefined });
    await client.connect();
    try {
      const r = await client.query('SELECT 1 AS ok');
      return { ok: true, driver: 'postgres', detail: `PostgreSQL ${r.rows[0] ? r.rows[0].ok : 1}` };
    } finally {
      await client.end().catch(() => {});
    }
  }
  const mysql = require('mysql2/promise');
  const conn = opts.url
    ? await mysql.createConnection(opts.url)
    : await mysql.createConnection({
      host: opts.host,
      port: opts.port,
      database: opts.database,
      user: opts.user,
      password: opts.password,
      ssl: opts.ssl ? {} : undefined,
      connectTimeout: 8000,
    });
  try {
    await conn.ping();
    return { ok: true, driver: 'mysql', detail: 'MySQL' };
  } finally {
    await conn.end().catch(() => {});
  }
}

module.exports = { FILE, DRIVERS, DEFAULTS, load, save, publicConfig, external, connectionOptions, testConnection };
