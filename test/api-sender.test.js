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
