/**
 * @file Unit tests for the pure-API sender helpers that don't touch the network.
 */
const test = require('node:test');
const assert = require('node:assert');
const apiSender = require('../src/api-sender');

const session = {
  friend: 'Hime',
  friends: [
    { name: 'Hime', userid: '102092647640' },
    { name: '拍拍', userid: '2892143345565097' },
  ],
  createTemplate: null,
  cookies: [],
  template: { url: 'https://example', bodyB64: '' },
};

test('resolveFriend matches exact names only', () => {
  assert.strictEqual(apiSender.resolveFriend(session, 'Hime').userid, '102092647640');
  assert.strictEqual(apiSender.resolveFriend(session, 'Him'), null);
  assert.strictEqual(apiSender.friends(session).length, 2);
});

test('createConversation fails cleanly when the session has no create template', async () => {
  const out = await apiSender.createConversation(session, '93188024801');
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /template/);
});

test('sendVideo refuses unknown friends instead of falling back silently', async () => {
  const out = await apiSender.sendVideo(session, { title: 'x', awemeId: '1' }, { friend: '不存在的人' });
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /不在会话好友列表/);
});

test('buildSearchUrl swaps keywords and starts from the first result page', () => {
  const s = { searchUrl: 'https://www.douyin.com/aweme/v1/web/general/search/single/?keyword=%E6%97%A5%E6%BC%AB&offset=10&count=10&a_bogus=x&msToken=y' };
  const u = new URL(apiSender.buildSearchUrl(s, '韩剧推荐'));
  assert.equal(u.searchParams.get('keyword'), '韩剧推荐');
  assert.equal(u.searchParams.get('offset'), '0');
  assert.equal(u.searchParams.get('count'), '10');
  assert.equal(u.searchParams.has('a_bogus'), false);
  assert.equal(u.searchParams.has('msToken'), false);
});

test('buildSearchUrl uses the latest/7-day search filter when requested', () => {
  const s = { searchUrl: 'https://www.douyin.com/aweme/v1/web/general/search/single/?keyword=x&offset=10&count=10' };
  const u = new URL(apiSender.buildSearchUrl(s, '韩剧', { maxAgeDays: 7 }));
  assert.equal(u.searchParams.get('offset'), '0');
  assert.equal(u.searchParams.get('is_filter_search'), '1');
  const filter = JSON.parse(u.searchParams.get('filter_selected'));
  assert.deepEqual(filter, { sort_type: '2', publish_time: '7' });
});


test('collectSearchCandidates returns the filtered pool candidates before random choice', async () => {
  const now = Math.floor(Date.now() / 1000);
  const original = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      status_code: 0,
      data: [{
        aweme_info: {
          aweme_id: 'pool-1', desc: '池搜索候选', create_time: now - 3600,
          author: { nickname: '作者' }, statistics: { digg_count: 12, comment_count: 3, collect_count: 2, share_count: 1 },
          video: { cover: { url_list: ['https://x/c.jpg'], uri: 'c', width: 1080, height: 1920 } },
        },
      }],
    }),
  });
  try {
    const out = await apiSender.collectSearchCandidates({ searchUrl: 'https://www.douyin.com/aweme/v1/web/general/search/single/?keyword=x&offset=0&count=10' }, { keyword: '测试', maxAgeDays: 7 });
    assert.equal(out.rawCount, 1);
    assert.equal(out.candidates.length, 1);
    assert.equal(out.candidates[0].awemeId, 'pool-1');
    assert.equal(out.candidates[0].comments, 3);
    assert.equal(out.candidates[0].collects, 2);
    assert.equal(out.candidates[0].shares, 1);
  } finally { global.fetch = original; }
});

test('collectSearchCandidates applies interaction filters', async () => {
  const now = Math.floor(Date.now() / 1000);
  const original = global.fetch;
  const aweme = (id, stats) => ({
    aweme_info: {
      aweme_id: id,
      desc: '候选 ' + id,
      create_time: now - 3600,
      author: { nickname: '作者' },
      statistics: stats,
      video: { cover: { url_list: ['https://x/c.jpg'], uri: 'c', width: 1080, height: 1920 } },
    },
  });
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      status_code: 0,
      data: [
        aweme('hot', { digg_count: 100, comment_count: 8, collect_count: 5, share_count: 2 }),
        aweme('cold', { digg_count: 5, comment_count: 0, collect_count: 0, share_count: 0 }),
      ],
    }),
  });
  const session = { searchUrl: 'https://www.douyin.com/aweme/v1/web/general/search/single/?keyword=x' };
  try {
    const out = await apiSender.collectSearchCandidates(session, {
      keyword: '测试', maxAgeDays: 7,
      filters: { minLikes: 50, minComments: 1, minFavorites: 1, minShares: 1 },
    });
    assert.deepEqual(out.candidates.map((c) => c.awemeId), ['hot']);
    assert.equal(out.metricFiltered, 1);

    await assert.rejects(
      () => apiSender.collectSearchCandidates(session, { keyword: '测试', maxAgeDays: 7, filters: { minLikes: 99999 } }),
      /没有达到互动指标（点赞≥99999）/
    );
  } finally { global.fetch = original; }
});
