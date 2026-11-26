/**
 * @file Pure scheduling core. One unified list of trigger points; each point is either a
 * fixed HH:MM or a random moment inside an HH:MM–HH:MM range, and carries its own share count.
 *
 * When a point triggers, videos are shared one at a time: the gap is drawn in [minSec, maxSec]
 * and is never shorter than the previous video's duration. Progress lives in a per-day state so
 * a restart resumes instead of replaying. No IO here — the scheduler persists the state.
 */
const planner = require('./planner');

const MAX_POINTS = 12;
const DEFAULTS = {
  points: [{ mode: 'fixed', time: '12:00', count: 6 }],
  minSec: 10,
  maxSec: 50,
  floor: true,
  fallbackSec: 15,
};

// A trigger is a compact session: catching up hours later would look nothing like a person
// watching videos. Keep the catch-up small, per trigger.
const FIRST_START_GRACE_MS = 30 * 60 * 1000; // first share of a trigger: within 30 minutes
const RESUME_GRACE_MS = 10 * 60 * 1000; // later shares: within 10 minutes of nextAt
const MIN_GAP_MS = 250;

const STATUSES = ['pending', 'running', 'done', 'skipped', 'aborted'];

function intIn(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function boolOn(value, fallback = true) {
  if (value === undefined || value === null) return fallback;
  return !(value === false || value === 0 || value === '0' || value === 'false');
}

function clamp01(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(0.999999, Math.max(0, n)) : 0;
}

/**
 * One trigger point: `{mode:'fixed', time, count}` or `{mode:'random', from, to, count}`.
 * Returns null for an invalid point. A bare `{time,count}` (0.27 config) is a fixed point.
 */
function normalizePoint(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const count = intIn(raw.count, 1, 50, DEFAULTS.points[0].count);
  const random = raw.mode === 'random' || (raw.from != null && raw.to != null && raw.time == null);
  if (random) {
    const from = planner.toMin(raw.from);
    const to = planner.toMin(raw.to);
    if (from === null || to === null || from < 0 || to > 1439 || to <= from) return null;
    return { mode: 'random', from: planner.hm(from), to: planner.hm(to), count };
  }
  const time = planner.toMin(raw.time);
  if (time === null || time < 0 || time > 1439) return null;
  return { mode: 'fixed', time: planner.hm(time), count };
}

function pointKey(point) {
  return point && point.mode === 'random'
    ? `r:${point.from}-${point.to}`
    : `f:${point && point.time}`;
}

function pointStartMinute(point) {
  const value = point && point.mode === 'random' ? point.from : point && point.time;
  return planner.toMin(value) ?? Number.MAX_SAFE_INTEGER;
}

/** Validate, sort by start, drop duplicates and cap the list. */
function normalizePoints(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const byKey = new Map();
  for (const item of list) {
    const point = normalizePoint(item);
    if (!point) continue;
    const key = pointKey(point);
    if (!byKey.has(key)) byKey.set(key, point);
  }
  return [...byKey.values()]
    .sort((a, b) => pointStartMinute(a) - pointStartMinute(b))
    .slice(0, MAX_POINTS);
}

// Split a daily total across legacy bands in proportion to their duration.
function allocateByDuration(bands, total) {
  const target = Math.max(0, Math.min(200, Math.round(Number(total) || 0)));
  const base = bands.map(() => (target >= bands.length ? 1 : 0));
  const remaining = target - base.reduce((a, b) => a + b, 0);
  if (remaining <= 0) return base;
  const weights = bands.map((b) => Math.max(1, b.to - b.from));
  const sum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((w) => (w / sum) * remaining);
  const counts = exact.map((v) => Math.floor(v));
  let used = counts.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; used < remaining && k < remaining * 2; k++) {
    counts[order[k % order.length].i] += 1;
    used++;
  }
  return bands.map((_, i) => base[i] + counts[i]);
}

/**
 * Convert settings written by 0.27 and earlier into the unified trigger list:
 * burst points -> fixed points; manual bands -> random points with the band count;
 * random bands + dailyTotal -> random points with the total split by band duration.
 */
