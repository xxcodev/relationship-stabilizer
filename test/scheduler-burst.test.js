// 定时连发 end-to-end ticks: multiple points, per-point skip/abort, no replay after the day.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dyf-sched-burst-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'app.db');

const repos = require('../src/repos');
const apiSession = require('../src/api-session');
const apiSender = require('../src/api-sender');
const apiRead = require('../src/api-read');
const scheduler = require('../src/scheduler');
const { POOLS } = require('../src/pools');

const today = () => new Date().toLocaleDateString('sv-SE');
const hhmm = (d = new Date()) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const DURATION_MS = 18000;

let feedSeq = 0;
function mockFeed() {
  const nowSec = Math.floor(Date.now() / 1000);
  return async () => {
    feedSeq += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        status_code: 0,
        aweme_list: [{
          aweme_id: '73000000000000' + String(feedSeq).padStart(5, '0'),
          desc: '连发视频 ' + feedSeq,
          create_time: nowSec - 60,
          statistics: { digg_count: 10 },
          author: { nickname: '作者', uid: 'u1', avatar_thumb: { url_list: ['https://x/t.jpg'], uri: 't' } },
          video: {
            duration: DURATION_MS,
            cover: { url_list: ['https://x/c.jpg'], uri: 'c', width: 720, height: 1280 },
          },
        }],
      }),
    };
  };
}

function setBurst(points, extra = {}) {
  const acc = repos.getAccount('B1');
  repos.clearBurstState(acc.id);
  repos.setAccountSetting(acc.id, 'schedulePoints', points.map((p) => ({ mode: 'fixed', ...p })));
  repos.setAccountSetting(acc.id, 'burstMinSec', 10);
  repos.setAccountSetting(acc.id, 'burstMaxSec', 50);
  repos.setAccountSetting(acc.id, 'burstDurationFloor', true);
  repos.setAccountSetting(acc.id, 'burstFallbackSec', 15);
  for (const [key, value] of Object.entries(extra)) repos.setAccountSetting(acc.id, key, value);
  return acc;
}

test.before(() => {
  repos.seedPools(POOLS);
  const acc = repos.upsertAccount({ label: 'B1', profileDir: path.join(tmp, 'p'), port: 9336, friend: 'Hime', enabled: true });
  repos.seedAccountDefaults(acc.id);
  repos.addFriend(acc.id, 'Hime');
  repos.setSetting('activeAccount', 'B1');
  repos.setAccountSetting(acc.id, 'scheduleMode', 'burst');
  repos.setAccountSetting(acc.id, 'sendMode', 'auto');
  repos.setAccountSetting(acc.id, 'videoSource', 'recommend');

  apiSession.save({
    version: 4,
    createdAt: new Date().toISOString(),
    account: 'B1',
    friend: 'Hime',
    feedUrl: 'https://www.douyin.com/aweme/v1/web/tab/feed/?count=10&a_bogus=SIGNED',
    searchUrl: 'https://www.douyin.com/aweme/v1/web/general/search/single/?keyword=x',
    template: { url: 'https://imapi.douyin.com/v1/message/send', bodyB64: 'ZmFrZQ==' },
    friends: [{ name: 'Hime', userid: '1' }],
    cookies: [{ domain: '.douyin.com', name: 'sid', value: 'abc' }],
  }, 'B1');
});

