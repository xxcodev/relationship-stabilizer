/**
 * @file Pure "slow mail" session core. One ad-hoc window (default 2h) sends a video every
 * random gap; the gap is never shorter than the previous video's duration + a 5s buffer.
 * The session ends by the clock (or a safety cap), survives scheduler restarts, and freezes
 * its countdown while the account is paused. No IO here — the scheduler persists the state.
 */
const burst = require('./burst');

const DEFAULTS = {
  durationMin: 120,
  minGapSec: 180,
  maxGapSec: 600,
  bufferSec: 5,
  fallbackSec: 30,
  maxSends: 60,
  friend: '',
  friendUid: '',
  readEnabled: true,
};

const LIMITS = {
  durationMin: [15, 480],
  minGapSec: [10, 3600],
  maxGapSec: [10, 3600],
  bufferSec: [0, 60],
  fallbackSec: [0, 300],
  maxSends: [1, 200],
};

// A restart/sleep should not replay the missed sends in a burst. More than two minutes late
// means "the rhythm was broken"; draw a fresh gap instead of catching up.
const LATE_MS = 2 * 60 * 1000;
// Pause freezes the countdown. A session paused for a whole day is a zombie; expire it.
const MAX_PAUSE_MS = 24 * 60 * 60 * 1000;
// After a failed round, wait at least this long before trying again (besides the user's min gap).
const FAILURE_BACKOFF_MS = 2 * 60 * 1000;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_CONSECUTIVE_NO_CANDIDATE = 2;

const LIVE_STATUSES = ['pending', 'running', 'paused'];
const TERMINAL_STATUSES = ['done', 'stopped', 'blocked', 'exhausted', 'expired'];

function intIn(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clamp01(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(0.999999, Math.max(0, n)) : 0;
}

function text(value, max = 300) {
  return String(value == null ? '' : value).slice(0, max);
}

function iso(nowMs) {
  return new Date(nowMs).toISOString();
}

/** Clamp a start config; every field is independent so a half-filled form still works. */
function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const durationMin = intIn(src.durationMin, LIMITS.durationMin[0], LIMITS.durationMin[1], DEFAULTS.durationMin);
  const minGapSec = intIn(src.minGapSec, LIMITS.minGapSec[0], LIMITS.minGapSec[1], DEFAULTS.minGapSec);
  const maxGapSec = intIn(src.maxGapSec, minGapSec, LIMITS.maxGapSec[1], Math.max(minGapSec, DEFAULTS.maxGapSec));
  return {
    durationMin,
    minGapSec,
    maxGapSec,
    bufferSec: intIn(src.bufferSec, LIMITS.bufferSec[0], LIMITS.bufferSec[1], DEFAULTS.bufferSec),
    fallbackSec: intIn(src.fallbackSec, LIMITS.fallbackSec[0], LIMITS.fallbackSec[1], DEFAULTS.fallbackSec),
    maxSends: intIn(src.maxSends, LIMITS.maxSends[0], LIMITS.maxSends[1], DEFAULTS.maxSends),
    friend: String(src.friend == null ? '' : src.friend).trim().slice(0, 80),
    friendUid: String(src.friendUid == null ? '' : src.friendUid).trim().slice(0, 80),
    readEnabled: !(src.readEnabled === false || src.readEnabled === 0 || src.readEnabled === '0' || src.readEnabled === 'false'),
  };
}

/** Draw the next gap; delegates to the shared burst floor logic with the 5s buffer. */
function gapMs({ minGapSec, maxGapSec, bufferSec, fallbackSec, prevDurationMs = 0, random = Math.random } = {}) {
  return burst.gapMs({
    minSec: minGapSec,
    maxSec: maxGapSec,
    fallbackSec,
    bufferSec,
    floor: true,
    prevDurationMs,
    random,
  });
}

