// Dashboard config/preview/db/AI endpoints against a throwaway SQLite database.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dyf-dash-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'app.db');

const repos = require('../src/repos');
const burstPlanner = require('../src/burst');
const { POOLS } = require('../src/pools');
const { startServer } = require('../src/dashboard');
const db = require('../src/db');

let server;
let url;

test.before(async () => {
  repos.seedPools(POOLS);
  const a = repos.upsertAccount({ label: 'A', profileDir: path.join(tmp, 'pa'), port: 9334, friend: 'Hime', enabled: true });
  const b = repos.upsertAccount({ label: 'B', profileDir: path.join(tmp, 'pb'), port: 9335, friend: 'Other', enabled: true });
  for (const acc of [a, b]) {
    repos.replaceBands(acc.id, [{ name: '晚间', startMin: 1200, endMin: 1410, minCount: 2, maxCount: 4 }]);
    repos.seedAccountDefaults(acc.id);
  }
  repos.setSetting('activeAccount', 'A');
  const started = await startServer({ host: '127.0.0.1', port: 0 });
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

const ACCOUNT_A_POINTS = [
  { mode: 'fixed', time: '09:00', count: 3 },
  { mode: 'random', from: '12:00', to: '14:00', count: 2 },
];

test('schedule config round-trips per account', async () => {
  const before = await get('/api/config');
  assert.equal(before.account, 'A');
  // No schedulePoints stored yet: the legacy bands/dailyTotal config is converted on read.
  assert.ok(Array.isArray(before.schedulePoints) && before.schedulePoints.length >= 1);

  const saved = await post('/api/config', {
    account: 'A',
    enabled: true,
    schedulePoints: ACCOUNT_A_POINTS,
    burstMinSec: 15,
    burstMaxSec: 45,
    burstDurationFloor: true,
    burstFallbackSec: 20,
    videoSource: 'pool',
    filterAgeEnabled: false,
    filterMinLikes: 1000,
    filterMinComments: 20,
    filterMinFavorites: 5,
    filterMinShares: 2,
    filterLikesEnabled: true,
    filterCommentsEnabled: true,
    filterFavoritesEnabled: false,
    filterSharesEnabled: true,
    banWords: ['恐怖'],
    recommendMaxAgeDays: 14,
    pools: {},
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.config.filterAgeEnabled, false);
  assert.equal(saved.config.filterMinLikes, 1000);
  assert.equal(saved.config.filterMinComments, 20);
  assert.equal(saved.config.filterMinFavorites, 5);
  assert.equal(saved.config.filterMinShares, 2);
  assert.equal(saved.config.filterLikesEnabled, true);
  assert.equal(saved.config.filterCommentsEnabled, true);
  assert.equal(saved.config.filterFavoritesEnabled, false);
  assert.equal(saved.config.filterSharesEnabled, true);
  assert.deepEqual(saved.config.schedulePoints, ACCOUNT_A_POINTS);
  assert.equal(saved.config.scheduleTotal, 5);
  assert.equal(saved.config.burstMinSec, 15);
  assert.equal(saved.config.burstMaxSec, 45);
  assert.equal(saved.config.burstDurationFloor, true);
  assert.equal(saved.config.burstFallbackSec, 20);
  assert.equal(saved.config.recommendMaxAgeDays, 14);
  assert.deepEqual(saved.config.banWords, ['恐怖']);

  const b = await post('/api/config', {
    account: 'B',
    enabled: true,
    schedulePoints: [{ mode: 'fixed', time: '21:00', count: 5 }],
    burstMinSec: 10,
    burstMaxSec: 30,
    burstDurationFloor: false,
    burstFallbackSec: 0,
    videoSource: 'pool',
    banWords: [],
    pools: {},
  });
  assert.equal(b.config.schedulePoints.length, 1);
  assert.equal(b.config.schedulePoints[0].time, '21:00');

  const aAgain = await get('/api/config');
  assert.deepEqual(aAgain.schedulePoints, ACCOUNT_A_POINTS);
  assert.equal(aAgain.burstMinSec, 15);
  assert.equal(aAgain.filterMinLikes, 1000);
  assert.equal(aAgain.filterAgeEnabled, false);
  assert.equal(aAgain.filterLikesEnabled, true);
  assert.equal(aAgain.filterFavoritesEnabled, false);
  assert.equal(aAgain.account, 'A', 'the active account is still A');
});

test('preview estimates every trigger', async () => {
  const out = await post('/api/preview', {
    account: 'A',
    enabled: true,
    schedulePoints: ACCOUNT_A_POINTS,
    burstMinSec: 15,
    burstMaxSec: 45,
    burstDurationFloor: true,
    burstFallbackSec: 20,
    videoSource: 'pool',
    banWords: [],
  });
  assert.equal(out.ok, true);
  assert.equal(out.mode, 'schedule');
  assert.equal(out.pointCount, 2);
  assert.equal(out.count, 5);
  assert.deepEqual(out.points.map((p) => p.mode), ['fixed', 'random']);
  assert.ok(out.points.every((p) => p.end));
  assert.match(out.summary, /09:00×3/);
  assert.match(out.summary, /12:00–14:00 随机×2/);
});

test('database and AI status endpoints default to SQLite/off', async () => {
  const database = await get('/api/database');
  assert.equal(database.active, 'sqlite');
  assert.equal(database.config.driver, 'sqlite');
  const tested = await post('/api/database/test', { driver: 'sqlite', sqliteFile: process.env.DB_FILE });
  assert.equal(tested.ok, true);
  assert.equal(tested.driver, 'sqlite');

  const ai = await get('/api/ai/status');
  assert.equal(ai.ok, true);
  assert.equal(ai.config.enabled, false);
  assert.equal(ai.aiMode, 'off');
});

test('switching the configured driver requires an app restart', async () => {
  const saved = await post('/api/database', {
    driver: 'postgres',
    host: '127.0.0.1',
    port: 5432,
    database: 'df',
    user: 'df',
    password: 'secret',
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.restartRequired, true);
  const restart = await post('/api/control', { action: 'restart' });
  assert.equal(restart.ok, false);
  assert.match(restart.error, /重启整个应用/);
  // restore SQLite so other tests / cleanup are unaffected
  const back = await post('/api/database', { driver: 'sqlite', sqliteFile: process.env.DB_FILE });
  assert.equal(back.ok, true);
  assert.equal(back.restartRequired, false);
});

test('data exposes schedule progress and the next trigger', async () => {
  const acc = repos.getAccount('A');
  const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const plan = burstPlanner.normalizeConfig({
    points: ACCOUNT_A_POINTS,
    minSec: 15, maxSec: 45, floor: true, fallbackSec: 20,
  });
  const state = burstPlanner.freshState({ day, burst: plan, nowMs: Date.now() });
  state.points[0] = { ...state.points[0], sent: 1, status: 'running', nextAt: Date.now() + 20000, lastDurationMs: 9000 };
  state.lastDurationMs = 9000;
  burstPlanner.settleState(state);
  repos.saveBurstState(acc.id, state);

  const data = await get('/api/data');
  assert.equal(data.todayPlan, 5);
  assert.equal(data.schedule.sent, 1);
  assert.equal(data.schedule.points.length, 2);
  assert.equal(data.schedule.points[0].sent, 1);
  assert.equal(data.schedule.lastDurationMs, 9000);
  assert.ok(data.schedule.nextAt);
  assert.ok(data.schedule.timeline.some((t) => t.status === 'pending'));
});

test('today\'s progress can be reset', async () => {
  const acc = repos.getAccount('A');
  const reset = await post('/api/today/burst-reset', { account: 'A' });
  assert.equal(reset.ok, true);
  const fresh = repos.getBurstState(acc.id);
  assert.ok(fresh);
  assert.equal(fresh.sent, 0);
  assert.equal(fresh.points.length, 2);
  assert.deepEqual(fresh.points.map((p) => p.sent), [0, 0]);
  if (reset.forceNow) assert.equal(fresh.points[0].startAt, fresh.points[0].nextAt);
});
