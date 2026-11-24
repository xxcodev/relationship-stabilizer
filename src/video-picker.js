/**
 * @file Pure helpers for video variety: recent-history filtering and uniform candidate selection.
 */
const DEFAULT_HISTORY_DAYS = 30;

function normalizeTitle(title) {
  return String(title == null ? '' : title).replace(/\s+/g, '').trim().toLowerCase();
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

module.exports = { DEFAULT_HISTORY_DAYS, normalizeTitle, buildHistory, chooseVideo };