function pointsFromLegacy({ burstPoints, burstStart, burstCount, bands, dailyTotal, mode } = {}) {
  const stored = normalizePoints(
    (Array.isArray(burstPoints) ? burstPoints : []).map((p) => ({ ...p, mode: 'fixed' }))
  );
  if (stored.length) return stored;

  const start = planner.toMin(burstStart);
  if (start !== null) {
    return [{ mode: 'fixed', time: planner.hm(start), count: intIn(burstCount, 1, 50, DEFAULTS.points[0].count) }];
  }

  const usable = (Array.isArray(bands) ? bands : [])
    .map((b) => ({
      from: Number(b && b.start_min),
      to: Number(b && b.end_min),
      min: Number(b && b.min_count) || 0,
    }))
    .filter((b) => b.from >= 0 && b.to > b.from && b.to <= 1440);
  if (!usable.length) return DEFAULTS.points.map((p) => ({ ...p }));

  const counts = mode === 'manual'
    ? usable.map((b) => Math.min(50, Math.max(0, b.min)))
    : allocateByDuration(usable, dailyTotal);
  const points = usable
    .map((b, i) => ({
      mode: 'random',
      from: planner.hm(b.from),
      to: planner.hm(b.to),
      count: Math.max(0, Math.min(50, counts[i] || 0)),
    }))
    .filter((p) => p.count > 0);
  return points.length ? points : DEFAULTS.points.map((p) => ({ ...p }));
}

/**
 * Clamp a raw schedule config. `points` wins; a legacy single `start`/`count` is accepted for
 * databases written by 0.26, and a missing/empty list falls back to the default trigger.
 */
function normalizeConfig(src = {}) {
  const raw = src && typeof src === 'object' ? src : {};
  let points = normalizePoints(raw.points);
  if (!points.length) {
    const start = planner.toMin(raw.start) ?? planner.toMin(DEFAULTS.points[0].time);
    points = [{ mode: 'fixed', time: planner.hm(start), count: intIn(raw.count, 1, 50, DEFAULTS.points[0].count) }];
  }
  const minSec = intIn(raw.minSec, 1, 600, DEFAULTS.minSec);
  return {
    points,
    pointCount: points.length,
    totalCount: points.reduce((n, p) => n + p.count, 0),
    minSec,
    maxSec: intIn(raw.maxSec, minSec, 600, Math.max(minSec, DEFAULTS.maxSec)),
    floor: boolOn(raw.floor, DEFAULTS.floor),
    fallbackSec: intIn(raw.fallbackSec, 0, 600, DEFAULTS.fallbackSec),
  };
}

