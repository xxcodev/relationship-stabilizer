// Random "daily total + bands" scheduler tests (pure, seeded RNG).
const test = require('node:test');
const assert = require('node:assert');
const planner = require('../src/planner');

// deterministic RNG so failures are reproducible
function seeded(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const BANDS = [
  { name: '早间', from: 9 * 60, to: 12 * 60 },
  { name: '晚间', from: 20 * 60, to: 23 * 60 },
];

test('planDayRandom returns exactly the requested count when capacity allows', () => {
  const p = planner.planDayRandom({ dailyTotal: 8, minGapMinutes: 5, bands: BANDS }, 0, seeded(2));
  assert.equal(p.count, 8);
  assert.equal(p.times.length, 8);
  assert.equal(p.allocation.reduce((a, b) => a + b.n, 0), 8);
  assert.ok(p.times.every((t) => BANDS.some((b) => t >= b.from && t < b.to)));
  for (let i = 1; i < p.times.length; i++) {
    assert.ok(p.times[i] - p.times[i - 1] >= 5, `gap ${p.times[i] - p.times[i - 1]}`);
  }
});

test('planDayRandom is deterministic for a fixed RNG seed', () => {
  const cfg = { dailyTotal: 6, minGapMinutes: 7, bands: BANDS };
  const a = planner.planDayRandom(cfg, 0, seeded(42));
  const b = planner.planDayRandom(cfg, 0, seeded(42));
  assert.deepEqual(a.times, b.times);
  assert.deepEqual(a.allocation, b.allocation);
});

test('planDayRandom reduces the count and reports when bands cannot hold it', () => {
  const p = planner.planDayRandom(
    { dailyTotal: 10, minGapMinutes: 10, bands: [{ name: '短', from: 540, to: 560 }] },
    0,
    seeded(3)
  );
  assert.ok(p.count <= 2);
  assert.ok(p.notes.some((n) => n.includes('容量不足')));
});

test('planDayRandom only schedules after a late start', () => {
  const p = planner.planDayRandom(
    { dailyTotal: 5, minGapMinutes: 5, bands: [{ name: '早', from: 540, to: 600 }] },
    590,
    seeded(4)
  );
  assert.ok(p.count <= 2);
  assert.ok(p.times.every((t) => t >= 590 && t < 600));
});

test('planDayRandom returns no times for total 0 or empty bands', () => {
  assert.equal(planner.planDayRandom({ dailyTotal: 0, bands: BANDS }, 0, seeded(5)).count, 0);
  assert.equal(planner.planDayRandom({ dailyTotal: 3, bands: [] }, 0, seeded(5)).count, 0);
});

test('mergeRandomBands merges overlapping and too-close bands', () => {
  const merged = planner.mergeRandomBands(
    [
      { name: 'a', from: 540, to: 600 },
      { name: 'b', from: 600, to: 660 },
      { name: 'c', from: 900, to: 960 },
    ],
    5
  );
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], { name: 'a', from: 540, to: 660 });
});

test('planRandomBand never returns duplicates or times outside the band', () => {
  const times = planner.planRandomBand({ from: 540, to: 600 }, 6, 5, seeded(6));
  assert.equal(times.length, 6);
  assert.equal(new Set(times).size, 6);
  assert.ok(times.every((t) => t >= 540 && t < 600));
});