test.after(() => {
  try { require('../src/db').close(); } catch (e) {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a single point sends its videos, records the duration and does not replay', async () => {
  setBurst([{ time: hhmm(), count: 1 }]);

  const originalFetch = global.fetch;
  const originalSend = apiSender.sendVideo;
  global.fetch = mockFeed();
  apiSender.sendVideo = async () => ({ ok: true, serverMessageId: 'server-burst-1' });
  try {
    const cfg = scheduler.runtimeConfig('B1');
    assert.equal(cfg.schedule.points.length, 1);

    const res = await scheduler.runSchedule(cfg, today());
    assert.equal(res.done, true);
    const acc = repos.getAccount('B1');
    const state = repos.getBurstState(acc.id);
    assert.equal(state.points[0].sent, 1);
    assert.equal(state.points[0].status, 'done');
    assert.equal(state.points[0].lastDurationMs, DURATION_MS);
    assert.equal(repos.listSends({ accountId: acc.id, limit: 5 }).length, 1);

    const again = await scheduler.runSchedule(scheduler.runtimeConfig('B1'), today());
    assert.equal(again.done, true);
    assert.equal(repos.listSends({ accountId: acc.id, limit: 5 }).length, 1);
  } finally {
    global.fetch = originalFetch;
    apiSender.sendVideo = originalSend;
  }
});

test('two points run in order, each with its own count', async () => {
  const acc = setBurst([{ time: '09:50', count: 2 }, { time: '09:55', count: 1 }]);
  const sendsBefore = repos.listSends({ accountId: acc.id, limit: 100 }).length;

  const originalFetch = global.fetch;
  const originalSend = apiSender.sendVideo;
  global.fetch = mockFeed();
  apiSender.sendVideo = async () => ({ ok: true, serverMessageId: 'server-burst-2' });
  try {
    const cfg = scheduler.runtimeConfig('B1');
    let clock = new Date(`${today()}T10:00:00`).getTime();
    const fakeNow = () => { clock += 61000; return new Date(clock); };
    const res = await scheduler.runSchedule(cfg, today(), { now: fakeNow });
    assert.equal(res.done, true);
    assert.equal(res.sent, 3);
    assert.equal(repos.listSends({ accountId: acc.id, limit: 100 }).length, sendsBefore + 3);

    const state = repos.getBurstState(acc.id);
    assert.deepEqual(state.points.map((p) => p.status), ['done', 'done']);
    assert.deepEqual(state.points.map((p) => p.sent), [2, 1]);
    assert.equal(state.status, 'done');
  } finally {
    global.fetch = originalFetch;
    apiSender.sendVideo = originalSend;
  }
});

test('all points missed are skipped without sending', async () => {
  setBurst([{ time: '00:00', count: 1 }, { time: '00:10', count: 1 }]);
  const cfg = scheduler.runtimeConfig('B1');
  const clock = new Date(`${today()}T10:00:00`);
  const res = await scheduler.runSchedule(cfg, today(), { now: () => clock });
  assert.equal(res.done, true);
  assert.equal(res.sent, 0);
  assert.equal(res.skipped, 2);
  const state = repos.getBurstState(repos.getAccount('B1').id);
  assert.deepEqual(state.points.map((p) => p.status), ['skipped', 'skipped']);
  assert.deepEqual(state.points.map((p) => p.lastError), ['late-start', 'late-start']);
});

test('a missed point does not stop a later point that is still in range', async () => {
  const acc = setBurst([{ time: '00:00', count: 1 }, { time: '09:55', count: 1 }]);
  const sendsBefore = repos.listSends({ accountId: acc.id, limit: 100 }).length;

  const originalFetch = global.fetch;
  const originalSend = apiSender.sendVideo;
  global.fetch = mockFeed();
  apiSender.sendVideo = async () => ({ ok: true, serverMessageId: 'server-burst-3' });
  try {
    const cfg = scheduler.runtimeConfig('B1');
    const fixed = new Date(`${today()}T10:00:00`);
    const res = await scheduler.runSchedule(cfg, today(), { now: () => fixed });
    assert.equal(res.done, true);
    assert.equal(res.sent, 1);
    assert.equal(res.skipped, 1);
    assert.equal(repos.listSends({ accountId: acc.id, limit: 100 }).length, sendsBefore + 1);

    const state = repos.getBurstState(acc.id);
    assert.deepEqual(state.points.map((p) => p.status), ['skipped', 'done']);
    assert.equal(state.points[0].sent, 0);
    assert.equal(state.points[1].sent, 1);
  } finally {
    global.fetch = originalFetch;
    apiSender.sendVideo = originalSend;
  }
});

test('a failed point is aborted on its own and later points still run', async () => {
  const acc = setBurst([{ time: '09:50', count: 1 }, { time: '09:55', count: 1 }]);
  const sendsBefore = repos.listSends({ accountId: acc.id, limit: 100 }).length;

  const originalFetch = global.fetch;
  const originalSend = apiSender.sendVideo;
  global.fetch = mockFeed();
  let calls = 0;
  apiSender.sendVideo = async () => {
    calls++;
    return calls <= 2 ? { ok: false, statusMessage: 'simulated failure' } : { ok: true, serverMessageId: 'server-burst-4' };
  };
  try {
    const cfg = scheduler.runtimeConfig('B1');
    let clock = new Date(`${today()}T10:00:00`).getTime();
    const fakeNow = () => { clock += 61000; return new Date(clock); };
    const res = await scheduler.runSchedule(cfg, today(), { now: fakeNow, retryDelayMs: 0 });
    assert.equal(res.done, true);
    assert.equal(res.sent, 1);
    assert.equal(res.aborted, 1);
    assert.equal(calls, 3, 'first point retried once, second point succeeded');
    assert.equal(repos.listSends({ accountId: acc.id, limit: 100 }).length, sendsBefore + 1);

    const state = repos.getBurstState(acc.id);
    assert.deepEqual(state.points.map((p) => p.status), ['aborted', 'done']);
    assert.match(state.points[0].lastError, /simulated failure/);
  } finally {
    global.fetch = originalFetch;
    apiSender.sendVideo = originalSend;
  }
});

test('a random-range trigger fires at a moment inside the range', async () => {
  const acc = repos.getAccount('B1');
  repos.clearBurstState(acc.id);
  repos.setAccountSetting(acc.id, 'schedulePoints', [{ mode: 'random', from: '09:50', to: '09:55', count: 1 }]);
  repos.setAccountSetting(acc.id, 'burstMinSec', 10);
  repos.setAccountSetting(acc.id, 'burstMaxSec', 50);
  repos.setAccountSetting(acc.id, 'burstDurationFloor', true);
  repos.setAccountSetting(acc.id, 'burstFallbackSec', 15);
  const sendsBefore = repos.listSends({ accountId: acc.id, limit: 100 }).length;

  const originalFetch = global.fetch;
  const originalSend = apiSender.sendVideo;
  global.fetch = mockFeed();
  apiSender.sendVideo = async () => ({ ok: true, serverMessageId: 'server-random' });
  try {
    const cfg = scheduler.runtimeConfig('B1');
    const fixed = new Date(`${today()}T10:00:00`);
    const res = await scheduler.runSchedule(cfg, today(), { now: () => fixed });
    assert.equal(res.done, true);
    assert.equal(res.sent, 1);
    assert.equal(repos.listSends({ accountId: acc.id, limit: 100 }).length, sendsBefore + 1);
    const point = repos.getBurstState(acc.id).points[0];
    assert.equal(point.mode, 'random');
    assert.ok(point.startAt >= new Date(`${today()}T09:50:00`).getTime());
    assert.ok(point.startAt <= new Date(`${today()}T09:55:00`).getTime());
  } finally {
    global.fetch = originalFetch;
    apiSender.sendVideo = originalSend;
  }
});

test('metric thresholds reject without browser fallback in pure API mode', async () => {
  const acc = repos.getAccount('B1');
  repos.setAccountSetting(acc.id, 'videoSource', 'pool');
  repos.setAccountSetting(acc.id, 'aiMode', 'off');
  repos.setAccountSetting(acc.id, 'filterMinLikes', 0);
  repos.setAccountSetting(acc.id, 'filterMinComments', 5);
  repos.setAccountSetting(acc.id, 'filterMinFavorites', 0);
  repos.setAccountSetting(acc.id, 'filterMinShares', 0);

  const nowSec = Math.floor(Date.now() / 1000);
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      status_code: 0,
      data: [{
        aweme_info: {
          aweme_id: 'metric-1',
          desc: '互动偏低的候选',
          create_time: nowSec - 3600,
          author: { nickname: '作者' },
          statistics: { digg_count: 10, comment_count: 0, collect_count: 0, share_count: 0 },
          video: { cover: { url_list: ['https://x/c.jpg'], uri: 'c', width: 1080, height: 1920 } },
        },
      }],
    }),
  });
  try {
    const rejected = await scheduler.apiAttempt(scheduler.runtimeConfig('B1'));
    assert.equal(rejected.ok, false);
    assert.equal(rejected.noFallback, true);
    assert.equal(rejected.code, 'metric-filter');
    assert.match(rejected.error, /没有达到互动指标/);

    // Pure API mode removes browser fallback, so likes-only metric rejections also stop cleanly.
    repos.setAccountSetting(acc.id, 'filterMinComments', 0);
    repos.setAccountSetting(acc.id, 'filterMinLikes', 99999);
    const likesRejected = await scheduler.apiAttempt(scheduler.runtimeConfig('B1'));
    assert.equal(likesRejected.ok, false);
    assert.equal(likesRejected.noFallback, true);
    assert.equal(likesRejected.code, 'metric-filter');
    assert.match(likesRejected.error, /没有达到互动指标/);
  } finally {
    global.fetch = originalFetch;
    repos.setAccountSetting(acc.id, 'videoSource', 'recommend');
    repos.setAccountSetting(acc.id, 'filterMinLikes', 0);
    repos.setAccountSetting(acc.id, 'filterMinComments', 0);
  }
});

