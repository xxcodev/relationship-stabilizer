/**
 * @file Human-like pacing helpers. Pure functions with an injectable random source.
 */
function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/**
 * Humanize one scheduled slot:
 * - jitter: wait up to N seconds after the planned minute, but leave a 2-minute safety
 *   buffer before the configured minimum gap so two sends cannot become synchronous;
 * - preSend: 1.2–4.0s pause after reaching the slot (like opening/reading before sharing);
 * - postSend: 1.5–6.0s pause after a successful send.
 */
function timing({ jitterSeconds = 90, minGapMinutes = 5, random = Math.random } = {}) {
  const rnd = typeof random === 'function' ? random : Math.random;
  const gapMs = Math.max(1, clamp(minGapMinutes, 1, 120)) * 60 * 1000;
  const requested = Math.max(0, clamp(jitterSeconds, 0, 300)) * 1000;
  const maxJitter = Math.min(requested, Math.max(0, gapMs - 2 * 60 * 1000));
  const jitterMs = maxJitter > 0 ? Math.floor(clamp(rnd(), 0, 1) * (maxJitter + 1)) : 0;
  const preSendMs = 1200 + Math.floor(clamp(rnd(), 0, 1) * 2801);
  const postSendMs = 1500 + Math.floor(clamp(rnd(), 0, 1) * 4501);
  return { jitterMs, preSendMs, postSendMs };
}

/** Browser opens shortly before the send instead of sitting open for 3 minutes. */
function browserLeadMs({ humanize = true, random = Math.random } = {}) {
  if (!humanize) return 180000;
  return 45000 + Math.floor(clamp(random(), 0, 1) * 30001);
}

module.exports = { timing, browserLeadMs, clamp };
