// Natural share flow: one video -> comments -> AI note -> card + text over pure API.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dyf-natural-flow-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'app.db');

const repos = require('../src/repos');
const { POOLS } = require('../src/pools');
const apiSession = require('../src/api-session');
const apiSender = require('../src/api-sender');
const commentReader = require('../src/comments');
const naturalAi = require('../src/ai/natural');
const scheduler = require('../src/scheduler');

test.after(() => {
  try { require('../src/db').close(); } catch (e) {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('natural share sends a card, a public-comment-based note and a text via API', async () => {
  repos.seedPools(POOLS);
  const acc = repos.upsertAccount({ label: 'A', profileDir: path.join(tmp, 'p'), port: 9334, friend: 'Hime', enabled: true });
  repos.replaceBands(acc.id, [{ name: '晚', startMin: 1200, endMin: 1410, minCount: 1, maxCount: 2 }]);
  repos.seedAccountDefaults(acc.id);
  repos.addFriend(acc.id, 'Hime');
  repos.setAccountSetting(acc.id, 'sendMode', 'auto');
  repos.setAccountSetting(acc.id, 'videoSource', 'recommend');
  repos.setAccountSetting(acc.id, 'naturalShare', true);
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

  const original = {
    collect: apiSender.collectFeedCandidates,
    video: apiSender.sendVideo,
    text: apiSender.sendText,
    comments: commentReader.fetchComments,
    notes: naturalAi.composeShareNotes,
  };
  const calls = [];
  apiSender.collectFeedCandidates = async () => ({
    rawCount: 1,
    candidates: [{ awemeId: 'v1', title: '测试视频', author: '作者', likes: 3, createTime: Math.floor(Date.now() / 1000) - 60 }],
  });
  apiSender.sendVideo = async (session, video, opts) => {
    calls.push({ type: 'video', title: video.title, opts });
    return { ok: true, conversationId: 'conv-1', conversationShortId: 'short-1', serverMessageId: 'msg-video' };
  };
  apiSender.sendText = async (session, text, opts) => {
    calls.push({ type: 'text', text, opts });
    return { ok: true, conversationId: 'conv-1', conversationShortId: 'short-1', serverMessageId: 'msg-text' };
  };
  commentReader.fetchComments = async () => ({ comments: [{ text: '评论区第一条', likes: 9 }], rawCount: 1 });
  naturalAi.composeShareNotes = async () => ({ messages: ['这个评论区有点东西'], used: true });

  try {
    const cfg = scheduler.runtimeConfig('A');
    assert.equal(cfg.naturalShare, true);
    const out = await scheduler.apiAttempt(cfg);
    assert.equal(out.ok, true);
    assert.equal(out.natural, true);
    assert.equal(out.videos.length, 1);
    assert.deepEqual(out.messages, ['这个评论区有点东西']);
    assert.deepEqual(calls.map((c) => c.type), ['video', 'text']);
    assert.equal(calls[1].opts.conversationId, 'conv-1');
    const rows = repos.listSends({ accountId: acc.id, limit: 5 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, '测试视频');
  } finally {
    apiSender.collectFeedCandidates = original.collect;
    apiSender.sendVideo = original.video;
    apiSender.sendText = original.text;
    commentReader.fetchComments = original.comments;
    naturalAi.composeShareNotes = original.notes;
  }
});
