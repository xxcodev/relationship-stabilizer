// Recommendation source end-to-end (feed + send mocked, no browser, no network).
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dyf-sched-feed-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'app.db');

const repos = require('../src/repos');
const apiSession = require('../src/api-session');
const apiSender = require('../src/api-sender');
const { POOLS } = require('../src/pools');
const scheduler = require('../src/scheduler');
const aiClient = require('../src/ai/client');
let accountId = null;

test.after(() => {
  try { require('../src/db').close(); } catch (e) {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('recommend source uses the pure-HTTP feed and records source=recommend', async () => {
  repos.seedPools(POOLS);
  const acc = repos.upsertAccount({ label: 'A', profileDir: path.join(tmp, 'p'), port: 9334, friend: 'Hime', enabled: true });
  accountId = acc.id;
  repos.replaceBands(acc.id, [{ name: '晚', startMin: 1200, endMin: 1410, minCount: 1, maxCount: 2 }]);
  repos.seedAccountDefaults(acc.id);
  repos.addFriend(acc.id, 'Hime');
  repos.setAccountSetting(acc.id, 'sendMode', 'auto');
  repos.setAccountSetting(acc.id, 'videoSource', 'recommend');
  repos.setSetting('activeAccount', 'A');

  apiSession.save({
    version: 4,
    createdAt: new Date().toISOString(),
    account: 'A',
    friend: 'Hime',
    feedUrl: 'https://www.douyin.com/aweme/v1/web/tab/feed/?count=10&a_bogus=SIGNED',
    searchUrl: 'https://www.douyin.com/aweme/v1/web/general/search/single/?keyword=x',
    template: { url: 'https://imapi.douyin.com/v1/message/send', bodyB64: 'ZmFrZQ==' },
    friends: [{ name: 'Hime', userid: '1' }],
    cookies: [{ domain: '.douyin.com', name: 'sid', value: 'abc' }],
  }, 'A');

  const originalFetch = global.fetch;
  const originalSend = apiSender.sendVideo;
  const nowSec = Math.floor(Date.now() / 1000);
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      status_code: 0,
      aweme_list: [{
        aweme_id: '7300000000000000001',
        desc: '推荐视频',
        create_time: nowSec - 60,
        statistics: { digg_count: 10 },
        author: { nickname: '作者', uid: 'u1', avatar_thumb: { url_list: ['https://x/t.jpg'], uri: 't' } },
        video: { cover: { url_list: ['https://x/c.jpg'], uri: 'c', width: 720, height: 1280 } },
      }],
    }),
  });
  apiSender.sendVideo = async () => ({ ok: true, serverMessageId: 'server-1' });

  try {
    const cfg = scheduler.runtimeConfig('A');
    assert.equal(cfg.videoSource, 'recommend');
    const res = await scheduler.apiAttempt(cfg);
    assert.equal(res.ok, true);
    assert.equal(res.source, 'recommend');
    assert.equal(res.bucket, '默认推荐');
    const rows = repos.listSends({ accountId: acc.id, limit: 5 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'recommend');
    assert.equal(rows[0].bucket, '默认推荐');
  } finally {
    global.fetch = originalFetch;
    apiSender.sendVideo = originalSend;
  }
});

