/**
 * @file Worker that owns an external PostgreSQL/MySQL connection.
 *
 * The rest of the app is synchronous (node:sqlite heritage). db.js talks to this worker with
 * a shared buffer + Atomics.wait, so repositories keep their existing sync API. The worker is
 * only used for external backends; SQLite stays in-process and synchronous.
 */
const { parentPort, workerData } = require('worker_threads');
const { toPgSql } = require('./db-sql');

let client = null;
let driver = null;
let connecting = null;

function sslOption(ssl) {
  return ssl ? { rejectUnauthorized: false } : undefined;
}

async function connect() {
  const cfg = workerData.config || {};
  driver = cfg.driver;
  if (driver === 'postgres') {
    // Test hook: allow a pg-compatible in-memory module (pg-mem) in integration tests.
    const pgModule = process.env.DB_PG_MODULE || 'pg';
    const { Client } = require(pgModule);
    client = new Client(cfg.url
      ? { connectionString: cfg.url, ssl: sslOption(cfg.ssl) }
      : {
        host: cfg.host,
        port: cfg.port,
        database: cfg.database,
        user: cfg.user,
        password: cfg.password,
        ssl: sslOption(cfg.ssl),
      });
    await client.connect();
    return;
  }
  if (driver === 'mysql') {
    const mysql = require('mysql2/promise');
    client = cfg.url
      ? await mysql.createConnection(cfg.url)
      : await mysql.createConnection({
        host: cfg.host,
        port: cfg.port,
        database: cfg.database,
        user: cfg.user,
        password: cfg.password,
        ssl: cfg.ssl ? {} : undefined,
        connectTimeout: 15000,
      });
    return;
  }
  throw new Error(`unsupported external driver: ${driver}`);
}

async function ensureConnected() {
  if (client) return;
  if (!connecting) connecting = connect().finally(() => { connecting = null; });
  await connecting;
}

async function run(sql, params = []) {
  await ensureConnected();
  if (driver === 'postgres') {
    const text = toPgSql(sql);
    const result = await client.query(text, params);
    return {
      rows: Array.isArray(result.rows) ? result.rows : [],
      changes: result.rowCount || 0,
      lastInsertRowid: null,
      command: result.command,
    };
  }
  const [rows] = await client.execute(sql, params);
  if (Array.isArray(rows)) return { rows, changes: 0, lastInsertRowid: null };
  return { rows: [], changes: rows.affectedRows || 0, lastInsertRowid: rows.insertId || null };
}

async function exec(sql) {
  await ensureConnected();
  if (driver === 'postgres') {
    const result = await client.query(String(sql));
    return { rows: [], changes: result.rowCount || 0, lastInsertRowid: null };
  }
  const [rows] = await client.query(String(sql));
  return { rows: Array.isArray(rows) ? rows : [], changes: rows && rows.affectedRows ? rows.affectedRows : 0, lastInsertRowid: null };
}

function reply(msg, payload) {
  try {
    const json = Buffer.from(JSON.stringify(payload));
    const length = Math.min(json.length, msg.result.byteLength - 4);
    const out = new Uint8Array(msg.result, 4, length);
    out.set(json.subarray(0, length));
    new Int32Array(msg.result, 0, 1)[0] = length;
    Atomics.store(new Int32Array(msg.signal), 0, 1);
    Atomics.notify(new Int32Array(msg.signal), 0);
  } catch (e) {
    try {
      const json = Buffer.from(JSON.stringify({ ok: false, error: 'worker reply failed: ' + e.message }));
      new Uint8Array(msg.result, 4, Math.min(json.length, msg.result.byteLength - 4)).set(json.subarray(0, msg.result.byteLength - 4));
      new Int32Array(msg.result, 0, 1)[0] = Math.min(json.length, msg.result.byteLength - 4);
      Atomics.store(new Int32Array(msg.signal), 0, 1);
      Atomics.notify(new Int32Array(msg.signal), 0);
    } catch (e2) {}
  }
}

parentPort.on('message', async (msg) => {
  try {
    let result;
    if (msg.op === 'ping') {
      await ensureConnected();
      result = { ok: true, driver };
    } else if (msg.op === 'query') {
      result = { ok: true, ...(await run(msg.sql, msg.params || [])) };
    } else if (msg.op === 'exec') {
      result = { ok: true, ...(await exec(msg.sql)) };
    } else if (msg.op === 'queryOne') {
      const r = await run(msg.sql, msg.params || []);
      result = { ok: true, row: r.rows[0] || null, changes: r.changes };
    } else if (msg.op === 'close') {
      if (client) {
        if (driver === 'postgres') await client.end().catch(() => {});
        else await client.end().catch(() => {});
      }
      result = { ok: true };
      reply(msg, result);
      process.exit(0);
      return;
    } else {
      throw new Error(`unknown op ${msg.op}`);
    }
    reply(msg, result);
  } catch (e) {
    // Do not tear down the connection here: a failed statement inside a transaction must be
    // followed by ROLLBACK on the same connection. A truly lost connection fails the next call,
    // and the caller/worker startup handles reconnecting.
    reply(msg, { ok: false, error: (e.message || String(e)).split('\n')[0] });
  }
});
