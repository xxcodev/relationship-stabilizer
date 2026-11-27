// End-to-end pure-HTTP mutual sync: dashboard calls Douyin web API directly with session cookies
// (zero browser launch), caches UID lists and renames an existing friend by UID.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const test = require('node:test');
const assert = require('node:assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dyf-mutual-sync-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'app.db');

const repos = require('../src/repos');
const apiSession = require('../src/api-session');
const { syncMutualFriends } = require('../src/dashboard');
const db = require('../src/db');

let server;
let baseUrl;
let acc;

test.before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/aweme/v1/web/user/profile/self/')) {
      res.end(JSON.stringify({
        status_code: 0,
        user: { nickname: '同步测试号', uid: '1', sec_uid: 'sec-self', following_count: 3, follower_count: 3 },
      }));
      return;
    }
    if (req.url.startsWith('/aweme/v1/web/user/following/list/')) {
      res.end(JSON.stringify({
        status_code: 0,
        has_more: false,
        followings: [
          { nickname: '新昵称', uid: '1001', sec_uid: 's1', follow_status: 2 },
          { nickname: '互关乙', uid: '2002', sec_uid: 's2', follow_status: 2 },
          { nickname: '关注丙', uid: '3003', sec_uid: 's3', follow_status: 1 },
        ],
      }));
      return;
    }
    if (req.url.startsWith('/aweme/v1/web/user/follower/list/')) {
      res.end(JSON.stringify({
        status_code: 0,
        has_more: false,
        followers: [
          { nickname: '新昵称', uid: '1001', sec_uid: 's1', follow_status: 2 },
          { nickname: '互关乙', uid: '2002', sec_uid: 's2', follow_status: 2 },
          { nickname: '粉丝丁', uid: '4004', sec_uid: 's4', follow_status: 0 },
        ],
      }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  acc = repos.upsertAccount({ label: 'M1', profileDir: path.join(tmp, 'p'), port, friend: '旧昵称', enabled: true });
  repos.seedAccountDefaults(acc.id);
  repos.addFriend(acc.id, '旧昵称', '1001');
  repos.setSetting('activeAccount', 'M1');
  apiSession.save({
    account: 'M1',
    createdAt: new Date().toISOString(),
    cookies: [{ name: 'sessionid', value: 'test-cookie' }],
    template: { bodyB64: 'AA==' },
  }, 'M1');
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('syncMutualFriends uses pure HTTP cookies to cache UID lists and rename by UID', async () => {
  const cache = await syncMutualFriends(acc, { reason: 'test', baseUrl });
  assert.equal(cache.ok, true);
  assert.equal(cache.self.nickname, '同步测试号');
  assert.equal(cache.mutual.length, 2);
  assert.equal(cache.followingList.length, 3);
  assert.equal(cache.followerList.length, 3);
  assert.equal(cache.analysis.mutual, 2);
  assert.equal(cache.followingTotal, 3);

  const stored = repos.getSetting('mutualFriends:M1', null);
  assert.ok(stored);
  assert.equal(stored.mutual[0].uid, '1001');
  assert.equal(stored.followingList.length, 3);

  const rows = repos.listFriends(acc.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].userid, '1001');
  assert.equal(rows[0].name, '新昵称');
  assert.equal(cache.touched.renamed, 1);
  assert.equal(cache.touched.conflicts, 0);
});