/** Rough count for the start panel; the actual run depends on video durations and failures. */
function estimate(raw) {
  const cfg = normalizeConfig(raw);
  const windowSec = cfg.durationMin * 60;
  const low = Math.max(1, Math.floor(windowSec / Math.max(1, cfg.maxGapSec)));
  const high = Math.max(1, Math.floor(windowSec / Math.max(1, cfg.minGapSec)));
  const typical = Math.max(1, Math.round(windowSec / Math.max(1, (cfg.minGapSec + cfg.maxGapSec) / 2)));
  return {
    min: Math.min(cfg.maxSends, low),
    max: Math.min(cfg.maxSends, high),
    typical: Math.min(cfg.maxSends, typical),
    capped: high > cfg.maxSends,
    windowMin: cfg.durationMin,
  };
}

function newId(nowMs, random) {
  const d = new Date(nowMs);
  const stamp = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
    String(d.getHours()).padStart(2, '0'),
    String(d.getMinutes()).padStart(2, '0'),
  ].join('');
  const suffix = Math.floor(clamp01(random()) * 36 ** 4).toString(36).padStart(4, '0');
  return `sm-${stamp}-${suffix}`;
}

/**
 * Fresh pending session. The scheduler picks it up and moves it to running; the dashboard
 * writes only this shape.
 */
function createState({ cfg, nowMs, random = Math.random } = {}) {
  const config = normalizeConfig(cfg);
  if (!config.friend) throw new Error('慢递需要一位收件人');
  const start = Number(nowMs);
  if (!Number.isFinite(start)) throw new Error('慢递开始时间无效');
  return {
    v: 1,
    id: newId(start, random),
    account: text(cfg && cfg.account, 80),
    friend: config.friend,
    friendUid: config.friendUid,
    status: 'pending',
    startedAt: start,
    endsAt: start + config.durationMin * 60 * 1000,
    minGapSec: config.minGapSec,
    maxGapSec: config.maxGapSec,
    bufferSec: config.bufferSec,
    fallbackSec: config.fallbackSec,
    maxSends: config.maxSends,
    readEnabled: config.readEnabled !== false,
    sent: 0,
    failed: 0,
    nextAt: start,
    lastAt: null,
    lastDurationMs: 0,
    lastTitle: '',
    lastError: '',
    lastGap: null,
    conversationId: '',
    conversationShortId: '',
    lastReadAt: null,
    lastReadOk: null,
    readError: '',
    lastReadEventAt: 0,
    pausedAt: null,
    pausedMs: 0,
    consecutiveFailures: 0,
    consecutiveNoCandidate: 0,
    doneReason: '',
    updatedAt: iso(start),
  };
}

function isLive(state) {
  return !!state && LIVE_STATUSES.includes(state.status);
}

function isTerminal(state) {
  return !!state && TERMINAL_STATUSES.includes(state.status);
}

function isPaused(state) {
  return !!state && state.status === 'paused';
}

/** Remaining wall-clock time; paused sessions freeze at pausedAt. */
function remainingMs(state, nowMs = Date.now()) {
  if (!state || !isLive(state)) return 0;
  const anchor = state.status === 'paused' && state.pausedAt ? Number(state.pausedAt) : Number(nowMs);
  return Math.max(0, Number(state.endsAt) - anchor);
}

/** Milliseconds until the next send; 0 means now/overdue. */
function nextInMs(state, nowMs = Date.now()) {
  if (!state || !isLive(state) || state.status === 'paused') return 0;
  return Math.max(0, Number(state.nextAt || 0) - Number(nowMs));
}

function done(state, nowMs, reason, error = '') {
  return {
    ...state,
    status: reason === 'blocked' ? 'blocked' : reason === 'exhausted' ? 'exhausted' : reason === 'expired' ? 'expired' : 'done',
    doneReason: reason,
    lastError: error || state.lastError || '',
    nextAt: null,
    updatedAt: iso(nowMs),
  };
}