test('AI moderate mode filters a recommendation candidate before sending', async () => {
  const acc = repos.getAccount('A');
  repos.setAccountSetting(acc.id, 'videoSource', 'recommend');
  repos.setAccountSetting(acc.id, 'aiMode', 'moderate');
  aiClient.save({ enabled: true, baseUrl: 'https://ai.test/v1', model: 'm', apiKey: 'k' });
  const originalFetch = global.fetch;
  const originalSend = apiSender.sendVideo;
  let sentTitle = null;
  const nowSec = Math.floor(Date.now() / 1000);
  const feedVideo = (id, title) => ({
    aweme_info: {
      aweme_id: id,
      desc: title,
      create_time: nowSec - 60,
      statistics: { digg_count: 1 },
      author: { nickname: '作者', uid: 'u1', avatar_thumb: { url_list: ['https://x/t.jpg'], uri: 't' } },
      video: { cover: { url_list: ['https://x/c.jpg'], uri: 'c', width: 720, height: 1280 } },
    },
  });
  global.fetch = async (url) => {
    if (String(url).includes('douyin.com')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          status_code: 0,
          aweme_list: [feedVideo('safe-1', '安全视频'), feedVideo('bad-1', '不合适的视频')],
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ items: [
          { id: 'safe-1', safe: true, ad: false, score: 80 },
          { id: 'bad-1', safe: false, ad: false, score: 10 },
        ] }) } }],
      }),
    };
  };
  apiSender.sendVideo = async (session, video) => { sentTitle = video.title; return { ok: true, serverMessageId: 's' }; };
  try {
    const cfg = scheduler.runtimeConfig('A');
    assert.equal(cfg.aiMode, 'moderate');
    const res = await scheduler.apiAttempt(cfg);
    assert.equal(res.ok, true);
    assert.equal(sentTitle, '安全视频');
  } finally {
    global.fetch = originalFetch;
    apiSender.sendVideo = originalSend;
    aiClient.save({ enabled: false });
    repos.setAccountSetting(acc.id, 'aiMode', 'off');
  }
});

test('AI moderate mode filters pool-search candidates too', async () => {
  const acc = repos.getAccount('A');
  repos.setAccountSetting(acc.id, 'videoSource', 'pool');
  repos.setAccountSetting(acc.id, 'aiMode', 'moderate');
  aiClient.save({ enabled: true, baseUrl: 'https://ai.test/v1', model: 'm', apiKey: 'k' });
  const originalFetch = global.fetch;
  const originalSend = apiSender.sendVideo;
  let sentTitle = null;
  const nowSec = Math.floor(Date.now() / 1000);
  const searchVideo = (id, title) => ({
    aweme_info: {
      aweme_id: id,
      desc: title,
      create_time: nowSec - 60,
      statistics: { digg_count: 1 },
      author: { nickname: '作者' },
      video: { cover: { url_list: ['https://x/c.jpg'], uri: 'c', width: 720, height: 1280 } },
    },
  });
  global.fetch = async (url) => {
    if (String(url).includes('douyin.com')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          status_code: 0,
          data: [searchVideo('pool-good', '池安全视频'), searchVideo('pool-bad', '池不合适视频')],
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ items: [
          { id: 'pool-good', safe: true, ad: false, score: 80 },
          { id: 'pool-bad', safe: false, ad: false, score: 10 },
        ] }) } }],
      }),
    };
  };
  apiSender.sendVideo = async (session, video) => { sentTitle = video.title; return { ok: true, serverMessageId: 's' }; };
  try {
    const cfg = scheduler.runtimeConfig('A');
    assert.equal(cfg.videoSource, 'pool');
    assert.equal(cfg.aiMode, 'moderate');
    const res = await scheduler.apiAttempt(cfg);
    assert.equal(res.ok, true);
    assert.equal(res.source, 'pool');
    assert.equal(sentTitle, '池安全视频');
  } finally {
    global.fetch = originalFetch;
    apiSender.sendVideo = originalSend;
    aiClient.save({ enabled: false });
    repos.setAccountSetting(acc.id, 'aiMode', 'off');
  }
});

test('recommend source never falls back to the browser when the API session is unusable', async () => {
  apiSession.clearAccount('A');
  const cfg = scheduler.runtimeConfig('A');
  cfg.videoSource = 'recommend';
  cfg.sendMode = 'auto';
  const res = await scheduler.sendOne(cfg);
  assert.equal(res.ok, false);
  assert.equal(res.noFallback, true);
  assert.match(res.error, /纯 API 会话不可用|empty|会话/);
});
