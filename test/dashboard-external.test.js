// Dashboard config/preview against the external PostgreSQL facade (pg-mem worker).
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dyf-dash-pg-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'app.db');
process.env.DB_PG_MODULE = path.join(__dirname, 'fixtures', 'pg-mem.js');
process.env.DB_DRIVER = '';
process.env.DB_URL = '';
process.env.DB_HOST = '';
process.env.DB_PORT = '';
process.env.DB_NAME = '';
process.env.DB_USER = '';
process.env.DB_PASSWORD = '';
process.env.DB_SSL = '';

const dbConfig = require('../src/db-config');
dbConfig.save({ driver: 'postgres', host: '127.0.0.1', port: 5432, database: 'df', user: 'df', password: 'x' });
const repos = require('../src/repos');
const { POOLS } = require('../src/pools');
const db = require('../src/db');

let server;
let url;

test.before(async () => {
  db.open();
  repos.seedPools(POOLS);
  const a = repos.upsertAccount({ label: 'PGA', profileDir: '/tmp/pga', port: 9334, friend: 'Hime', enabled: true });
  const b = repos.upsertAccount({ label: 'PGB', profileDir: '/tmp/pgb', port: 9335, friend: 'Other', enabled: true });
  for (const acc of [a, b]) {
    repos.replaceBands(acc.id, [{ name: '晚间', startMin: 1200, endMin: 1410, minCount: 2, maxCount: 4 }]);
    repos.seedAccountDefaults(acc.id);
  }
  repos.setSetting('activeAccount', 'PGA');
  const started = await require('../src/dashboard').startServer({ host: '127.0.0.1', port: 0 });
  server = started.server;
  url = started.url;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const get = async (p) => (await fetch(url + p)).json();
const post = async (p, body) => (await fetch(url + p, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})).json();

test('external DB dashboard config write/preview uses the worker transaction', async () => {
  const before = await get('/api/config');
  assert.equal(before.account, 'PGA');
  const saved = await post('/api/config', {
    account: 'PGA',
    enabled: true,
    schedulePoints: [
      { mode: 'fixed', time: '09:00', count: 3 },
      { mode: 'random', from: '12:00', to: '14:00', count: 2 },
    ],
    burstMinSec: 12,
    burstMaxSec: 40,
    burstDurationFloor: true,
    burstFallbackSec: 20,
    videoSource: 'recommend',
    banWords: ['恐怖'],
    pools: {},
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.config.scheduleTotal, 5);
  assert.deepEqual(saved.config.schedulePoints[1], { mode: 'random', from: '12:00', to: '14:00', count: 2 });
  assert.equal(saved.config.videoSource, 'recommend');

  const preview = await post('/api/preview', {
    account: 'PGA',
    schedulePoints: saved.config.schedulePoints,
    burstMinSec: 12,
    burstMaxSec: 40,
    burstDurationFloor: true,
    burstFallbackSec: 20,
    videoSource: 'recommend',
    banWords: [],
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.count, 5);
  assert.equal(preview.pointCount, 2);

  const other = await post('/api/config', {
    account: 'PGB',
    enabled: true,
    schedulePoints: [{ mode: 'fixed', time: '21:00', count: 2 }],
    burstMinSec: 10,
    burstMaxSec: 30,
    burstDurationFloor: false,
    burstFallbackSec: 0,
    videoSource: 'pool',
    banWords: [],
    pools: {},
  });
  assert.equal(other.config.scheduleTotal, 2);

  const again = await get('/api/config');
  assert.equal(again.account, 'PGA');
  assert.equal(again.scheduleTotal, 5);
});
