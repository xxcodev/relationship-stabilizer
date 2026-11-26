// External PostgreSQL path against pg-mem (worker + schema + portable repos SQL).
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dyf-pg-'));
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
const db = require('../src/db');
const repos = require('../src/repos');
const { POOLS } = require('../src/pools');

test.before(() => {
  db.open();
});

test.after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('PostgreSQL schema and account/config/send repositories round-trip', () => {
  assert.equal(db.dialect, 'postgres');
  repos.seedPools(POOLS);
  repos.seedPools(POOLS);
  assert.equal(repos.listPools().length, POOLS.length);

  const acc = repos.upsertAccount({ label: 'PG', profileDir: '/tmp/pg', port: 9334, friend: 'Hime', enabled: true });
  repos.upsertAccount({ label: 'PG', profileDir: '/tmp/pg2', port: 9335, friend: 'Other', enabled: true });
  assert.equal(repos.getAccount('PG').port, 9335);
  const accId = repos.getAccount('PG').id;

  repos.replaceBands(accId, [{ name: '晚', startMin: 1200, endMin: 1410, minCount: 2, maxCount: 4 }]);
  repos.seedAccountDefaults(accId);
  assert.ok(Number(repos.getAccountSetting(accId, 'dailyTotal')) > 0);
  assert.equal(repos.listAccountPools(accId).length, POOLS.length);

  repos.setAccountSetting(accId, 'banWords', ['恐怖']);
  assert.deepEqual(repos.getAccountSetting(accId, 'banWords'), ['恐怖']);
  repos.setAccountSetting(accId, 'banWords', ['恐怖', '广告']);
  assert.deepEqual(repos.getAccountSetting(accId, 'banWords'), ['恐怖', '广告']);

  repos.addFriend(accId, 'Hime');
  repos.addFriend(accId, 'Hime', '123');
  assert.equal(repos.getFriendByName(accId, 'Hime').userid, '123');

  repos.savePlan(accId, '2026-11-25', { times: [1200, 1210], done: [1200] });
  repos.savePlan(accId, '2026-11-25', { times: [1200, 1210, 1220], done: [1200, 1210] });
  const plan = repos.getPlan(accId, '2026-11-25');
  assert.equal(plan.times.length, 3);
  assert.deepEqual(plan.done, [1200, 1210]);

  repos.insertSend({ accountId: accId, ts: new Date(Date.now() - 1000).toISOString(), day: '2026-11-25', bucket: '默认推荐', source: 'recommend', title: 't', friend: 'Hime', ok: true, videoId: 'v1' });
  repos.insertSend({ accountId: accId, ts: new Date().toISOString(), day: '2026-11-25', bucket: '日番', title: 'u', friend: 'Hime', ok: false, videoId: 'v2' });
  assert.equal(repos.countSendsByDay('2026-11-25', accId), 1);
  assert.deepEqual(repos.friendSendCounts(accId, '2026-11-25'), { Hime: 1 });
  assert.equal(repos.bucketStats(accId).length, 2);
  const sends = repos.listSends({ accountId: accId, limit: 10 });
  assert.equal(sends.length, 2);
  assert.equal(sends.find((x) => x.title === 't').source, 'recommend');

  const ts = '2026-11-25T00:00:00.000Z';
  repos.logEvent('pg-test', { a: 1 }, ts);
  repos.logEvent('pg-test', { a: 1 }, ts);
  const events = repos.listEvents(20).filter((e) => e.event === 'pg-test');
  assert.equal(events.length, 1);
});
