// Database backend configuration (SQLite path is exercised; external drivers are only schema-checked).
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dyf-dbcfg-'));
process.env.DATA_DIR = tmpData;
process.env.DB_FILE = path.join(tmpData, 'app.db');
process.env.DB_DRIVER = '';
process.env.DB_URL = '';
process.env.DB_HOST = '';
process.env.DB_PORT = '';
process.env.DB_NAME = '';
process.env.DB_USER = '';
process.env.DB_PASSWORD = '';
process.env.DB_SSL = '';

const dbConfig = require('../src/db-config');
const externalSchema = require('../src/external-schema');

test.after(() => fs.rmSync(tmpData, { recursive: true, force: true }));

test('defaults to SQLite and never exposes the password', () => {
  const cfg = dbConfig.load();
  assert.equal(cfg.driver, 'sqlite');
  const saved = dbConfig.save({
    driver: 'postgres',
    host: '127.0.0.1',
    port: 5432,
    database: 'df',
    user: 'df',
    password: 'secret',
  });
  assert.equal(saved.hasPassword, true);
  assert.equal(saved.password, undefined);
  dbConfig.save({ password: '' });
  assert.equal(dbConfig.load().password, 'secret');
  assert.equal(fs.statSync(dbConfig.FILE).mode & 0o777, 0o600);
});

test('rejects an unknown driver', () => {
  assert.throws(() => dbConfig.save({ driver: 'oracle' }), /driver/);
});

test('external() recognizes postgres/mysql only', () => {
  dbConfig.save({ driver: 'sqlite' });
  assert.equal(dbConfig.external(), false);
  dbConfig.save({ driver: 'postgres' });
  assert.equal(dbConfig.external(), true);
  dbConfig.save({ driver: 'mysql' });
  assert.equal(dbConfig.external(), true);
  dbConfig.save({ driver: 'sqlite' });
});

test('SQLite connection test works on a fresh file', async () => {
  const out = await dbConfig.testConnection({ driver: 'sqlite', sqliteFile: path.join(tmpData, 'fresh.db') });
  assert.equal(out.ok, true);
  assert.equal(out.driver, 'sqlite');
});

test('external schema covers every table and quotes the reserved key column', () => {
  const tables = ['accounts', 'settings', 'pools', 'bands', 'plans', 'sends', 'events', 'friends', 'account_settings', 'account_pools'];
  for (const driver of ['postgres', 'mysql']) {
    const sql = externalSchema.statements(driver).join('\n');
    for (const table of tables) assert.ok(sql.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `${driver} ${table}`);
    assert.ok(sql.includes('key'), `${driver} key column`);
  }
  assert.ok(externalSchema.statements('postgres').join('\n').includes('"key"'));
  assert.ok(externalSchema.statements('mysql').join('\n').includes('`key`'));
});
