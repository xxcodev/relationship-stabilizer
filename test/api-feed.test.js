// Pure-HTTP recommendation feed selection (fetch mocked; no network).
const test = require('node:test');
const assert = require('node:assert');
const apiSender = require('../src/api-sender');

const nowSec = Math.floor(Date.now() / 1000);
const session = {
  feedUrl: 'https://www.douyin.com/aweme/v1/web/tab/feed/?count=10&a_bogus=SIGNED',
  cookies: [{ domain: '.douyin.com', name: 'sid', value: 'abc' }],
  friend: 'Hime',
};

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
    arrayBuffer: async () => Buffer.from(JSON.stringify(payload)),
  };
}

function video(id, extra = {}) {
  return {
    aweme_info: {
      aweme_id: id,
      desc: `视频 ${id}`,
      create_time: nowSec - 3600,
      statistics: { digg_count: 100 },
      author: { nickname: '作者', uid: 'u1', avatar_thumb: { url_list: ['https://x/t.jpg'], uri: 't' } },
      video: { cover: { url_list: ['https://x/c.jpg'], uri: 'c', width: 720, height: 1280 } },
      ...extra,
    },
  };
}

test('pickFromFeed reads the captured URL unchanged and picks a video', async () => {
  const original = global.fetch;
  let seenUrl = '';
  global.fetch = async (url) => {
    seenUrl = String(url);
    return response({ status_code: 0, aweme_list: [video('1'), video('2')] });
  };
  try {
    const picked = await apiSender.pickFromFeed(session, { maxAgeDays: 7, banWords: [] });
    assert.equal(seenUrl, session.feedUrl);
    assert.ok(['1', '2'].includes(picked.awemeId));
    assert.equal(picked.source, 'recommend');
    assert.equal(picked.bucket, '默认推荐');
    assert.equal(picked.coverUrlList.length, 1);
  } finally {
    global.fetch = original;
  }
});

test('pickFromFeed filters live, image, ads and banned titles', async () => {
  const original = global.fetch;
  global.fetch = async () => response({
    status_code: 0,
    aweme_list: [
      video('ok'),
      video('live', { live_info: { room_id: 1 } }),
      video('img', { aweme_type: 68 }),
      video('ad', { is_ads: 1 }),
      video('bad', { desc: '恐怖内容' }),
    ],
  });
  try {
    const picked = await apiSender.pickFromFeed(session, { maxAgeDays: 7, banWords: ['恐怖'] });
    assert.equal(picked.awemeId, 'ok');
  } finally {
    global.fetch = original;
  }
});

test('pickFromFeed explains an empty 200 response', async () => {
  const original = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, text: async () => '' });
  try {
    await assert.rejects(
      () => apiSender.pickFromFeed(session, {}),
      /空响应/
    );
  } finally {
    global.fetch = original;
  }
});

test('pickFromFeed replays a captured POST feed with its body', async () => {
  const original = global.fetch;
  let init = null;
  global.fetch = async (url, options) => {
    init = options;
    return response({
      status_code: 0,
      aweme_list: [{
        aweme_id: 'post-1', desc: 'POST 推荐', create_time: nowSec - 60,
        statistics: { digg_count: 1 }, author: { nickname: 'a', uid: 'u' },
        video: { cover: { url_list: ['https://x/c.jpg'], uri: 'c', width: 1, height: 1 } },
      }],
    });
  };
  try {
    const picked = await apiSender.pickFromFeed({
      ...session,
      feedMethod: 'POST',
      feedBodyB64: Buffer.from('hello').toString('base64'),
      feedHeaders: { 'content-type': 'application/x-www-form-urlencoded' },
    }, {});
    assert.equal(picked.awemeId, 'post-1');
    assert.equal(init.method, 'POST');
    assert.equal(init.body.toString(), 'hello');
    assert.equal(init.headers['content-type'], 'application/x-www-form-urlencoded');
  } finally {
    global.fetch = original;
  }
});

test('pickFromFeed reports a missing captured feed URL', async () => {
  await assert.rejects(
    () => apiSender.pickFromFeed({ cookies: [] }, {}),
    /没有捕获到首页推荐 feed/
  );
});

test('pickFromFeed explains 403 as a signature/session problem', async () => {
  const original = global.fetch;
  global.fetch = async () => response({}, 403);
  try {
    await assert.rejects(
      () => apiSender.pickFromFeed(session, {}),
      /推荐 feed 请求失败：HTTP 403/
    );
  } finally {
    global.fetch = original;
  }
});

test('feed candidates carry the video duration for burst pacing', async () => {
  const original = global.fetch;
  global.fetch = async () => response({
    status_code: 0,
    aweme_list: [
      video('d', {
        video: {
          duration: 18500,
          cover: { url_list: ['https://x/c.jpg'], uri: 'c', width: 720, height: 1280 },
        },
      }),
    ],
  });
  try {
    const picked = await apiSender.pickFromFeed(session, { maxAgeDays: 7, banWords: [] });
    assert.equal(picked.durationMs, 18500);
  } finally {
    global.fetch = original;
  }
});

test('feed candidates expose interaction stats and honor filters', async () => {
  const original = global.fetch;
  global.fetch = async () => response({
    status_code: 0,
    aweme_list: [
      video('hot', { statistics: { digg_count: 100, comment_count: 9, collect_count: 4, share_count: 3 } }),
      video('cold', { statistics: { digg_count: 1, comment_count: 0, collect_count: 0, share_count: 0 } }),
    ],
  });
  try {
    const out = await apiSender.collectFeedCandidates(session, { maxAgeDays: 7, filters: { minComments: 5 } });
    assert.deepEqual(out.candidates.map((c) => c.awemeId), ['hot']);
    assert.equal(out.candidates[0].comments, 9);
    assert.equal(out.candidates[0].collects, 4);
    assert.equal(out.candidates[0].shares, 3);
    assert.equal(out.metricFiltered, 1);

    await assert.rejects(
      () => apiSender.collectFeedCandidates(session, { maxAgeDays: 7, filters: { minLikes: 1000 } }),
      /没有达到互动指标/
    );
  } finally {
    global.fetch = original;
  }
});