test('runtimeConfig exposes per-metric switches and the age switch', () => {
  const videoPicker = require('../src/video-picker');
  const acc = repos.getAccount('B1');
  repos.setAccountSetting(acc.id, 'filterAgeEnabled', 0);
  repos.setAccountSetting(acc.id, 'filterMinLikes', 999);
  repos.setAccountSetting(acc.id, 'filterLikesEnabled', 0);
  repos.setAccountSetting(acc.id, 'filterMinComments', 5);
  repos.setAccountSetting(acc.id, 'filterCommentsEnabled', 1);
  try {
    const cfg = scheduler.runtimeConfig('B1');
    assert.equal(cfg.ageEnabled, false);
    assert.equal(cfg.metricFilters.likesEnabled, false);
    assert.equal(cfg.metricFilters.commentsEnabled, true);
    assert.equal(videoPicker.metricFiltersActive(cfg.metricFilters), true);
    assert.equal(videoPicker.describeMetricFilters(cfg.metricFilters), '评论≥5');
  } finally {
    repos.setAccountSetting(acc.id, 'filterAgeEnabled', true);
    repos.setAccountSetting(acc.id, 'filterMinLikes', 0);
    repos.setAccountSetting(acc.id, 'filterLikesEnabled', 1);
    repos.setAccountSetting(acc.id, 'filterMinComments', 0);
    repos.setAccountSetting(acc.id, 'filterCommentsEnabled', 0);
  }
});

