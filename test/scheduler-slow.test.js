// Slow-mail session integration: deadline, gap floor, preemption, pause/resume, failure kinds.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dyf-slow-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'app.db');

const repos = require('../src/repos');
const scheduler = require('../src/scheduler');
const slow = require('../src/slow-mail');
const { POOLS } = require('../src/pools');

const START = 1795686120000; // 2026-11-26 17:42 Asia/Shanghai
let acc;

function clockFrom(start) {
  let clock = start;
  return {
    now: () => new Date(clock),
    get: () => clock,
    advance: (ms) => { clock += Math.max(0, Number(ms) || 0); },
    wait: async (ms) => { clock += Math.max(0, Number(ms) || 0); return true; },
  };
}

function makeState(extra = {}) {
  return slow.createState({
    cfg: {
      ...slow.DEFAULTS,
      durationMin: 30,
      minGapSec: 60,
      maxGapSec: 120,
      bufferSec: 5,
      fallbackSec: 10,
      maxSends: 3,
      friend: 'Hime',
      account: 'S1',
      ...extra,
    },
    nowMs: START,
    random: () => 0,
  });
}

function runtime() {
  return scheduler.runtimeConfig('S1');
}

function eventsFor(id) {
  return repos.listEvents(300)
    .map((e) => {
      try { return { event: e.event, data: JSON.parse(e.payload || '{}') }; } catch (err) { return { event: e.event, data: {} }; }
    })
    .filter((e) => e.data.sessionId === id);
}

function payloadsFor(id, event) {
  return eventsFor(id).filter((e) => e.event === event).map((e) => e.data);
}

function dailyState(day, points) {
  return {
    day,
    mode: 'schedule',
    configKey: '',
    points: points.map((p) => ({
      mode: 'fixed', time: '18:00', count: 1, sent: 0, status: 'pending',
      startAt: START, nextAt: START, lastAt: null, lastDurationMs: 0, lastTitle: '', lastError: '',
      ...p,
    })),
    active: 0,
    status: 'pending',
    sent: 0,
    updatedAt: new Date(START).toISOString(),
  };
}

test.before(() => {
  repos.seedPools(POOLS);
  acc = repos.upsertAccount({ label: 'S1', profileDir: path.join(tmp, 'p'), port: 9339, friend: 'Hime', enabled: true });
  repos.seedAccountDefaults(acc.id);
  repos.addFriend(acc.id, 'Hime');
  repos.setFriendUserid(acc.id, repos.getFriendByName(acc.id, 'Hime').id, '10001');
  repos.setSetting('activeAccount', 'S1');
  repos.setAccountSetting(acc.id, 'sendMode', 'auto');
  repos.setAccountSetting(acc.id, 'videoSource', 'pool');
  repos.setAccountSetting(acc.id, 'naturalShare', false);
});

test.beforeEach(() => {
  repos.setAccountEnabled(acc.id, true);
  repos.clearSlowMailState(acc.id);
  repos.clearBurstState(acc.id);
});

test('a session sends until maxSends, floors at duration+5s and preempts the daily plan', async () => {
  const c = clockFrom(START);
  const day = new Date(START).toLocaleDateString('sv-SE');
  repos.saveBurstState(acc.id, dailyState(day, [
    { startAt: START + 60 * 1000, nextAt: START + 60 * 1000 },
    { startAt: START + 3 * 60 * 60 * 1000, nextAt: START + 3 * 60 * 60 * 1000 },
  ]));

  const state = makeState();
  const sends = [];
  const send = async () => {
    sends.push(c.get());
    c.advance(2000);
    return { ok: true, title: '视频' + sends.length, durationMs: 42000 };
  };

  const out = await scheduler.runSlowMail(runtime(), state, {
    now: c.now, send, wait: c.wait, random: () => 0, retryDelayMs: 0,
  });

  const saved = repos.getSlowMailState(acc.id);
  assert.equal(out.ok, true);
  assert.equal(saved.status, 'done');
  assert.equal(saved.doneReason, 'max-sends');
  assert.equal(saved.sent, 3);
  assert.equal(sends.length, 3);
  assert.equal(sends[0], START);
  assert.equal(sends[1], START + 60000);
  assert.equal(sends[2], START + 120000);

  const events = eventsFor(saved.id).map((e) => e.event);
  assert.equal(events.filter((e) => e === 'slow-start').length, 1);
  assert.equal(events.filter((e) => e === 'slow-send').length, 3);
  assert.equal(events.filter((e) => e === 'slow-done').length, 1);

  const first = payloadsFor(saved.id, 'slow-send')[0];
  assert.equal(first.gapMs, 60000);
  assert.equal(first.floorMs, 47000);
  assert.equal(first.floored, false);

  const bs = repos.getBurstState(acc.id);
  assert.equal(bs.points[0].status, 'skipped');
  assert.equal(bs.points[0].lastError, 'slow-mail');
  assert.equal(bs.points[1].status, 'pending');
});

