// Pure slow-mail session core: gap floor + buffer, window end, pause/resume, failure kinds.
const test = require('node:test');
const assert = require('node:assert');
const slow = require('../src/slow-mail');

const START = 1795686120000; // 2026-11-26 17:42 Asia/Shanghai
const START2 = 1795686120; // seconds, used to prove ms handling

function cfg(extra = {}) {
  return slow.normalizeConfig({
    durationMin: 120,
    minGapSec: 180,
    maxGapSec: 600,
    bufferSec: 5,
    fallbackSec: 30,
    maxSends: 60,
    friend: '小鹿',
    ...extra,
  });
}

function ready(extra = {}) {
  const state = slow.createState({ cfg: { ...cfg(), account: 'B', ...extra }, nowMs: START, random: () => 0 });
  return slow.reconcile(state, { nowMs: START });
}

test('normalizeConfig clamps every field and keeps a usable friend', () => {
  const out = slow.normalizeConfig({
    durationMin: 1,
    minGapSec: 1,
    maxGapSec: 0,
    bufferSec: 999,
    fallbackSec: -1,
    maxSends: 999,
    friend: '  小鹿  ',
  });
  assert.equal(out.durationMin, 15);
  assert.equal(out.minGapSec, 10);
  assert.equal(out.maxGapSec, 10);
  assert.equal(out.bufferSec, 60);
  assert.equal(out.fallbackSec, 0);
  assert.equal(out.maxSends, 200);
  assert.equal(out.friend, '小鹿');
  assert.equal(out.readEnabled, true);
  assert.equal(slow.normalizeConfig({ readEnabled: false }).readEnabled, false);
  assert.equal(slow.normalizeConfig({ readEnabled: '0' }).readEnabled, false);

  const wide = slow.normalizeConfig({ minGapSec: 900, maxGapSec: 300 });
  assert.equal(wide.minGapSec, 900);
  assert.equal(wide.maxGapSec, 900);
});

test('gapMs floors at the previous duration plus the 5s buffer', () => {
  const mini = slow.gapMs({ minGapSec: 180, maxGapSec: 600, bufferSec: 5, fallbackSec: 30, prevDurationMs: 0, random: () => 0 });
  assert.equal(mini.gapMs, 180000);
  assert.equal(mini.baseMs, 180000);
  assert.equal(mini.referenceMs, 35000);
  assert.equal(mini.floored, false);

  const short = slow.gapMs({ minGapSec: 180, maxGapSec: 600, bufferSec: 5, fallbackSec: 30, prevDurationMs: 42000, random: () => 1 });
  assert.equal(short.gapMs, 600000);
  assert.equal(short.floored, false);

  const long = slow.gapMs({ minGapSec: 180, maxGapSec: 600, bufferSec: 5, fallbackSec: 30, prevDurationMs: 720000, random: () => 0 });
  assert.equal(long.gapMs, 725000);
  assert.equal(long.referenceMs, 725000);
  assert.equal(long.floored, true);

  const tiny = slow.gapMs({ minGapSec: 10, maxGapSec: 20, bufferSec: 5, fallbackSec: 0, prevDurationMs: 42000, random: () => 0 });
  assert.equal(tiny.gapMs, 47000);
  assert.equal(tiny.floored, true);
});

test('estimate produces plausible ranges and respects the cap', () => {
  const normal = slow.estimate(cfg());
  assert.equal(normal.min, 12);
  assert.equal(normal.max, 40);
  assert.equal(normal.typical, 18);
  assert.equal(normal.capped, false);

  const dense = slow.estimate(cfg({ durationMin: 120, minGapSec: 60, maxGapSec: 180, maxSends: 60 }));
  assert.equal(dense.max, 60);
  assert.equal(dense.capped, true);

  const short = slow.estimate(cfg({ durationMin: 30, minGapSec: 300, maxGapSec: 900 }));
  assert.equal(short.min, 2);
  assert.equal(short.max, 6);
  assert.equal(short.typical, 3);
});

