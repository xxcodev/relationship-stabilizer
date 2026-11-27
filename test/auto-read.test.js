// Standalone read receipts: multi-friend checks, random interval and fixed-window scheduling.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dyf-auto-read-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'app.db');

const repos = require('../src/repos');
const apiSession = require('../src/api-session');
const apiSender = require('../src/api-sender');
const apiRead = require('../src/api-read');
const autoRead = require('../src/auto-read');

test.after(() => {
  try { require('../src/db').close(); } catch (e) {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

function makeSession(label) {
  apiSession.save({
    version: 4,
    createdAt: new Date().toISOString(),
    account: label,
    friend: 'FriendA',
    template: { url: 'https://imapi.douyin.com/v1/message/send', bodyB64: 'ZmFrZQ==' },
    createTemplate: { url: 'https://imapi.douyin.com/v2/conversation/create', bodyB64: 'ZmFrZQ==' },
    friends: [{ name: 'FriendA', userid: '424242' }, { name: 'FriendB', userid: '515151' }],
    cookies: [{ domain: '.douyin.com', name: 'sid', value: 'abc' }],
  }, label);
}

test('auto read checks every selected friend and caches each conversation', async () => {
  const acc = repos.upsertAccount({ label: 'R1', profileDir: path.join(tmp, 'p'), port: 9336, friend: 'FriendA', enabled: true });
  repos.setAccountSetting(acc.id, 'autoReadEnabled', true);
  repos.setAccountSetting(acc.id, 'autoReadFriends', [{ uid: '424242', name: 'FriendA' }, { uid: '515151', name: 'FriendB' }]);
  repos.setAccountSetting(acc.id, 'autoReadMinMin', 10);
  repos.setAccountSetting(acc.id, 'autoReadMaxMin', 60);
  makeSession('R1');

  const originalCreate = apiSender.createConversation;
  const originalRead = apiRead.markConversationRead;
  let created = 0;
  const reads = [];
  apiSender.createConversation = async (session, uid) => {
    created += 1;
    return { ok: true, conversationId: `0:1:1:${uid}`, conversationShortId: `900${uid.slice(-1)}` };
  };
  apiRead.markConversationRead = async (session, opts) => {
    reads.push(opts);
    return { ok: true, status: 200 };
  };
  try {
    const cfg = autoRead.config(acc);
    assert.equal(cfg.friends.length, 2);
    assert.equal(cfg.minMin, 10);
    assert.equal(cfg.maxMin, 60);
    assert.equal(cfg.windowEnabled, false);

    const next = autoRead.nextCheckAt(cfg, new Date('2026-01-01T00:00:00'), () => 0.5);
    assert.equal(next.getTime() - new Date('2026-01-01T00:00:00').getTime(), 35 * 60000);

    const first = await autoRead.tick(acc, { force: true, now: new Date('2026-01-01T00:00:00') });
    assert.equal(first.ok, true);
    assert.equal(created, 2);
    assert.equal(reads.length, 2);
    assert.deepEqual(reads.map((r) => r.conversationId).sort(), ['0:1:1:424242', '0:1:1:515151']);
    let st = autoRead.state(acc);
    assert.equal(st.friends.length, 2);
    assert.ok(st.nextAt);

    const second = await autoRead.tick(acc, { force: true, now: new Date('2026-01-01T00:01:00') });
    assert.equal(second.ok, true);
    assert.equal(created, 2);
    assert.equal(reads.length, 4);
    st = autoRead.state(acc);
    assert.equal(st.friends.every((f) => f.ok), true);
    assert.ok(repos.listEvents(200).some((e) => e.event === 'auto-read'));
  } finally {
    apiSender.createConversation = originalCreate;
    apiRead.markConversationRead = originalRead;
    apiSession.clearAccount('R1');
  }
});

test('fixed window schedules fixed frequency inside, random or pause outside', () => {
  const cfg = {
    enabled: true,
    friends: [{ uid: '1', name: 'A' }],
    minMin: 10,
    maxMin: 60,
    windowEnabled: true,
    windowStart: '09:00',
    windowEnd: '23:00',
    windowIntervalMin: 15,
    outside: 'random',
  };
  const at = (s) => new Date(`2026-01-01T${s}:00`);
  assert.equal(autoRead.inWindow(at('10:00'), cfg), true);
  assert.equal(autoRead.inWindow(at('08:00'), cfg), false);
  assert.equal(autoRead.nextCheckAt(cfg, at('10:00')).getTime(), at('10:15').getTime());
  // 22:50 + 15m would leave the window; the next check is after 23:00, random 10-60m.
  const after = autoRead.nextCheckAt(cfg, at('22:50'), () => 0);
  assert.equal(after.getTime(), new Date('2026-01-01T23:10:00').getTime());
  // Outside pause waits for the next window start.
  const paused = autoRead.nextCheckAt({ ...cfg, outside: 'pause' }, at('08:00'), () => 0);
  assert.equal(paused.getTime(), at('09:00').getTime());
  // Overnight window.
  const overnight = { ...cfg, windowStart: '22:00', windowEnd: '06:00', outside: 'pause' };
  assert.equal(autoRead.inWindow(at('23:00'), overnight), true);
  assert.equal(autoRead.inWindow(at('12:00'), overnight), false);
  assert.equal(autoRead.nextCheckAt(overnight, at('12:00'), () => 0).getTime(), at('22:00').getTime());
});

test('auto read is off by default and supports the legacy single friend setting', async () => {
  const acc = repos.upsertAccount({ label: 'R2', profileDir: path.join(tmp, 'p2'), port: 9337, friend: '', enabled: true });
  assert.equal(autoRead.config(acc).enabled, false);
  assert.equal(autoRead.config(acc).friends.length, 0);
  const off = await autoRead.tick(acc);
  assert.equal(off.skipped, 'disabled');

  repos.setAccountSetting(acc.id, 'autoReadFriend', 'Legacy');
  repos.setAccountSetting(acc.id, 'autoReadFriendUid', '777');
  const cfg = autoRead.config(acc);
  assert.deepEqual(cfg.friends.map((f) => f.uid), ['777']);
  assert.equal(cfg.minMin, 10);
  assert.equal(cfg.maxMin, 60);
});
