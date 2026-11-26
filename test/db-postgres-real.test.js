// Optional real-PostgreSQL integration test (bundled postgres binary, no Docker):
//   npm run test:pg:real
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const enabled = process.env.TEST_PG_REAL === '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dyf-pg-real-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'app.db');
process.env.DB_PG_MODULE = '';
process.env.DB_DRIVER = '';
process.env.DB_URL = '';
process.env.DB_HOST = '';
process.env.DB_PORT = '';
process.env.DB_NAME = '';
process.env.DB_USER = '';
process.env.DB_PASSWORD = '';
process.env.DB_SSL = '';

test('real PostgreSQL schema + account/config/send repositories round-trip', { skip: !enabled }, async () => {
  const { PostgresMemoryServer } = await import('postgres-memory-server');
  const server = await PostgresMemoryServer.create();
  let db;
  try {
    const dbConfig = require('../src/db-config');
    dbConfig.save({ driver: 'postgres', url: server.getUri(), host: '', database: '', user: '' });
    db = require('../src/db');
    db.open();
    assert.equal(db.dialect, 'postgres');
    const repos = require('../src/repos');
    const { POOLS } = require('../src/pools');

    repos.seedPools(POOLS);
    repos.seedPools(POOLS);
    assert.equal(repos.listPools().length, POOLS.length);

    const acc = repos.upsertAccount({ label: 'PG', profileDir: '/tmp/pg', port: 9334, friend: 'Hime', enabled: true });
    repos.upsertAccount({ label: 'PG', profileDir: '/tmp/pg2', port: 9335, friend: 'Other', enabled: true });
    assert.equal(repos.getAccount('PG').port, 9335);

    repos.replaceBands(acc.id, [{ name: '晚', startMin: 1200, endMin: 1410, minCount: 2, maxCount: 4 }]);
    repos.seedAccountDefaults(acc.id);
    assert.ok(Number(repos.getAccountSetting(acc.id, 'dailyTotal')) > 0);
    assert.equal(repos.listAccountPools(acc.id).length, POOLS.length);

    repos.setAccountSetting(acc.id, 'banWords', ['恐怖']);
    repos.setAccountSetting(acc.id, 'banWords', ['恐怖', '广告']);
    assert.deepEqual(repos.getAccountSetting(acc.id, 'banWords'), ['恐怖', '广告']);

    repos.addFriend(acc.id, 'Hime');
    repos.addFriend(acc.id, 'Hime', '123');
    assert.equal(repos.getFriendByName(acc.id, 'Hime').userid, '123');

    repos.savePlan(acc.id, '2026-11-25', { times: [1200, 1210], done: [1200] });
    repos.savePlan(acc.id, '2026-11-25', { times: [1200, 1210, 1220], done: [1200, 1210] });
    assert.deepEqual(repos.getPlan(acc.id, '2026-11-25').done, [1200, 1210]);

    repos.insertSend({ accountId: acc.id, ts: new Date(Date.now() - 1000).toISOString(), day: '2026-11-25', bucket: '默认推荐', source: 'recommend', title: 't', friend: 'Hime', ok: true, videoId: 'v1' });
    repos.insertSend({ accountId: acc.id, ts: new Date().toISOString(), day: '2026-11-25', bucket: '日番', title: 'u', friend: 'Hime', ok: false, videoId: 'v2' });
    assert.equal(repos.countSendsByDay('2026-11-25', acc.id), 1);
    assert.deepEqual(repos.friendSendCounts(acc.id, '2026-11-25'), { Hime: 1 });
    const sends = repos.listSends({ accountId: acc.id, limit: 10 });
    assert.equal(sends.length, 2);
    assert.equal(sends.find((x) => x.title === 't').source, 'recommend');

    const ts = '2026-11-25T00:00:00.000Z';
    repos.logEvent('pg-real-test', { a: 1 }, ts);
    repos.logEvent('pg-real-test', { a: 1 }, ts);
    assert.equal(repos.listEvents(20).filter((e) => e.event === 'pg-real-test').length, 1);
  } finally {
    try { if (db) db.close(); } catch (e) {}
    await server.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
