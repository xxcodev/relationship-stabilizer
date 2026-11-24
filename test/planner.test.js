// Planner unit tests: pure functions, no DB, no browser.
const test = require('node:test');
const assert = require('node:assert');
const planner = require('../src/planner');

const cfg = planner.normalize({
  totalMin: 10,
  totalMax: 18,
  minGapMinutes: 5,
  bands: [
    { name: '早上', from: '07:00', to: '10:00', min: 1, max: 3 },
    { name: '中午', from: '12:00', to: '14:00', min: 1, max: 2 },
    { name: '晚上', from: '21:00', to: '23:30', min: 8, max: 13 },
  ],
});

test('window is derived from the bands', () => {
  assert.equal(cfg.windowStart, 7 * 60);
  assert.equal(cfg.windowEnd, 23 * 60 + 30);
});

test('totals stay inside the configured range', () => {
  for (let i = 0; i < 40; i++) {
    const p = planner.planDay(cfg, cfg.windowStart);
    assert.ok(p.count >= 10 && p.count <= 18, `count ${p.count} out of range`);
    assert.equal(p.allocation.reduce((a, b) => a + b.n, 0), p.count);
  }
});

test('every generated time falls inside its band', () => {
  const p = planner.planDay(cfg, cfg.windowStart);
  const sorted = [...p.times].sort((a, b) => a - b);
  for (const t of sorted) {
    const inSomeBand = cfg.bands.some((b) => t >= b.from && t < b.to);
    assert.ok(inSomeBand, `time ${planner.hm(t)} is outside every band`);
  }
});

test('band floors are always met', () => {
  const p = planner.planDay(cfg, cfg.windowStart);
  p.allocation.forEach((a, i) => {
    assert.ok(a.n >= cfg.bands[i].min, `${a.name} below floor`);
    assert.ok(a.n <= cfg.bands[i].max, `${a.name} above cap`);
  });
});

test('a total above the caps is expanded instead of refused', () => {
  const tight = planner.normalize({
    totalMin: 24,
    totalMax: 24,
    minGapMinutes: 5,
    bands: [
      { name: 'A', from: '08:00', to: '09:00', min: 1, max: 2 },
      { name: 'B', from: '10:00', to: '11:00', min: 1, max: 2 },
    ],
  });
  assert.ok(tight.adjustNotes.length > 0);
  const p = planner.planDay(tight, tight.windowStart);
  assert.equal(p.requested, 24);
  assert.equal(p.allocation.reduce((a, b) => a + b.n, 0), 24);
});

test('a total below the floors is shrunk', () => {
  const rich = planner.normalize({
    totalMin: 2,
    totalMax: 2,
    minGapMinutes: 5,
    bands: [
      { name: 'A', from: '08:00', to: '09:00', min: 8, max: 9 },
      { name: 'B', from: '10:00', to: '11:00', min: 8, max: 9 },
    ],
  });
  const p = planner.planDay(rich, rich.windowStart);
  assert.equal(p.allocation.reduce((a, b) => a + b.n, 0), 2);
});

test('two runs are not identical', () => {
  const a = planner.planDay(cfg, cfg.windowStart).times.join(',');
  const b = planner.planDay(cfg, cfg.windowStart).times.join(',');
  assert.notEqual(a, b);
});