/** Local epoch ms of a fixed time on `day` ('YYYY-MM-DD'). */
function startAt(day, timeHm) {
  const minute = planner.toMin(timeHm);
  const parts = String(day || '').split('-').map(Number);
  if (minute === null || minute < 0 || minute > 1439 || parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return new Date(parts[0], parts[1] - 1, parts[2], Math.floor(minute / 60), minute % 60, 0, 0).getTime();
}

/** The actual moment a trigger fires: the fixed time, or a random second inside the range. */
function resolveTriggerAt(day, point, random = Math.random) {
  if (!point || point.mode !== 'random') return startAt(day, point && point.time);
  const from = startAt(day, point.from);
  const to = startAt(day, point.to);
  if (from === null || to === null) return null;
  return from + Math.round(clamp01(random()) * Math.max(0, to - from));
}

/** Earliest possible moment of a trigger (used by the reset button). */
function earliestTriggerAt(day, point) {
  if (point && point.mode === 'random') return startAt(day, point.from);
  return startAt(day, point && point.time);
}

function fingerprint(burst) {
  const b = burst || {};
  const points = Array.isArray(b.points) ? b.points : [];
  const list = points
    .map((p) => (p.mode === 'random' ? `r:${p.from}-${p.to}x${p.count}` : `f:${p.time}x${p.count}`))
    .join(',');
  return [list, b.minSec, b.maxSec, b.floor ? 1 : 0, b.fallbackSec].join('|');
}

/**
 * Gap before the next share:
 * - draw uniformly in [minSec, maxSec];
 * - when the floor is on, never shorter than the previous video's duration;
 * - an unknown duration falls back to `fallbackSec` (0 disables the floor for that round).
 * `floored` tells the caller the video length overrode the configured range (for logs/UI).
 */
function gapMs({ minSec = DEFAULTS.minSec, maxSec = DEFAULTS.maxSec, fallbackSec = DEFAULTS.fallbackSec, floor = true, prevDurationMs = 0, random = Math.random } = {}) {
  const lo = Math.max(1, Math.round(Number(minSec) || DEFAULTS.minSec));
  const hi = Math.max(lo, Math.round(Number(maxSec) || lo));
  const pick = clamp01(random());
  const baseMs = Math.round((lo + pick * (hi - lo)) * 1000);
  const measured = Math.max(0, Math.round(Number(prevDurationMs) || 0));
  const referenceMs = measured > 0 ? measured : Math.round(Math.max(0, Number(fallbackSec) || 0) * 1000);
  const applied = floor ? Math.max(baseMs, referenceMs) : baseMs;
  return {
    gapMs: Math.max(MIN_GAP_MS, applied),
    baseMs,
    referenceMs,
    durationMs: measured,
    floored: !!floor && referenceMs > baseMs,
  };
}

// Derived fields: active = first unsettled trigger (points.length when the day is over).
function settleState(state) {
  const points = Array.isArray(state.points) ? state.points : [];
  const active = points.findIndex((p) => p && (p.status === 'pending' || p.status === 'running'));
  state.active = active < 0 ? points.length : active;
  state.sent = points.reduce((n, p) => n + (Number(p && p.sent) || 0), 0);
  if (state.active >= points.length) state.status = 'done';
  else if (state.sent > 0) state.status = 'running';
  else state.status = 'pending';
  return state;
}

function freshPoint(day, cfgPoint, random) {
  const at = resolveTriggerAt(day, cfgPoint, random);
  return {
    mode: cfgPoint.mode,
    time: cfgPoint.time,
    from: cfgPoint.from,
    to: cfgPoint.to,
    count: cfgPoint.count,
    sent: 0,
    status: 'pending',
    startAt: at,
    nextAt: at,
    lastAt: null,
    lastDurationMs: 0,
    lastTitle: '',
    lastError: '',
  };
}

/** Fresh day state: every configured trigger waiting for its moment. */
function freshState({ day, burst, nowMs, random = Math.random }) {
  return settleState({
    day,
    mode: 'schedule',
    configKey: fingerprint(burst),
    points: burst.points.map((p) => freshPoint(day, p, random)),
    active: 0,
    status: 'pending',
    sent: 0,
    lastAt: null,
    lastDurationMs: 0,
    lastTitle: '',
    lastError: '',
    updatedAt: new Date(nowMs).toISOString(),
  });
}

/** Explicit "重新开始今天": clear the day; if the first trigger already started, start it now. */
function resetPlan({ day, burst, nowMs, random = Math.random }) {
  const state = freshState({ day, burst, nowMs, random });
  const first = state.points[0];
  const earliest = first ? earliestTriggerAt(day, first) : null;
  if (first && earliest !== null && nowMs >= earliest) {
    first.startAt = nowMs;
    first.nextAt = nowMs;
  }
  return state;
}

/**
 * 0.26 stored a flat single-point state ({start, count, sent, nextAt, status}) with no
 * `points` list. Converting it keeps the day's progress instead of resetting to a fresh plan,
 * which would replay a finished schedule.
 */
function migrateLegacyState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state.points)) return state;
  if (state.mode !== 'burst' && state.mode !== 'schedule') return state;
  if (!state.day) return state;
  const time = typeof state.start === 'string' ? state.start : null;
  if (!time) return state;
  const sent = Math.max(0, Math.round(Number(state.sent) || 0));
  const count = Math.max(1, Math.round(Number(state.count) || 1));
  const oldStatus = String(state.status || 'pending');
  let status = 'pending';
  if (oldStatus === 'done') status = 'done';
  else if (oldStatus === 'skipped') status = 'skipped';
  else if (oldStatus === 'aborted') status = 'aborted';
  else if (sent > 0) status = 'running';
  const point = {
    mode: 'fixed',
    time,
    count,
    sent,
    status,
    startAt: Number(state.startAt) > 0 ? Number(state.startAt) : null,
    nextAt: Number(state.nextAt) > 0 ? Number(state.nextAt) : null,
    lastAt: state.lastAt == null ? null : Number(state.lastAt),
    lastDurationMs: Math.max(0, Math.round(Number(state.lastDurationMs) || 0)),
    lastTitle: String(state.lastTitle || ''),
    lastError: String(state.lastError || ''),
  };
  return {
    day: state.day,
    mode: 'schedule',
    configKey: '',
    points: [point],
    active: 0,
    status: 'pending',
    sent,
    lastAt: point.lastAt,
    lastDurationMs: point.lastDurationMs,
    lastTitle: point.lastTitle,
    lastError: point.lastError,
    updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : new Date(0).toISOString(),
  };
}

