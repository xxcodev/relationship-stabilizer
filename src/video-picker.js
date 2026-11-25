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
function chooseVideo(candidates = [], history = {}, random = Math.random) {
  const list = (Array.isArray(candidates) ? candidates : []).filter(Boolean);
  if (!list.length) return null;
  const ids = history.ids instanceof Set ? history.ids : new Set((history.ids || []).map(String));
  const titles = history.titles instanceof Set
    ? history.titles
    : new Set((history.titles || []).map(normalizeTitle));
  const fresh = list.filter((candidate) => {
    const id = candidate.awemeId != null ? String(candidate.awemeId) : (candidate.videoId != null ? String(candidate.videoId) : '');
    if (id && ids.has(id)) return false;
    if (candidate.title && titles.has(normalizeTitle(candidate.title))) return false;
    return true;
  });
  const pool = fresh.length ? fresh : list;
  const r = Number(random());
  const index = Number.isFinite(r) ? Math.min(pool.length - 1, Math.max(0, Math.floor(r * pool.length))) : 0;
  return pool[index];
}

module.exports = { DEFAULT_HISTORY_DAYS, normalizeTitle, buildHistory, parseAgeDays, publishWindow, filterRecent, chooseVideo };
