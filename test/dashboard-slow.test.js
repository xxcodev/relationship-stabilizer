// Dashboard 慢递 API: preflight, start validation, live data, manual-send/reset exclusion, stop.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dyf-dash-slow-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'app.db');

const repos = require('../src/repos');
const { POOLS } = require('../src/pools');
const { startServer } = require('../src/dashboard');
const db = require('../src/db');

let server;
let url;
let acc;

function lockFile() {
  return path.join(tmp, 'run', 'schedule-S1.lock');
}

function writeLock() {
  fs.mkdirSync(path.dirname(lockFile()), { recursive: true });
  fs.writeFileSync(lockFile(), JSON.stringify({ pid: process.pid, account: 'S1' }));
}

test.before(async () => {
  repos.seedPools(POOLS);
  acc = repos.upsertAccount({ label: 'S1', profileDir: path.join(tmp, 'p'), port: 9339, friend: 'Hime', enabled: true });
  repos.seedAccountDefaults(acc.id);
  repos.addFriend(acc.id, 'Hime', '10001');
  repos.addFriend(acc.id, 'Other', '');
  repos.setSetting('activeAccount', 'S1');
  repos.setAccountSetting(acc.id, 'videoSource', 'pool');
  repos.setAccountSetting(acc.id, 'sendMode', 'auto');
  writeLock();
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
const post = async (p, body) => {
  const r = await fetch(url + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, body: await r.json() };
};

const START = {
  durationMin: 30,
  minGapSec: 60,
  maxGapSec: 120,
  bufferSec: 5,
  fallbackSec: 10,
  maxSends: 3,
  friend: 'Hime',
};

test('GET /api/slow returns defaults, friends and scheduler preflight', async () => {
  const d = await get('/api/slow');
  assert.equal(d.ok, true);
  assert.equal(d.live, false);
  assert.equal(d.schedulerUp, true);
  assert.equal(d.config.durationMin, 120);
  assert.equal(d.config.minGapSec, 180);
  assert.equal(d.config.maxGapSec, 600);
  assert.equal(d.config.readEnabled, true);
  assert.ok(Array.isArray(d.friends));
  assert.ok(d.friends.some((f) => f.name === 'Hime' && f.apiCapable));
  assert.ok(d.friends.some((f) => f.name === 'Other'));
});

test('start validates, writes pending and saves the next prefill', async () => {
  const badFriend = await post('/api/slow/start', { ...START, friend: 'Nobody' });
  assert.equal(badFriend.status, 400);

  const badRange = await post('/api/slow/start', { ...START, minGapSec: 120, maxGapSec: 60 });
  assert.equal(badRange.status, 400);

  const started = await post('/api/slow/start', START);
  assert.equal(started.status, 202);
  assert.equal(started.body.ok, true);
  assert.equal(started.body.state.status, 'pending');
  assert.equal(started.body.state.friend, 'Hime');
  assert.equal(started.body.state.friendUid, '10001');
  assert.equal(started.body.state.maxSends, 3);
  assert.equal(started.body.state.readEnabled, true);

  const state = repos.getSlowMailState(acc.id);
  assert.ok(state);
  assert.equal(state.status, 'pending');
  assert.equal(repos.getAccountSetting(acc.id, 'slowMailMinGapSec'), 60);
  assert.equal(repos.getAccountSetting(acc.id, 'slowMailFriend'), 'Hime');
  assert.equal(repos.getAccountSetting(acc.id, 'slowMailFriendUid'), '10001');
  assert.equal(repos.getAccountSetting(acc.id, 'slowMailReadEnabled'), '1');

  const data = await get('/api/data');
  assert.equal(data.slow.live, true);
  assert.equal(data.slow.config.minGapSec, 60);
  assert.equal(data.slow.state.status, 'pending');
});

test('manual send and plan reset are rejected while live', async () => {
  const send = await post('/api/send-now', {});
  assert.equal(send.status, 409);
  assert.match(send.body.error, /慢递/);

  const regen = await post('/api/today/regenerate', {});
  assert.equal(regen.status, 409);

  const reset = await post('/api/today/burst-reset', {});
  assert.equal(reset.status, 409);
});

test('stop ends the session and the card returns to idle', async () => {
  const stopped = await post('/api/slow/stop', {});
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.ok, true);
  assert.equal(stopped.body.state.status, 'stopped');

  const data = await get('/api/data');
  assert.equal(data.slow.live, false);
  assert.equal(data.slow.state.status, 'stopped');

  const again = await post('/api/slow/stop', {});
  assert.equal(again.status, 200);
  assert.equal(again.body.already, true);

  const restarted = await post('/api/slow/start', { ...START, readEnabled: false });
  assert.equal(restarted.status, 202);
  assert.equal(restarted.body.config.readEnabled, false);
  assert.equal(restarted.body.state.readEnabled, false);
  assert.equal(repos.getAccountSetting(acc.id, 'slowMailReadEnabled'), '0');
  const stoppedOff = await post('/api/slow/stop', {});
  assert.equal(stoppedOff.status, 200);
});

test('a paused account or a missing scheduler lock cannot start', async () => {
  repos.setAccountEnabled(acc.id, false);
  const paused = await post('/api/slow/start', START);
  assert.equal(paused.status, 409);
  assert.match(paused.body.error, /暂停/);
  repos.setAccountEnabled(acc.id, true);

  fs.rmSync(lockFile(), { force: true });
  const noSched = await post('/api/slow/start', START);
  assert.equal(noSched.status, 409);
  assert.match(noSched.body.error, /调度/);
  writeLock();

  const ok = await post('/api/slow/start', START);
  assert.equal(ok.status, 202);
  await post('/api/slow/stop', {});
});

test('互关好友全部出现在收件人列表，选未加入的互关会在开始时加入发送好友', async () => {
  repos.setSetting('mutualFriends:S1', {
    label: 'S1',
    mutual: [{ name: 'NewMutual', uid: '30003' }],
    fetchedAt: new Date().toISOString(),
  });
  const before = await get('/api/slow');
  const candidate = before.friends.find((f) => String(f.uid) === '30003');
  assert.ok(candidate);
  assert.equal(candidate.source, 'mutual');
  assert.ok(before.counts);
  assert.equal(before.counts.extra, 1);

  const started = await post('/api/slow/start', { ...START, friend: 'NewMutual', friendUid: '30003' });
  assert.equal(started.status, 202);
  assert.equal(started.body.state.friend, 'NewMutual');
  assert.equal(started.body.state.friendUid, '30003');
  const row = repos.listFriends(acc.id).find((f) => String(f.userid) === '30003');
  assert.ok(row);
  assert.equal(row.name, 'NewMutual');
  assert.equal(!!row.enabled, true);
  assert.ok(repos.listEvents(200).some((e) => e.event === 'slow-friend-add'));

  const stopped = await post('/api/slow/stop', {});
  assert.equal(stopped.status, 200);
});