function samePoints(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch (e) {
    return false;
  }
}

/**
 * Merge stored state with the current config.
 * - new day / missing state / old flat state -> fresh plan
 * - triggers match by fixed time or random range, so interval/count edits keep progress
 * - a random trigger keeps the moment chosen earlier today; only new triggers roll again
 * - settled triggers (done/skipped/aborted) stay settled; the reset button replays the day
 * - when nothing changed the stored revision (updatedAt) is preserved so the scheduler can
 *   detect an external reset
 */
function reconcileState(state, { day, burst, nowMs, random = Math.random }) {
  state = migrateLegacyState(state);
  if (!state || typeof state !== 'object' || state.day !== day || !Array.isArray(state.points)) {
    return freshState({ day, burst, nowMs, random });
  }
  const key = fingerprint(burst);
  const rekeyed = state.configKey !== key;
  const byKey = new Map();
  for (const point of state.points) {
    if (!point || typeof point !== 'object') continue;
    const pointKeyValue = point.mode === 'random' && point.from && point.to
      ? `r:${point.from}-${point.to}`
      : `f:${point.time}`;
    if (!byKey.has(pointKeyValue)) byKey.set(pointKeyValue, point);
  }
  const points = burst.points.map((cfgPoint) => {
    const prev = byKey.get(pointKey(cfgPoint));
    if (!prev) return freshPoint(day, cfgPoint, random);
    const sent = Math.max(0, Math.round(Number(prev.sent) || 0));
    const prevCount = Math.max(1, Math.round(Number(prev.count) || 0));
    const point = {
      ...prev,
      mode: cfgPoint.mode,
      time: cfgPoint.time,
      from: cfgPoint.from,
      to: cfgPoint.to,
      count: cfgPoint.count,
      sent,
      startAt: Number(prev.startAt) > 0 ? Number(prev.startAt) : resolveTriggerAt(day, cfgPoint, random),
      nextAt: Number(prev.nextAt) > 0 ? Number(prev.nextAt) : 0,
      lastDurationMs: Math.max(0, Math.round(Number(prev.lastDurationMs) || 0)),
      lastError: String(prev.lastError || ''),
    };
    // A finished trigger keeps the total that actually ran, even if the count was edited later.
    if (point.status === 'done') {
      point.count = Math.max(sent, prevCount);
      point.nextAt = null;
      return point;
    }
    if (sent >= point.count) {
      point.status = 'done';
      point.count = Math.max(sent, point.count);
      point.nextAt = null;
      return point;
    }
    // Missed or failed triggers are not replayed by a config edit; the reset button does that.
    if (point.status !== 'pending' && point.status !== 'running') {
      point.nextAt = null;
      return point;
    }
    if (point.status === 'pending' && sent === 0) {
      point.nextAt = point.startAt;
      return point;
    }
    point.status = 'running';
    if (rekeyed) {
      const gap = gapMs({
        minSec: burst.minSec, maxSec: burst.maxSec, floor: burst.floor,
        fallbackSec: burst.fallbackSec, prevDurationMs: point.lastDurationMs,
      });
      const anchor = Number(point.lastAt) > 0 ? Number(point.lastAt) : nowMs;
      point.nextAt = Math.max(Math.round(anchor + gap.gapMs), nowMs);
    }
    if (!(Number(point.nextAt) > 0)) point.nextAt = Math.max(point.startAt, nowMs);
    return point;
  });

  const next = { ...state, mode: 'schedule', configKey: key, points, updatedAt: new Date(nowMs).toISOString() };
  settleState(next);
  if (!rekeyed
    && samePoints(state.points, points)
    && state.active === next.active
    && state.status === next.status
    && state.sent === next.sent) {
    next.updatedAt = state.updatedAt;
  }
  return next;
}

