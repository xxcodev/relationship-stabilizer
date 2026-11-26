// DB layer tests against a throwaway SQLite file.
const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert');

const tmpDb = path.join(os.tmpdir(), `dyf-test-${process.pid}-${Date.now()}.db`);
process.env.DB_FILE = tmpDb;

const db = require('../src/db');
const repos = require('../src/repos');
const { POOLS } = require('../src/pools');

test.after(() => {
  db.close();
  for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) {
    try { fs.unlinkSync(f); } catch (e) {}
  }
});

test('migrations create the schema once', () => {
  db.open();
  const tables = db
    .open()
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  for (const t of ['accounts', 'bands', 'events', 'meta', 'plans', 'pools', 'sends', 'settings']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
});

test('pools seed idempotently', () => {
  repos.seedPools(POOLS);
  repos.seedPools(POOLS);
  assert.equal(repos.listPools().length, POOLS.length);
});

test('settings round-trip typed values', () => {
  repos.setSetting('totalMax', 18);
  repos.setSetting('banWords', ['国漫', '斗破']);
  assert.equal(repos.getSetting('totalMax'), 18);
  assert.deepEqual(repos.getSetting('banWords'), ['国漫', '斗破']);
});

test('per-account settings and pools are isolated', () => {
  const a = repos.upsertAccount({ label: 'A', profileDir: '/tmp/a', port: 9101 });
  const b = repos.upsertAccount({ label: 'B', profileDir: '/tmp/b', port: 9102 });
  repos.replaceBands(a.id, [{ name: '晚', startMin: 1200, endMin: 1320, minCount: 1, maxCount: 3 }]);
  repos.seedAccountDefaults(a.id);
  repos.seedAccountDefaults(b.id);

  repos.setAccountSetting(a.id, 'dayTotalForTest', 3);
  repos.setAccountSetting(b.id, 'dayTotalForTest', 9);
  assert.equal(repos.getAccountSetting(a.id, 'dayTotalForTest'), 3);
  assert.equal(repos.getAccountSetting(b.id, 'dayTotalForTest'), 9);

  repos.setAccountPoolEnabled(a.id, POOLS[0].name, false);
  assert.equal(repos.listAccountPools(a.id).find((p) => p.name === POOLS[0].name).enabled, false);
  assert.equal(repos.listAccountPools(b.id).find((p) => p.name === POOLS[0].name).enabled, true);

  const before = repos.getAccountSetting(a.id, 'dailyTotal');
  repos.setAccountSetting(a.id, 'dailyTotal', 5);
  assert.equal(repos.getAccountSetting(a.id, 'dailyTotal'), 5);
  assert.notEqual(repos.getAccountSetting(b.id, 'dailyTotal'), 5);
  assert.ok(Number(before) > 0);
});

test('account + bands + plan round-trip', () => {
  const acc = repos.upsertAccount({ label: 'T', profileDir: '/tmp/p', port: 9999, friend: 'Hime' });
  repos.replaceBands(acc.id, [
    { name: '早上', startMin: 420, endMin: 600, minCount: 1, maxCount: 3 },
    { name: '晚上', startMin: 1260, endMin: 1410, minCount: 8, maxCount: 13 },
  ]);
  assert.equal(repos.listBands(acc.id).length, 2);

  repos.savePlan(acc.id, '2026-11-23', { times: [420, 1260], done: [420] });
  const plan = repos.getPlan(acc.id, '2026-11-23');
  assert.deepEqual(plan.times, [420, 1260]);
  assert.deepEqual(plan.done, [420]);

  // re-saving must update, not duplicate
  repos.savePlan(acc.id, '2026-11-23', { times: [420, 1260, 1270], done: [420, 1260] });
  assert.equal(repos.getPlan(acc.id, '2026-11-23').times.length, 3);
});

test('failed slots are persisted separately from done', () => {
  const acc = repos.getAccount('T');
  repos.savePlan(acc.id, '2026-11-24', { times: [420, 1260], done: [420], failed: [1260] });
  const plan = repos.getPlan(acc.id, '2026-11-24');
  assert.deepEqual(plan.done, [420]);
  assert.deepEqual(plan.failed, [1260]);
});

test('sends are recorded and counted per day', () => {
  const acc = repos.getAccount('T');
  repos.insertSend({ accountId: acc.id, ts: '2026-11-23T09:00:00.000Z', day: '2026-11-23', bucket: '韩剧', title: 'x', friend: 'Hime', ok: true, toast: '分享成功', videoId: 'v1' });
  repos.insertSend({ accountId: acc.id, ts: '2026-11-23T10:00:00.000Z', day: '2026-11-23', bucket: '搞笑', title: 'y', friend: 'Hime', ok: false, toast: 'boom' });
  repos.insertSend({ accountId: acc.id, ts: '2026-11-24T09:00:00.000Z', day: '2026-11-24', bucket: '日番', title: 'z', friend: '拍拍', ok: true, toast: '分享成功', videoId: 'v2' });
  repos.insertSend({ accountId: acc.id, ts: '2026-11-24T10:00:00.000Z', day: '2026-11-24', bucket: '日番', title: 'w', friend: 'Hime', ok: false, toast: 'boom' });
  assert.equal(repos.countSendsByDay('2026-11-23', acc.id), 1); // only ok=1 counts as sent
  const stats = repos.bucketStats(acc.id);
  assert.equal(stats.length, 3);
  assert.equal(repos.listSends({ accountId: acc.id, limit: 10 }).length, 4);
  assert.deepEqual(repos.friendSendCounts(acc.id, '2026-11-23'), { Hime: 1 });
  assert.deepEqual(repos.friendSendCounts(acc.id, '2026-11-24'), { 拍拍: 1 }); // failures don't count
});

test('recent sent videos only includes successful sends in the window', () => {
  const acc = repos.getAccount('T');
  const now = new Date().toISOString();
  const day = now.slice(0, 10);
  repos.insertSend({ accountId: acc.id, ts: now, day, bucket: 'test', title: 'recent', friend: 'Hime', ok: true, toast: 'ok', videoId: 'recent-1' });
  repos.insertSend({ accountId: acc.id, ts: now, day, bucket: 'test', title: 'failed', friend: 'Hime', ok: false, toast: 'no', videoId: 'failed-1' });
  repos.insertSend({ accountId: acc.id, ts: '2020-01-01T00:00:00.000Z', day: '2020-01-01', bucket: 'test', title: 'old', friend: 'Hime', ok: true, toast: 'ok', videoId: 'old-1' });
  const rows = repos.listRecentSentVideos(acc.id, 30);
  assert.ok(rows.some((r) => r.video_id === 'recent-1'));
  assert.ok(!rows.some((r) => r.video_id === 'failed-1'));
  assert.ok(!rows.some((r) => r.video_id === 'old-1'));
});

test('events with the same timestamp are idempotent', () => {
  const ts = '2026-01-02T03:04:05.000Z';
  repos.logEvent('dup-test', { a: 1 }, ts);
  repos.logEvent('dup-test', { a: 1 }, ts);
  const rows = db.open().prepare("SELECT COUNT(*) n FROM events WHERE event = 'dup-test'").get().n;
  assert.equal(rows, 1);
  db.open().prepare("DELETE FROM events WHERE event = 'dup-test'").run();
});

test('default account prefers the one with bands', () => {
  repos.upsertAccount({ label: 'empty', profileDir: '/tmp/e', port: 1 });
  const acc = repos.getAccount();
  assert.equal(acc.label, 'T');
});
