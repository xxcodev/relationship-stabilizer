// Pure schedule core: trigger points (fixed / random range), legacy migration, gap floor,
// and the per-day state machine.
const test = require('node:test');
const assert = require('node:assert');
const burst = require('../src/burst');

const DAY = '2026-11-25';
const at = (time) => burst.startAt(DAY, time);
function seeded(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test('normalizePoint understands fixed times and random ranges', () => {
  assert.deepEqual(burst.normalizePoint({ mode: 'fixed', time: '9:05', count: 3 }), { mode: 'fixed', time: '09:05', count: 3 });
  assert.deepEqual(burst.normalizePoint({ time: '21:00', count: 2 }), { mode: 'fixed', time: '21:00', count: 2 });
  assert.deepEqual(burst.normalizePoint({ mode: 'random', from: '12:00', to: '14:00', count: 2 }), { mode: 'random', from: '12:00', to: '14:00', count: 2 });
  assert.equal(burst.normalizePoint({ mode: 'random', from: '14:00', to: '14:00', count: 2 }), null);
  assert.equal(burst.normalizePoint({ mode: 'fixed', time: '25:00', count: 2 }), null);
});

test('normalizePoints sorts, de-duplicates and caps the list', () => {
  const points = burst.normalizePoints([
    { mode: 'random', from: '21:00', to: '22:00', count: 2 },
    { time: '9:05', count: 3 },
    { time: '09:05', count: 9 },
    { mode: 'random', from: '07:00', to: '08:00', count: 1 },
  ]);
  assert.deepEqual(points.map((p) => p.mode + ':' + (p.mode === 'random' ? `${p.from}-${p.to}` : p.time)), [
    'random:07:00-08:00',
    'fixed:09:05',
    'random:21:00-22:00',
  ]);
  assert.equal(points[1].count, 3);
  const many = Array.from({ length: 20 }, (_, i) => ({ mode: 'fixed', time: `0${Math.floor(i / 6) + 1}:0${i % 6}`, count: 1 }));
  assert.equal(burst.normalizePoints(many).length, burst.MAX_POINTS);
});

test('pointsFromLegacy converts burst points, start/count and old bands', () => {
  assert.deepEqual(
    burst.pointsFromLegacy({ burstPoints: [{ time: '09:00', count: 2 }] }),
    [{ mode: 'fixed', time: '09:00', count: 2 }]
  );
  assert.deepEqual(
    burst.pointsFromLegacy({ burstStart: '12:34', burstCount: 4 }),
    [{ mode: 'fixed', time: '12:34', count: 4 }]
  );
  assert.deepEqual(
    burst.pointsFromLegacy({
      mode: 'manual',
      bands: [{ start_min: 540, end_min: 600, min_count: 2, max_count: 3 }],
    }),
    [{ mode: 'random', from: '09:00', to: '10:00', count: 2 }]
  );
  const spread = burst.pointsFromLegacy({
    mode: 'random',
    dailyTotal: 7,
    bands: [
      { start_min: 540, end_min: 600, min_count: 1, max_count: 3 },
      { start_min: 1200, end_min: 1380, min_count: 1, max_count: 9 },
    ],
  });
  assert.equal(spread.length, 2);
  assert.equal(spread.reduce((n, p) => n + p.count, 0), 7);
  assert.ok(spread.every((p) => p.mode === 'random'));
});

test('normalizeConfig clamps ranges and fills defaults', () => {
  const b = burst.normalizeConfig({
    points: [{ mode: 'fixed', time: '09:00', count: 0 }, { mode: 'random', from: '12:00', to: '14:00', count: 2 }],
    minSec: 0, maxSec: 5, floor: 'false', fallbackSec: 9999,
  });
  assert.equal(b.points[0].count, 1);
  assert.equal(b.pointCount, 2);
  assert.equal(b.totalCount, 3);
  assert.equal(b.minSec, 1);
  assert.equal(b.maxSec, 5);
  assert.equal(b.floor, false);
  assert.equal(b.fallbackSec, 600);

  const d = burst.normalizeConfig({});
  assert.deepEqual(d.points, [{ mode: 'fixed', time: '12:00', count: 6 }]);
  assert.equal(d.minSec, 10);
  assert.equal(d.maxSec, 50);
  assert.equal(d.floor, true);
  assert.equal(d.fallbackSec, 15);

  assert.equal(burst.normalizeConfig({ minSec: 40, maxSec: 10 }).maxSec, 40);
});

test('resolveTriggerAt keeps fixed times and picks a random second inside the range', () => {
  const fixed = { mode: 'fixed', time: '12:34', count: 1 };
  assert.equal(burst.resolveTriggerAt(DAY, fixed, () => 0.5), at('12:34'));

  const range = { mode: 'random', from: '12:00', to: '14:00', count: 1 };
  const low = burst.resolveTriggerAt(DAY, range, () => 0);
  const high = burst.resolveTriggerAt(DAY, range, () => 0.999999);
  assert.equal(low, at('12:00'));
  assert.ok(high > at('13:59') && high <= at('14:00'), `high=${high}`);
  assert.equal(burst.earliestTriggerAt(DAY, range), at('12:00'));
});

test('gapMs stays inside the range and never shorter than the previous video', () => {
  for (const r of [0, 0.25, 1]) {
    const g = burst.gapMs({ minSec: 10, maxSec: 50, prevDurationMs: 0, floor: false, random: () => r });
    assert.ok(g.gapMs >= 10000 && g.gapMs <= 50000, `gap ${g.gapMs}`);
  }
  const long = burst.gapMs({ minSec: 10, maxSec: 50, prevDurationMs: 42000, random: () => 0 });
  assert.equal(long.gapMs, 42000);
  assert.equal(long.floored, true);
  const short = burst.gapMs({ minSec: 10, maxSec: 50, prevDurationMs: 7000, random: () => 0 });
  assert.equal(short.gapMs, 10000);
  const fallback = burst.gapMs({ minSec: 10, maxSec: 20, prevDurationMs: 0, fallbackSec: 35, random: () => 0 });
  assert.equal(fallback.gapMs, 35000);
  const buffered = burst.gapMs({ minSec: 10, maxSec: 50, prevDurationMs: 42000, bufferSec: 5, random: () => 0 });
  assert.equal(buffered.gapMs, 47000);
  assert.equal(buffered.referenceMs, 47000);
  assert.equal(buffered.bufferMs, 5000);
  const bufferedFallback = burst.gapMs({ minSec: 10, maxSec: 20, prevDurationMs: 0, fallbackSec: 35, bufferSec: 5, random: () => 0 });
  assert.equal(bufferedFallback.gapMs, 40000);
});

test('freshState creates one trigger per point and resolves random times', () => {
  const plan = burst.normalizeConfig({
    points: [
      { mode: 'fixed', time: '09:00', count: 2 },
      { mode: 'random', from: '21:00', to: '22:00', count: 1 },
    ],
  });
  const state = burst.freshState({ day: DAY, burst: plan, nowMs: at('08:00'), random: seeded(3) });
  assert.equal(state.points.length, 2);
  assert.equal(state.points[0].mode, 'fixed');
  assert.equal(state.points[0].startAt, at('09:00'));
  assert.equal(state.points[1].mode, 'random');
  assert.ok(state.points[1].startAt >= at('21:00') && state.points[1].startAt <= at('22:00'));
  assert.equal(state.active, 0);
  assert.equal(state.status, 'pending');
});

test('settleState picks the first unsettled trigger and derives the day status', () => {
  const plan = burst.normalizeConfig({ points: [{ mode: 'fixed', time: '09:00', count: 1 }, { mode: 'fixed', time: '21:00', count: 1 }] });
  const state = burst.freshState({ day: DAY, burst: plan, nowMs: at('08:00') });
  state.points[0] = { ...state.points[0], sent: 1, status: 'done', nextAt: null };
  burst.settleState(state);
  assert.equal(state.active, 1);
  assert.equal(state.sent, 1);
  assert.equal(state.status, 'running');

  state.points[1] = { ...state.points[1], status: 'skipped', nextAt: null };
  burst.settleState(state);
  assert.equal(state.active, 2);
  assert.equal(state.status, 'done');
});

test('reconcileState keeps progress and the resolved random moment', () => {
  const plan = burst.normalizeConfig({ points: [{ mode: 'random', from: '09:00', to: '10:00', count: 2 }] });
  const state = burst.freshState({ day: DAY, burst: plan, nowMs: at('08:00'), random: seeded(7) });
  const resolved = state.points[0].startAt;
  state.points[0] = { ...state.points[0], sent: 1, status: 'running', lastAt: resolved, lastDurationMs: 12000, nextAt: resolved + 12000 };
  burst.settleState(state);

  const same = burst.reconcileState(state, { day: DAY, burst: plan, nowMs: at('09:30'), random: seeded(99) });
  assert.equal(same.points[0].startAt, resolved);
  assert.equal(same.points[0].sent, 1);
  assert.equal(same.updatedAt, state.updatedAt);

  const nextDay = burst.reconcileState(same, { day: '2026-11-26', burst: plan, nowMs: at('09:30') + 86400000, random: seeded(4) });
  assert.equal(nextDay.day, '2026-11-26');
  assert.equal(nextDay.points[0].sent, 0);
});

test('reconcileState adds/removes triggers and keeps the ones that remain', () => {
  const plan = burst.normalizeConfig({ points: [{ mode: 'fixed', time: '09:00', count: 1 }, { mode: 'fixed', time: '21:00', count: 1 }] });
  let state = burst.freshState({ day: DAY, burst: plan, nowMs: at('08:00') });
  state.points[0] = { ...state.points[0], sent: 1, status: 'done', nextAt: null };
  burst.settleState(state);

  const changed = burst.normalizeConfig({
    points: [
      { mode: 'fixed', time: '09:00', count: 1 },
      { mode: 'random', from: '18:00', to: '19:00', count: 2 },
    ],
  });
  const next = burst.reconcileState(state, { day: DAY, burst: changed, nowMs: at('10:00'), random: seeded(5) });
  assert.equal(next.points.length, 2);
  assert.equal(next.points[0].status, 'done');
  assert.equal(next.points[1].mode, 'random');
  assert.equal(next.points[1].status, 'pending');
  assert.ok(next.points[1].startAt >= at('18:00') && next.points[1].startAt <= at('19:00'));
  assert.equal(next.active, 1);
});

test('a finished trigger keeps its total when the count is edited afterwards', () => {
  const plan = burst.normalizeConfig({ points: [{ mode: 'fixed', time: '09:00', count: 2 }] });
  const state = burst.freshState({ day: DAY, burst: plan, nowMs: at('08:00') });
  state.points[0] = { ...state.points[0], sent: 2, status: 'done', nextAt: null };
  burst.settleState(state);

  const edited = burst.reconcileState(state, {
    day: DAY,
    burst: burst.normalizeConfig({ points: [{ mode: 'fixed', time: '09:00', count: 9 }] }),
    nowMs: at('10:00'),
  });
  assert.equal(edited.points[0].status, 'done');
  assert.equal(edited.points[0].sent, 2);
  assert.equal(edited.points[0].count, 2);
  assert.equal(edited.status, 'done');
});

test('missed or aborted triggers are not replayed by a config edit', () => {
  const plan = burst.normalizeConfig({ points: [{ mode: 'fixed', time: '09:00', count: 2 }] });
  const state = burst.freshState({ day: DAY, burst: plan, nowMs: at('08:00') });
  state.points[0] = { ...state.points[0], status: 'skipped', nextAt: null, lastError: 'late-start' };
  burst.settleState(state);

  const edited = burst.reconcileState(state, {
    day: DAY,
    burst: burst.normalizeConfig({ points: [{ mode: 'fixed', time: '09:00', count: 2 }], minSec: 5 }),
    nowMs: at('10:00'),
  });
  assert.equal(edited.points[0].status, 'skipped');
  assert.equal(edited.status, 'done');
});

test('resetPlan forces only the first trigger to start now when its time passed', () => {
  const plan = burst.normalizeConfig({
    points: [
      { mode: 'fixed', time: '09:00', count: 2 },
      { mode: 'random', from: '20:00', to: '21:00', count: 1 },
    ],
  });
  const now = at('15:00');
  const reset = burst.resetPlan({ day: DAY, burst: plan, nowMs: now, random: seeded(2) });
  assert.equal(reset.points[0].startAt, now);
  assert.equal(reset.points[0].nextAt, now);
  assert.ok(reset.points[1].startAt >= at('20:00'));

  const early = burst.resetPlan({ day: DAY, burst: plan, nowMs: at('07:00'), random: seeded(2) });
  assert.equal(early.points[0].startAt, at('09:00'));
});

test('a legacy flat single-point state is migrated instead of replayed', () => {
  const plan = burst.normalizeConfig({ points: [{ mode: 'fixed', time: '23:40', count: 6 }] });
  const legacy = {
    day: DAY, mode: 'burst', configKey: 'x', start: '23:40',
    startAt: at('23:40'), nextAt: at('23:41'), count: 6,
    sent: 6, status: 'done', lastAt: at('23:40'), lastDurationMs: 9000,
    lastTitle: 'x', lastError: '', updatedAt: '2026-11-25T15:49:15.000Z',
  };
  const next = burst.reconcileState(legacy, { day: DAY, burst: plan, nowMs: at('23:59') });
  assert.equal(next.points.length, 1);
  assert.equal(next.points[0].mode, 'fixed');
  assert.equal(next.points[0].status, 'done');
  assert.equal(next.points[0].sent, 6);
  assert.equal(next.status, 'done');
});

test('counts, summary and estimate describe every trigger', () => {
  const plan = burst.normalizeConfig({
    points: [
      { mode: 'fixed', time: '09:00', count: 6 },
      { mode: 'random', from: '21:00', to: '22:00', count: 2 },
    ],
    minSec: 10, maxSec: 50, floor: true, fallbackSec: 15,
  });
  const state = burst.freshState({ day: DAY, burst: plan, nowMs: at('08:00'), random: seeded(1) });
  state.points[0] = { ...state.points[0], sent: 2, status: 'done', nextAt: null };
  burst.settleState(state);
  assert.deepEqual(burst.counts(state), {
    points: 2, total: 8, sent: 2, done: 1, skipped: 0, aborted: 0, unsettled: 1,
  });

  assert.match(burst.summary(plan), /09:00×6/);
  assert.match(burst.summary(plan), /21:00–22:00 随机×2/);
  const est = burst.estimate(plan);
  assert.equal(est.totalCount, 8);
  assert.equal(est.points[0].end, '09:03');
  assert.equal(est.points[1].end, '22:01');
});