/** Pending -> running on pickup; running past the deadline -> done. No-op states are returned as-is. */
function reconcile(state, { nowMs = Date.now() } = {}) {
  if (!state || typeof state !== 'object') return state;
  const now = Number(nowMs);
  if (!Number.isFinite(now)) return state;
  if (isTerminal(state)) return state;
  if (state.status === 'paused') return state;
  if (state.status === 'pending') {
    if (now >= Number(state.endsAt)) return done(state, now, 'expired', '窗口已过，慢递还没开始');
    return { ...state, status: 'running', nextAt: now, updatedAt: iso(now) };
  }
  if (state.status !== 'running') return state;
  if (now >= Number(state.endsAt)) return done(state, now, 'window');
  if (!(Number(state.nextAt) > 0)) return { ...state, nextAt: now, updatedAt: iso(now) };
  return state;
}

/** Freeze the countdown while the account is paused. */
function pause(state, nowMs = Date.now()) {
  if (!state || !isLive(state) || state.status === 'paused') return state;
  return { ...state, status: 'paused', pausedAt: Number(nowMs), updatedAt: iso(nowMs) };
}

/** Resume and shift the deadline by the paused duration, so the user gets the full window. */
function resume(state, nowMs = Date.now()) {
  if (!state || state.status !== 'paused') return state;
  const now = Number(nowMs);
  const pausedAt = Number(state.pausedAt) || now;
  const elapsed = Math.max(0, now - pausedAt);
  if (elapsed > MAX_PAUSE_MS) return done(state, now, 'expired', '暂停超过 24 小时，慢递已结束');
  return {
    ...state,
    status: 'running',
    endsAt: Number(state.endsAt) + elapsed,
    pausedAt: null,
    pausedMs: Math.max(0, Number(state.pausedMs) || 0) + elapsed,
    nextAt: now + 1000,
    updatedAt: iso(now),
  };
}

/** User pressed "提前收束". The scheduler sees the newer revision and stops after the in-flight send. */
function stop(state, nowMs = Date.now()) {
  if (!state || !isLive(state)) return state;
  return {
    ...state,
    status: 'stopped',
    doneReason: 'stopped',
    nextAt: null,
    stoppedAt: Number(nowMs),
    updatedAt: iso(nowMs),
  };
}

function block(state, nowMs, error) {
  if (!state) return state;
  return done(state, nowMs, 'blocked', text(error));
}

function expire(state, nowMs, error = '') {
  if (!state) return state;
  return done(state, nowMs, 'expired', error);
}

function isLate(state, nowMs = Date.now()) {
  return !!state && state.status === 'running' && Number(state.nextAt) > 0 && Number(nowMs) > Number(state.nextAt) + LATE_MS;
}

/**
 * Successful send. `atMs` is when the send started (the floor is measured start-to-start,
 * like the existing burst); `nowMs` is when it finished, used to avoid back-to-back sends.
 */
function afterSend(state, { atMs, durationMs = 0, title = '', nowMs = Date.now(), random = Math.random } = {}) {
  if (!state) throw new Error('慢递状态缺失');
  const start = Number(atMs) || Number(nowMs);
  const finished = Number(nowMs);
  const measured = Math.max(0, Math.round(Number(durationMs) || 0));
  const sent = Math.max(0, Number(state.sent) || 0) + 1;
  const next = {
    ...state,
    sent,
    lastAt: start,
    lastDurationMs: measured,
    lastTitle: text(title, 200),
    lastError: '',
    consecutiveFailures: 0,
    consecutiveNoCandidate: 0,
  };
  const gap = gapMs({
    minGapSec: state.minGapSec,
    maxGapSec: state.maxGapSec,
    bufferSec: state.bufferSec,
    fallbackSec: state.fallbackSec,
    prevDurationMs: measured,
    random,
  });
  const nextAt = Math.max(start + gap.gapMs, finished + 1000);
  next.lastGap = {
    gapMs: gap.gapMs,
    baseMs: gap.baseMs,
    referenceMs: gap.referenceMs,
    floored: gap.floored,
  };
  if (sent >= Math.max(1, Number(state.maxSends) || 1)) {
    return { state: done(next, finished, 'max-sends'), gap, nextAt: null };
  }
  if (nextAt >= Number(state.endsAt)) {
    return { state: done(next, finished, 'window'), gap, nextAt: null };
  }
  return { state: { ...next, status: 'running', nextAt, updatedAt: iso(finished) }, gap, nextAt };
}

