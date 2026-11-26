/**
 * @file Pure helpers for video variety: recent-history filtering and uniform candidate selection.
 */
const DEFAULT_HISTORY_DAYS = 30;

function normalizeTitle(title) {
  return String(title == null ? '' : title).replace(/\s+/g, '').trim().toLowerCase();
}

/** Smallest supported search publish window covering maxAgeDays (1/7/30/180). */
function publishWindow(maxAgeDays) {
  const days = Number(maxAgeDays);
  if (!Number.isFinite(days) || days <= 0) return 0;
  if (days <= 1) return 1;
  if (days <= 7) return 7;
  if (days <= 30) return 30;
  return 180;
}

/**
 * Parse the relative publish time shown on a Douyin search card, e.g. "· 3天前",
 * "· 昨天", "· 2周前", "· 11-20". Returns age in days, or null when unknown.
 */
function parseAgeDays(text, now = new Date()) {
  const raw = String(text == null ? '' : text).replace(/\s+/g, ' ');
  const match = raw.match(/[·•]\s*(刚刚|今天|昨天|前天|\d+\s*(?:分钟|小时|天|周|个月|月)前|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}-\d{1,2}|\d{1,2}月\d{1,2}日)/)
    || raw.match(/^(刚刚|今天|昨天|前天|\d+\s*(?:分钟|小时|天|周|个月|月)前)$/);
  if (!match) return null;
  const value = match[1];
  if (value === '刚刚' || value === '今天') return 0;
  if (value === '昨天') return 1;
  if (value === '前天') return 2;
  const relative = value.match(/^(\d+)\s*(分钟|小时|天|周|个月|月)前$/);
  if (relative) {
    const n = Number(relative[1]);
    if (relative[2] === '分钟' || relative[2] === '小时') return 0;
    if (relative[2] === '周') return n * 7;
    if (relative[2] === '月' || relative[2] === '个月') return n * 30;
    return n;
  }
  const full = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const short = value.match(/^(\d{1,2})-(\d{1,2})$/);
  const cn = value.match(/^(\d{1,2})月(\d{1,2})日$/);
  let year, month, day;
  if (full) { year = Number(full[1]); month = Number(full[2]); day = Number(full[3]); }
  else if (short) { year = now.getFullYear(); month = Number(short[1]); day = Number(short[2]); }
  else if (cn) { year = now.getFullYear(); month = Number(cn[1]); day = Number(cn[2]); }
  else return null;
  let date = new Date(year, month - 1, day, 23, 59, 59);
  if (date.getTime() > now.getTime() + 86400000) date = new Date(year - 1, month - 1, day, 23, 59, 59);
  return Math.max(0, (now.getTime() - date.getTime()) / 86400000);
}

/**
 * Keep only candidates published within maxAgeDays. Undated candidates are dropped too:
 * a send that cannot prove the video is recent should wait for another candidate.
 */
function filterRecent(candidates = [], maxAgeDays = 7, { now = new Date() } = {}) {
  const list = (Array.isArray(candidates) ? candidates : []).filter(Boolean);
  if (!(maxAgeDays > 0)) return list;
  return list.filter((candidate) => {
    let age = Number(candidate.ageDays);
    if (!Number.isFinite(age)) {
      let ts = Number(candidate.createTime);
      if (Number.isFinite(ts) && ts > 0) {
        if (ts > 1e12) ts /= 1000;
        age = (now.getTime() / 1000 - ts) / 86400;
      }
    }
    return Number.isFinite(age) && age <= maxAgeDays;
  });
}

const METRIC_LABELS = { minLikes: '点赞', minComments: '评论', minFavorites: '收藏', minShares: '转发' };
const METRIC_KEYS = { likes: 'minLikes', comments: 'minComments', favorites: 'minFavorites', shares: 'minShares' };

/** Clamp interaction thresholds (0 = no limit) from config/form values. */
function normalizeMetricFilters(src = {}) {
  const clean = (value) => {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n > 0 ? Math.min(100000000, n) : 0;
  };
  const raw = src && typeof src === 'object' ? src : {};
  return {
    minLikes: clean(raw.minLikes ?? raw.filterMinLikes),
    minComments: clean(raw.minComments ?? raw.filterMinComments),
    minFavorites: clean(raw.minFavorites ?? raw.filterMinFavorites),
    minShares: clean(raw.minShares ?? raw.filterMinShares),
  };
}

/**
 * Per-metric switches. Explicit `likesEnabled`/`filterLikesEnabled` wins; without one the
 * threshold decides, which keeps old configs (threshold > 0 means enabled) working.
 */