test('createState starts pending with the first send due immediately', () => {
  assert.throws(() => slow.createState({ cfg: cfg({ friend: '' }), nowMs: START }), /收件人/);
  const state = slow.createState({ cfg: { ...cfg(), account: 'B' }, nowMs: START, random: () => 0 });
  assert.equal(state.status, 'pending');
  assert.equal(state.startedAt, START);
  assert.equal(state.endsAt, START + 120 * 60 * 1000);
  assert.equal(state.nextAt, START);
  assert.equal(state.friend, '小鹿');
  assert.equal(state.friendUid, '');
  assert.match(state.id, /^sm-\d{12}-[0-9a-z]{4}$/);

  const withUid = slow.createState({ cfg: { ...cfg(), account: 'B', friendUid: '10001' }, nowMs: START, random: () => 0 });
  assert.equal(withUid.friendUid, '10001');

  const running = slow.reconcile(state, { nowMs: START });
  assert.equal(running.status, 'running');
  assert.equal(running.nextAt, START);
});

test('reconcile moves pending -> running and closes a stale window', () => {
  const state = slow.createState({ cfg: { ...cfg(), account: 'B' }, nowMs: START, random: () => 0 });
  const running = slow.reconcile(state, { nowMs: START + 5000 });
  assert.equal(running.status, 'running');
  assert.equal(running.nextAt, START + 5000);

  const expired = slow.reconcile(state, { nowMs: state.endsAt + 1 });
  assert.equal(expired.status, 'expired');

  const live = { ...running, sent: 1, nextAt: 0 };
  const fixed = slow.reconcile(live, { nowMs: START + 6000 });
  assert.equal(fixed.nextAt, START + 6000);

  const over = slow.reconcile({ ...running, endsAt: START + 5000 }, { nowMs: START + 5001 });
  assert.equal(over.status, 'done');
  assert.equal(over.doneReason, 'window');

  const terminal = slow.stop(running, START + 7000);
  assert.equal(slow.reconcile(terminal, { nowMs: START + 999999 }), terminal);
});

test('pause freezes the countdown and resume shifts the deadline', () => {
  const running = ready();
  const paused = slow.pause(running, START + 10000);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.pausedAt, START + 10000);
  assert.equal(slow.remainingMs(paused, START + 100000), running.endsAt - (START + 10000));

  const resumed = slow.resume(paused, START + 70000);
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.endsAt, running.endsAt + 60000);
  assert.equal(resumed.pausedMs, 60000);
  assert.equal(resumed.nextAt, START + 70000 + 1000);

  const tooLong = slow.resume(paused, START + 10000 + slow.MAX_PAUSE_MS + 1);
  assert.equal(tooLong.status, 'expired');

  const stopped = slow.stop(running, START + 8000);
  assert.equal(slow.pause(stopped, START + 9000), stopped);
  assert.equal(slow.stop(stopped, START + 9000), stopped);
});

test('afterSend computes the next gap and closes at the cap or window', () => {
  const running = ready();
  const first = slow.afterSend(running, { atMs: START, durationMs: 42000, title: '第一条', nowMs: START + 5000, random: () => 0 });
  assert.equal(first.state.sent, 1);
  assert.equal(first.state.status, 'running');
  assert.equal(first.state.lastTitle, '第一条');
  assert.equal(first.state.lastDurationMs, 42000);
  assert.equal(first.gap.gapMs, 180000);
  assert.equal(first.state.nextAt, START + 180000);

  const longVideo = slow.afterSend(running, { atMs: START, durationMs: 720000, nowMs: START + 5000, random: () => 0 });
  assert.equal(longVideo.gap.gapMs, 725000);
  assert.equal(longVideo.gap.floored, true);
  assert.equal(longVideo.state.nextAt, START + 725000);

  const slowSend = slow.afterSend(running, { atMs: START, durationMs: 42000, nowMs: START + 200000, random: () => 0 });
  assert.equal(slowSend.state.nextAt, START + 200000 + 1000);

  const capState = { ...running, maxSends: 1 };
  const capped = slow.afterSend(capState, { atMs: START, durationMs: 42000, nowMs: START + 5000 });
  assert.equal(capped.state.status, 'done');
  assert.equal(capped.state.doneReason, 'max-sends');
  assert.equal(capped.state.nextAt, null);

  const shortWindow = { ...running, endsAt: START + 100000 };
  const closed = slow.afterSend(shortWindow, { atMs: START, durationMs: 42000, nowMs: START + 5000, random: () => 0 });
  assert.equal(closed.state.status, 'done');
  assert.equal(closed.state.doneReason, 'window');
  assert.equal(closed.state.nextAt, null);
});