/** Counts used by results, logs and the dashboard hint. */
function counts(state) {
  const points = state && Array.isArray(state.points) ? state.points : [];
  const total = points.reduce((n, p) => n + (Number(p && p.count) || 0), 0);
  const sent = points.reduce((n, p) => n + (Number(p && p.sent) || 0), 0);
  const statuses = points.reduce((acc, p) => {
    const status = p && STATUSES.includes(p.status) ? p.status : 'pending';
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  return {
    points: points.length,
    total,
    sent,
    done: statuses.done || 0,
    skipped: statuses.skipped || 0,
    aborted: statuses.aborted || 0,
    unsettled: (statuses.pending || 0) + (statuses.running || 0),
  };
}

// Accept either a raw config or an already normalized one.
function coerce(burst) {
  const b = burst && typeof burst === 'object' ? burst : {};
  return Array.isArray(b.points) ? b : normalizeConfig(b);
}

function triggerLabel(point) {
  if (!point) return '';
  return point.mode === 'random' ? `${point.from}–${point.to} 随机` : point.time;
}

/** Human readable one-liner shared by the dashboard preview, logs and the AI snapshot. */
function summary(burst) {
  const b = coerce(burst);
  const points = b.points.map((p) => `${triggerLabel(p)}×${p.count}`).join('、');
  const floor = b.floor ? '，且不短于上一条视频时长' : '';
  return `每天 ${b.points.length} 个触发点（${points}），间隔 ${b.minSec}–${b.maxSec} 秒${floor}`;
}

function addMinutesHm(timeHm, minutes) {
  const start = planner.toMin(timeHm);
  if (start === null) return '';
  const value = (start + Math.max(0, Math.round(Number(minutes) || 0))) % 1440;
  return planner.hm(value);
}

/** Rough duration per trigger, assuming the fallback length when the floor is on. */
function estimate(burst) {
  const b = coerce(burst);
  const avgSec = Math.round((b.minSec + b.maxSec) / 2);
  const perSec = Math.max(1, b.floor ? Math.max(avgSec, b.fallbackSec) : avgSec);
  const points = b.points.map((p) => {
    const minutes = Math.ceil((p.count * perSec) / 60);
    return {
      mode: p.mode,
      time: p.time,
      from: p.from,
      to: p.to,
      label: triggerLabel(p),
      count: p.count,
      minutes,
      // For a random trigger this is the latest possible end (range end + duration).
      end: addMinutesHm(p.mode === 'random' ? p.to : p.time, minutes),
    };
  });
  const totalCount = b.points.reduce((n, p) => n + p.count, 0);
  const totalMinutes = points.reduce((n, p) => n + p.minutes, 0);
  return { perSec, totalCount, totalMinutes, points };
}

module.exports = {
  DEFAULTS,
  MAX_POINTS,
  FIRST_START_GRACE_MS,
  RESUME_GRACE_MS,
  MIN_GAP_MS,
  STATUSES,
  normalizePoint,
  normalizePoints,
  pointsFromLegacy,
  normalizeConfig,
  startAt,
  resolveTriggerAt,
  earliestTriggerAt,
  fingerprint,
  gapMs,
  settleState,
  freshState,
  migrateLegacyState,
  resetPlan,
  reconcileState,
  counts,
  summary,
  estimate,
  triggerLabel,
  addMinutesHm,
};