function normalizeFilterSwitches(src = {}, thresholds = null) {
  const raw = src && typeof src === 'object' ? src : {};
  const f = thresholds || normalizeMetricFilters(raw);
  const read = (metric) => {
    const filterKey = 'filter' + metric[0].toUpperCase() + metric.slice(1) + 'Enabled';
    const value = raw[metric + 'Enabled'] !== undefined ? raw[metric + 'Enabled'] : raw[filterKey];
    if (value === undefined || value === null || value === '') return f[METRIC_KEYS[metric]] > 0;
    return !(value === false || value === 'false' || value === 0 || value === '0');
  };
  return {
    likes: read('likes'),
    comments: read('comments'),
    favorites: read('favorites'),
    shares: read('shares'),
  };
}

function activeMetricKeys(filters) {
  const f = normalizeMetricFilters(filters);
  const enabled = normalizeFilterSwitches(filters, f);
  return Object.keys(METRIC_KEYS).filter((metric) => enabled[metric] && f[METRIC_KEYS[metric]] > 0);
}

function metricFiltersActive(filters) {
  return activeMetricKeys(filters).length > 0;
}

/** Read one interaction metric from a candidate; null when the source did not provide it. */
function candidateMetric(candidate, key) {
  if (!candidate) return null;
  const raw = key === 'minLikes' ? candidate.likes
    : key === 'minComments' ? candidate.comments
      : key === 'minFavorites' ? candidate.collects
        : candidate.shares;
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** True when every enabled threshold is known and met (missing metrics fail a threshold). */
function passesMetrics(candidate, filters) {
  const f = normalizeMetricFilters(filters);
  const enabled = normalizeFilterSwitches(filters, f);
  for (const metric of Object.keys(METRIC_KEYS)) {
    if (!enabled[metric]) continue;
    const min = f[METRIC_KEYS[metric]];
    if (!min) continue;
    const value = candidateMetric(candidate, METRIC_KEYS[metric]);
    if (value === null || value < min) return false;
  }
  return true;
}

function filterMetrics(candidates, filters) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!metricFiltersActive(filters)) return list.slice();
  return list.filter((candidate) => passesMetrics(candidate, filters));
}

/** Human readable thresholds for logs and error messages; disabled rows are omitted. */
function describeMetricFilters(filters) {
  return activeMetricKeys(filters)
    .map((metric) => `${METRIC_LABELS[METRIC_KEYS[metric]]}≥${normalizeMetricFilters(filters)[METRIC_KEYS[metric]]}`)
    .join('、');
}

/** Turn recent send rows into sets of video ids / normalized titles to avoid. */
function buildHistory(rows = []) {
  const ids = new Set();
  const titles = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    if (row.video_id) ids.add(String(row.video_id));
    if (row.title) titles.add(normalizeTitle(row.title));
  }
  return { ids, titles };
}

/**
 * Choose one candidate uniformly from those not sent recently.
 * If every candidate is a repeat, fall back to the full list so a send can still happen.
 */
/** Remove candidates already sent (by video id or normalized title). */
function filterHistory(candidates = [], history = {}) {
  const list = (Array.isArray(candidates) ? candidates : []).filter(Boolean);
  const ids = history.ids instanceof Set ? history.ids : new Set((history.ids || []).map(String));
  const titles = history.titles instanceof Set
    ? history.titles
    : new Set((history.titles || []).map(normalizeTitle));
  return list.filter((candidate) => {
    const id = candidate.awemeId != null ? String(candidate.awemeId) : (candidate.videoId != null ? String(candidate.videoId) : '');
    if (id && ids.has(id)) return false;
    if (candidate.title && titles.has(normalizeTitle(candidate.title))) return false;
    return true;
  });
}

/**
 * Choose one candidate that is not in history. Returns null when every candidate was
 * already sent: callers must fail/skip instead of silently repeating a video.
 */
function chooseVideo(candidates = [], history = {}, random = Math.random) {
  const fresh = filterHistory(candidates, history);
  if (!fresh.length) return null;
  const r = Number(random());
  const index = Number.isFinite(r) ? Math.min(fresh.length - 1, Math.max(0, Math.floor(r * fresh.length))) : 0;
  return fresh[index];
}

module.exports = {
  DEFAULT_HISTORY_DAYS, normalizeTitle, buildHistory, parseAgeDays, publishWindow, filterRecent, filterHistory, chooseVideo,
  METRIC_LABELS, METRIC_KEYS, normalizeMetricFilters, normalizeFilterSwitches, metricFiltersActive, candidateMetric, passesMetrics, filterMetrics, describeMetricFilters,
};