test('already-sent candidates are filtered before AI ranking, never re-sent', async () => {
  const aiRanker = require('../src/ai/ranker');
  const acc = repos.getAccount('B1');
  repos.setAccountSetting(acc.id, 'videoSource', 'pool');
  repos.setAccountSetting(acc.id, 'aiMode', 'rank');
  repos.setAccountSetting(acc.id, 'filterAgeEnabled', true);
  repos.setAccountSetting(acc.id, 'maxVideoAgeDays', 7);

  const nowSec = Math.floor(Date.now() / 1000);
  const title = '重复候选测试';
  repos.insertSend({
    accountId: acc.id,
    ts: new Date().toISOString(),
    day: today(),
    bucket: '动漫解说',
    title,
    author: '作者',
    likes: 10,
    friend: 'Hime',
    ok: true,
    toast: 'HTTP API',
    videoId: 'dup-video-1',
  });
  const sendsBefore = repos.listSends({ accountId: acc.id, limit: 200 }).length;

  const originalFetch = global.fetch;
  const originalRank = aiRanker.rankCandidates;
  let rankCalls = 0;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      status_code: 0,
      data: [{
        aweme_info: {
          aweme_id: 'dup-video-1',
          desc: title,
          create_time: nowSec - 60,
          author: { nickname: '作者' },
          statistics: { digg_count: 10 },
          video: { cover: { url_list: ['https://x/c.jpg'], uri: 'c', width: 720, height: 1280 } },
        },
      }],
    }),
  });
  aiRanker.rankCandidates = async (candidates) => {
    rankCalls += 1;
    return { used: true, candidates, model: 'test', reason: 'kept' };
  };
  try {
    const out = await scheduler.apiAttempt(scheduler.runtimeConfig('B1'));
    assert.equal(out.ok, false, 'the pool API path should fail cleanly when no fresh candidate exists');
    assert.equal(out.noFallback, true);
    assert.equal(out.code, 'no-fresh-candidate');
    assert.match(out.error, /已发送过/);
    assert.equal(rankCalls, 0, 'history must be filtered before AI ranking');
    assert.equal(repos.listSends({ accountId: acc.id, limit: 200 }).length, sendsBefore);
    const events = repos.listEvents(30).map((e) => e.event);
    assert.ok(events.includes('dedup-exhausted'));
  } finally {
    global.fetch = originalFetch;
    aiRanker.rankCandidates = originalRank;
    repos.setAccountSetting(acc.id, 'videoSource', 'recommend');
    repos.setAccountSetting(acc.id, 'aiMode', 'off');
  }
});

test('a scheduled API send marks the recipient conversation read', async () => {
  setBurst([{ time: hhmm(), count: 1 }], { dailyReadEnabled: '1' });
  const originalFetch = global.fetch;
  const originalSend = apiSender.sendVideo;
  const originalRead = apiRead.markConversationRead;
  const reads = [];
  global.fetch = mockFeed();
  apiSender.sendVideo = async () => ({
    ok: true, api: true, serverMessageId: 'server-read-1', friend: 'Hime',
    conversationId: '0:1:1:2', conversationShortId: '1234567890123456789', durationMs: DURATION_MS,
  });
  apiRead.markConversationRead = async (session, opts) => {
    reads.push(opts);
    return { ok: true, status: 200 };
  };
  try {
    const res = await scheduler.runSchedule(scheduler.runtimeConfig('B1'), today());
    assert.equal(res.done, true);
    assert.equal(reads.length, 1);
    assert.equal(reads[0].conversationId, '0:1:1:2');
    assert.equal(reads[0].conversationShortId, '1234567890123456789');
    assert.ok(repos.listEvents(200).some((e) => e.event === 'daily-read'));
  } finally {
    global.fetch = originalFetch;
    apiSender.sendVideo = originalSend;
    apiRead.markConversationRead = originalRead;
  }
});