test('afterFailure distinguishes transient, exhausted and blocked failures', () => {
  const running = ready();

  const retry = slow.afterFailure(running, { nowMs: START + 10000, kind: 'retry', error: '网络超时' });
  assert.equal(retry.status, 'running');
  assert.equal(retry.failed, 1);
  assert.equal(retry.consecutiveFailures, 1);
  assert.equal(retry.nextAt, START + 10000 + 180000);

  const twice = slow.afterFailure(retry, { nowMs: START + 20000, kind: 'retry', error: '网络超时' });
  const thrice = slow.afterFailure(twice, { nowMs: START + 30000, kind: 'retry', error: '网络超时' });
  assert.equal(thrice.status, 'blocked');
  assert.equal(thrice.failed, 3);

  const noCand = slow.afterFailure(running, { nowMs: START + 10000, kind: 'exhausted', error: '候选都已发送过' });
  assert.equal(noCand.status, 'running');
  assert.equal(noCand.consecutiveNoCandidate, 1);
  const noCand2 = slow.afterFailure(noCand, { nowMs: START + 20000, kind: 'exhausted', error: '候选都已发送过' });
  assert.equal(noCand2.status, 'exhausted');
  assert.equal(noCand2.doneReason, 'exhausted');

  const blocked = slow.afterFailure(running, { nowMs: START + 10000, kind: 'blocked', error: 'captcha' });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.lastError, 'captcha');

  const nearEnd = slow.afterFailure({ ...running, endsAt: START + 10000 }, { nowMs: START + 5000, kind: 'retry', error: 'x' });
  assert.equal(nearEnd.status, 'done');
  assert.equal(nearEnd.doneReason, 'window');
});

test('afterSend resets failure streaks and redrawNext handles a late restart', () => {
  const running = ready();
  const failed = slow.afterFailure(running, { nowMs: START + 10000, kind: 'retry', error: 'x' });
  const ok = slow.afterSend(failed, { atMs: START + 15000, durationMs: 42000, nowMs: START + 20000, random: () => 0 });
  assert.equal(ok.state.consecutiveFailures, 0);
  assert.equal(ok.state.consecutiveNoCandidate, 0);

  const late = { ...ok.state, nextAt: START + 30000, lastDurationMs: 720000 };
  const redrawn = slow.redrawNext(late, { nowMs: START + 1000000, random: () => 0 });
  assert.equal(redrawn.state.status, 'running');
  assert.equal(redrawn.state.nextAt, START + 1000000 + 725000);
  assert.equal(redrawn.gap.floored, true);

  const past = slow.redrawNext({ ...late, endsAt: START + 1000000 }, { nowMs: START + 1000000, random: () => 0 });
  assert.equal(past.state.status, 'done');
  assert.equal(past.state.doneReason, 'window');
});

test('isLate only flags a running session more than two minutes behind', () => {
  const running = ready();
  const state = { ...running, nextAt: START + 60000 };
  assert.equal(slow.isLate(state, START + 60000 + slow.LATE_MS), false);
  assert.equal(slow.isLate(state, START + 60000 + slow.LATE_MS + 1), true);
  assert.equal(slow.isLate({ ...state, status: 'paused' }, START + 999999), false);
});

test('remainingMs and nextInMs stay sensible across states', () => {
  const running = ready();
  assert.equal(slow.remainingMs(running, START + 1000), running.endsAt - (START + 1000));
  assert.equal(slow.nextInMs({ ...running, nextAt: START + 5000 }, START), 5000);
  assert.equal(slow.nextInMs({ ...running, nextAt: START - 5000 }, START), 0);
  const paused = slow.pause(running, START + 1000);
  assert.equal(slow.nextInMs(paused, START + 5000), 0);
  const stopped = slow.stop(running, START + 1000);
  assert.equal(slow.remainingMs(stopped, START + 2000), 0);
});

// Guard against accidental seconds/ms confusion in the public surface.
test('state timestamps are epoch milliseconds', () => {
  const state = slow.createState({ cfg: { ...cfg(), account: 'B' }, nowMs: START2, random: () => 0 });
  assert.equal(state.startedAt, START2);
  assert.equal(state.endsAt, START2 + 7200000);
});
