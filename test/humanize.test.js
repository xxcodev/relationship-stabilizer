const test = require('node:test');
const assert = require('node:assert');
const { timing, browserLeadMs } = require('../src/humanize');

test('humanize timing stays bounded and leaves a gap safety buffer', () => {
  const min = timing({ jitterSeconds: 90, minGapMinutes: 5, random: () => 0 });
  assert.equal(min.jitterMs, 0);
  assert.equal(min.preSendMs, 1200);
  assert.equal(min.postSendMs, 1500);

  const mid = timing({ jitterSeconds: 90, minGapMinutes: 5, random: () => 0.5 });
  assert.ok(mid.jitterMs > 40000 && mid.jitterMs < 50000);
  assert.ok(mid.preSendMs >= 1200 && mid.preSendMs <= 4000);
  assert.ok(mid.postSendMs >= 1500 && mid.postSendMs <= 6000);
});

test('humanize timing never overlaps a short minimum gap', () => {
  const out = timing({ jitterSeconds: 90, minGapMinutes: 1, random: () => 0.99 });
  assert.equal(out.jitterMs, 0);
  const zero = timing({ jitterSeconds: 0, minGapMinutes: 5, random: () => 0.99 });
  assert.equal(zero.jitterMs, 0);
});

test('humanized browser lead is shorter than the old 3-minute lead', () => {
  const lead = browserLeadMs({ humanize: true, random: () => 0.5 });
  assert.ok(lead >= 45000 && lead <= 75000);
  assert.equal(browserLeadMs({ humanize: false }), 180000);
});