test('a captcha stops immediately without the 15s retry', async () => {
  const c = clockFrom(START);
  let calls = 0;
  const send = async () => {
    calls++;
    c.advance(2000);
    return { ok: false, error: 'captcha', code: 'captcha' };
  };
  const state = makeState({ maxSends: 5 });
  const out = await scheduler.runSlowMail(runtime(), state, {
    now: c.now, send, wait: c.wait, random: () => 0, retryDelayMs: 0,
  });
  const saved = repos.getSlowMailState(acc.id);
  assert.equal(out.ok, false);
  assert.equal(saved.status, 'blocked');
  assert.equal(calls, 1);
  assert.ok(eventsFor(saved.id).some((e) => e.event === 'slow-blocked'));
});

test('two dedup rounds end as exhausted', async () => {
  const c = clockFrom(START);
  let calls = 0;
  const send = async () => {
    calls++;
    c.advance(2000);
    return { ok: false, error: '候选都已发送过，暂无新视频', code: 'no-fresh-candidate' };
  };
  const state = makeState({ maxSends: 10 });
  await scheduler.runSlowMail(runtime(), state, {
    now: c.now, send, wait: c.wait, random: () => 0, retryDelayMs: 0,
  });
  const saved = repos.getSlowMailState(acc.id);
  assert.equal(saved.status, 'exhausted');
  assert.equal(saved.failed, 2);
  assert.equal(calls, 4); // one retry per round
  assert.ok(eventsFor(saved.id).some((e) => e.event === 'slow-exhausted'));
});

test('pausing the account freezes the window; resuming shifts endsAt and continues', async () => {
  const c = clockFrom(START);
  let calls = 0;
  const send = async () => {
    calls++;
    c.advance(2000);
    if (calls === 1) repos.setAccountEnabled(acc.id, false);
    return { ok: true, title: '视频' + calls, durationMs: 42000 };
  };
  const state = makeState({ maxSends: 2 });
  await scheduler.runSlowMail(runtime(), state, {
    now: c.now, send, wait: c.wait, random: () => 0, retryDelayMs: 0,
  });

  let saved = repos.getSlowMailState(acc.id);
  assert.equal(saved.status, 'paused');
  assert.equal(saved.sent, 1);
  const endsBefore = saved.endsAt;

  c.advance(5000);
  repos.setAccountEnabled(acc.id, true);
  await scheduler.runSlowMail(runtime(), saved, {
    now: c.now, send, wait: c.wait, random: () => 0, retryDelayMs: 0,
  });

  saved = repos.getSlowMailState(acc.id);
  assert.equal(saved.status, 'done');
  assert.equal(saved.sent, 2);
  assert.equal(saved.endsAt, endsBefore + 5000);
  assert.ok(eventsFor(saved.id).some((e) => e.event === 'slow-paused'));
  assert.ok(eventsFor(saved.id).some((e) => e.event === 'slow-resumed'));
});

test('a late restart redraws the gap instead of catching up', async () => {
  const c = clockFrom(START);
  const running = { ...slow.reconcile(makeState({ maxSends: 1 }), { nowMs: START }), nextAt: START - 600000, lastDurationMs: 42000 };
  repos.saveSlowMailState(acc.id, running);
  let sentAt = null;
  const send = async () => {
    sentAt = c.get();
    c.advance(2000);
    return { ok: true, title: '视频', durationMs: 42000 };
  };
  await scheduler.runSlowMail(runtime(), running, {
    now: c.now, send, wait: c.wait, random: () => 0, retryDelayMs: 0,
  });
  const saved = repos.getSlowMailState(acc.id);
  assert.equal(saved.status, 'done');
  assert.equal(sentAt, START + 60000);
  const skip = eventsFor(saved.id).find((e) => e.event === 'slow-skip');
  assert.ok(skip);
  assert.equal(skip.data.reason, 'late-resume');
  assert.equal(skip.data.lateMin, 10);
});

