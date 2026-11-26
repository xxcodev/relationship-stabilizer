// Feed/search URL discovery from the export capture file.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { findFeedUrl, findSearchUrl, findFeedRequest, feedPathHints, isFeedRequestUrl, pickFeedHeaders, chooseExportFriend } = require('../src/api-export');

test('findFeedUrl returns the last tab/feed request and ignores other endpoints', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dyf-capture-'));
  const rows = [
    { kind: 'request', url: 'https://www.douyin.com/aweme/v1/web/tab/feed/?count=10&a_bogus=1' },
    { kind: 'request', url: 'https://www.douyin.com/aweme/v1/web/general/search/single/?keyword=x' },
    { kind: 'request', url: 'https://www.douyin.com/aweme/v1/web/tab/feed/?count=10&a_bogus=2' },
    { kind: 'response', url: 'https://www.douyin.com/aweme/v1/web/tab/feed/?count=10&a_bogus=3' },
  ];
  fs.writeFileSync(path.join(dir, 'all.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'));
  assert.equal(findFeedUrl(dir), rows[2].url);
  assert.equal(findSearchUrl(dir), rows[1].url);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('findFeedRequest returns the captured URL/headers/body for replay', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dyf-capture-'));
  fs.writeFileSync(path.join(dir, 'all.jsonl'), [
    JSON.stringify({
      kind: 'request', method: 'POST', url: 'https://www.douyin.com/aweme/v2/web/module/feed/?count=10',
      bodyB64: 'Ym9keQ==', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }),
    JSON.stringify({
      kind: 'request', method: 'GET', url: 'https://www.douyin.com/aweme/v1/web/tab/feed/?count=10',
      headers: { cookie: 'secret', 'user-agent': 'UA', 'bd-ticket-guard-client-data': 'x', referer: 'https://www.douyin.com/' },
    }),
  ].join('\n'));
  const req = findFeedRequest(dir);
  // The 推荐-tab GET endpoint is preferred over the v2 module POST.
  assert.equal(req.url, 'https://www.douyin.com/aweme/v1/web/tab/feed/?count=10');
  const headers = pickFeedHeaders(req.headers);
  assert.equal(headers['user-agent'], 'UA');
  assert.equal(headers['bd-ticket-guard-client-data'], 'x');
  assert.equal(headers.cookie, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('feed matching covers generic feed/recommend endpoints but not feedback', () => {
  assert.equal(isFeedRequestUrl('https://www.douyin.com/aweme/v1/web/feed/?count=10'), true);
  assert.equal(isFeedRequestUrl('https://www.douyin.com/aweme/v1/web/module/feed/?count=10'), true);
  assert.equal(isFeedRequestUrl('https://www.douyin.com/aweme/v2/web/module/feed/?count=10'), true);
  assert.equal(isFeedRequestUrl('https://www.douyin.com/aweme/v1/web/aweme/recommend/?count=10'), true);
  assert.equal(isFeedRequestUrl('https://www.douyin.com/aweme/v1/web/feedback/list/'), false);
  assert.equal(isFeedRequestUrl('https://example.com/aweme/v1/web/feed/'), false);
});

test('feedPathHints returns sanitized paths for debugging', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dyf-capture-'));
  fs.writeFileSync(path.join(dir, 'all.jsonl'), [
    { kind: 'request', url: 'https://www.douyin.com/aweme/v1/web/tab/feed/?a_bogus=secret' },
    { kind: 'request', url: 'https://www.douyin.com/aweme/v1/web/aweme/recommend/?token=secret' },
    { kind: 'request', url: 'https://www.douyin.com/aweme/v1/web/general/search/single/?keyword=x' },
  ].map((r) => JSON.stringify(r)).join('\n'));
  assert.deepEqual(feedPathHints(dir), [
    '/aweme/v1/web/tab/feed/',
    '/aweme/v1/web/aweme/recommend/',
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('findFeedUrl returns null when no feed request was captured', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dyf-capture-'));
  fs.writeFileSync(path.join(dir, 'all.jsonl'), JSON.stringify({ kind: 'request', url: 'https://x/y' }));
  assert.equal(findFeedUrl(dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('chooseExportFriend prefers an explicit friend, then enabled friends, then the roster', () => {
  const roster = [{ name: 'Hime', enabled: 0 }, { name: '拍拍', enabled: 1 }];
  assert.equal(chooseExportFriend({ requested: 'Hime', accountFriend: '拍拍', enabled: ['拍拍'], all: roster }), 'Hime');
  assert.equal(chooseExportFriend({ accountFriend: '拍拍', enabled: ['拍拍'], all: roster }), '拍拍');
  assert.equal(chooseExportFriend({ accountFriend: '', enabled: ['拍拍'], all: roster }), '拍拍');
  assert.equal(chooseExportFriend({ accountFriend: 'Hime', enabled: [], all: roster }), 'Hime');
  assert.equal(chooseExportFriend({ accountFriend: 'missing', enabled: [], all: roster }), 'Hime');
  assert.equal(chooseExportFriend({}), '');
});