/**
 * Failed round after the one retry. `kind` is 'retry' (transient), 'exhausted' (no fresh
 * candidates) or 'blocked' (captcha/session/friend). Two no-candidate rounds or three
 * transient failures end the session; a transient failure waits at least two minutes.
 */
function afterFailure(state, { nowMs = Date.now(), kind = 'retry', error = '' } = {}) {
  if (!state) throw new Error('慢递状态缺失');
  const now = Number(nowMs);
  const message = text(error);
  if (kind === 'blocked') return block(state, now, message);
  if (kind === 'exhausted') {
    const streak = (Number(state.consecutiveNoCandidate) || 0) + 1;
    const next = {
      ...state,
      failed: (Number(state.failed) || 0) + 1,
      lastError: message,
      consecutiveFailures: 0,
      consecutiveNoCandidate: streak,
    };
    if (streak >= MAX_CONSECUTIVE_NO_CANDIDATE) return done(next, now, 'exhausted', message);
    return scheduleFailureRetry(next, now, message);
  }
  const streak = (Number(state.consecutiveFailures) || 0) + 1;
  const next = {
    ...state,
    failed: (Number(state.failed) || 0) + 1,
    lastError: message,
    consecutiveFailures: streak,
    consecutiveNoCandidate: 0,
  };
  if (streak >= MAX_CONSECUTIVE_FAILURES) return block(next, now, message || '连续发送失败');
  return scheduleFailureRetry(next, now, message);
}

function scheduleFailureRetry(state, nowMs, message) {
  const backoff = Math.max(FAILURE_BACKOFF_MS, (Number(state.minGapSec) || 60) * 1000);
  const nextAt = nowMs + backoff;
  if (nextAt >= Number(state.endsAt)) return done(state, nowMs, 'window', message);
  return {
    ...state,
    status: 'running',
    nextAt,
    updatedAt: iso(nowMs),
  };
}

/** After a restart/sleep, more than LATE_MS late means draw a fresh gap instead of catching up. */
function redrawNext(state, { nowMs = Date.now(), random = Math.random } = {}) {
  if (!state) return { state, gap: null, nextAt: null };
  const now = Number(nowMs);
  const gap = gapMs({
    minGapSec: state.minGapSec,
    maxGapSec: state.maxGapSec,
    bufferSec: state.bufferSec,
    fallbackSec: state.fallbackSec,
    prevDurationMs: state.lastDurationMs,
    random,
  });
  const nextAt = now + gap.gapMs;
  if (nextAt >= Number(state.endsAt)) {
    return { state: done(state, now, 'window'), gap, nextAt: null };
  }
  return { state: { ...state, status: 'running', nextAt, updatedAt: iso(now) }, gap, nextAt };
}

/** Human-readable one-liner for the dashboard / logs. */
function summary(state) {
  if (!state) return '还没有慢递';
  const parts = [`发给 ${state.friend}`, `${state.sent || 0}/${state.maxSends || 0} 条`];
  if (state.status === 'running') parts.push(`间隔 ${state.minGapSec}–${state.maxGapSec} 秒，不短于上条视频 +${state.bufferSec} 秒`);
  if (state.lastError) parts.push(state.lastError);
  return parts.join(' · ');
}

module.exports = {
  DEFAULTS,
  LIMITS,
  LATE_MS,
  MAX_PAUSE_MS,
  FAILURE_BACKOFF_MS,
  MAX_CONSECUTIVE_FAILURES,
  MAX_CONSECUTIVE_NO_CANDIDATE,
  LIVE_STATUSES,
  TERMINAL_STATUSES,
  normalizeConfig,
  gapMs,
  estimate,
  createState,
  isLive,
  isTerminal,
  isPaused,
  isLate,
  remainingMs,
  nextInMs,
  reconcile,
  pause,
  resume,
  stop,
  block,
  expire,
  afterSend,
  afterFailure,
  redrawNext,
  done,
  summary,
};