test('a panel stop while waiting ends the session without sending', async () => {
  const c = clockFrom(START);
  const running = { ...slow.reconcile(makeState({ maxSends: 5 }), { nowMs: START }), nextAt: START + 60000 };
  repos.saveSlowMailState(acc.id, running);
  let waitCalls = 0;
  let calls = 0;
  const wait = async (ms) => {
    c.advance(ms);
    waitCalls++;
    if (waitCalls === 1) {
      const cur = repos.getSlowMailState(acc.id);
      repos.saveSlowMailState(acc.id, slow.stop(cur, c.get()));
    }
    return true;
  };
  const send = async () => { calls++; c.advance(2000); return { ok: true, title: '视频', durationMs: 42000 }; };
  await scheduler.runSlowMail(runtime(), running, {
    now: c.now, send, wait, random: () => 0, retryDelayMs: 0,
  });
  const saved = repos.getSlowMailState(acc.id);
  assert.equal(saved.status, 'stopped');
  assert.equal(calls, 0);
  assert.ok(eventsFor(saved.id).some((e) => e.event === 'slow-stop'));
});

test('runSchedule yields with slowPending while a session is live', async () => {
  const state = makeState();
  repos.saveSlowMailState(acc.id, state);
  const day = new Date(START).toLocaleDateString('sv-SE');
  const r = await scheduler.runSchedule(runtime(), day, { now: () => new Date(START) });
  assert.equal(r.slowPending, true);
  assert.equal(repos.countSendsByDay(day, acc.id), 0);
});

test('a renamed friend is resolved by UID and the state name is refreshed', async () => {
  const hime = repos.getFriendByName(acc.id, 'Hime');
  try {
    repos.updateFriendName(acc.id, hime.id, 'HimeNew');
    repos.setFriendUserid(acc.id, hime.id, '10001');

    const state = makeState({ maxSends: 1 });
    state.friend = 'HimeOld';
    state.friendUid = '10001';
    const c = clockFrom(START);
    let sentName = null;
    const send = async (cfg) => {
      sentName = cfg.friend;
      c.advance(2000);
      return { ok: true, title: '视频', durationMs: 42000 };
    };
    await scheduler.runSlowMail(runtime(), state, {
      now: c.now, send, wait: c.wait, random: () => 0, retryDelayMs: 0,
    });
    const saved = repos.getSlowMailState(acc.id);
    assert.equal(sentName, 'HimeNew');
    assert.equal(saved.friend, 'HimeNew');
    assert.equal(saved.friendUid, '10001');
    assert.equal(saved.status, 'done');
  } finally {
    repos.updateFriendName(acc.id, hime.id, 'Hime');
  }
});

test('after a successful API send the slow-mail marks the same conversation read', async () => {
  const c = clockFrom(START);
  const state = makeState({ maxSends: 1 });
  const reads = [];
  const send = async () => {
    c.advance(2000);
    return {
      ok: true, api: true, title: '视频', durationMs: 5000,
      conversationId: '0:1:1001:2002', conversationShortId: '1234567890123456789',
    };
  };
  const read = async (session, opts) => {
    reads.push(opts);
    return { ok: true, status: 200 };
  };
  const out = await scheduler.runSlowMail(runtime(), state, {
    now: c.now, send, read, wait: c.wait, random: () => 0, retryDelayMs: 0,
  });
  const saved = repos.getSlowMailState(acc.id);
  assert.equal(out.ok, true);
  assert.equal(saved.status, 'done');
  assert.equal(saved.doneReason, 'max-sends');
  assert.equal(saved.conversationId, '0:1:1001:2002');
  assert.equal(saved.conversationShortId, '1234567890123456789');
  assert.equal(reads.length, 1);
  assert.equal(reads[0].conversationId, '0:1:1001:2002');
  assert.equal(reads[0].conversationShortId, '1234567890123456789');
  assert.equal(saved.lastReadOk, true);
  assert.ok(eventsFor(saved.id).some((e) => e.event === 'slow-read'));

  const stateOff = makeState({ maxSends: 1, readEnabled: false });
  const offReads = [];
  await scheduler.runSlowMail(runtime(), stateOff, {
    now: c.now,
    send,
    read: async (session, opts) => { offReads.push(opts); return { ok: true }; },
    wait: c.wait, random: () => 0, retryDelayMs: 0,
  });
  assert.equal(offReads.length, 0);
});
