/**
 * @file HTTP control panel: renders the UI and exposes the /api endpoints backed by SQLite.
 */
// Dashboard backed by SQLite. Same UI as the prototype, but every value comes from the DB.
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const env = require('./env');
const repos = require('./repos');
const burstPlanner = require('./burst');
const scheduleConfig = require('./schedule');
const { chooseKeyword } = require('./pools');
const service = require('./service');
const apiSession = require('./api-session');
const videoPicker = require('./video-picker');
const aiRanker = require('./ai/ranker');
const aiClient = require('./ai/client');
const aiAssistant = require('./ai/assistant');
const aiActions = require('./ai/actions');
const aiPools = require('./ai/pools');
const dbConfig = require('./db-config');

function settingOn(key, dflt = '1') {
  const value = repos.getSetting(key, dflt);
  return !(value === 0 || value === '0' || value === false);
}

const SHOTS_DIR = path.resolve(env.ROOT, process.env.SHOTS_DIR || path.join('data', 'shots'));

const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

const ACCOUNT_LABEL = process.env.ACCOUNT || null;
const activeLabel = () => repos.getSetting('activeAccount', ACCOUNT_LABEL);

function currentAccount() {
  const acc = repos.getAccount(activeLabel());
  if (!acc) throw new Error('no account configured — run `npm run migrate -- <legacyDir>` or `npm run init`');
  return acc;
}

// A config write must target the account the user was looking at, not "whatever is active
// when the request lands" (two tabs / slow requests used to write the wrong account).
function databaseRestartRequired() {
  try {
    return dbConfig.load().driver !== require('./db').dialect;
  } catch (e) {
    return false;
  }
}

function accountFromInput(input) {
  const label = input && typeof input === 'object' ? String(input.account || '').trim() : '';
  if (!label) return currentAccount();
  const acc = repos.getAccount(label);
  if (!acc) {
    const err = new Error(`账户不存在: ${label}`);
    err.statusCode = 404;
    throw err;
  }
  return acc;
}

function scheduleFromAccount(acc) {
  return scheduleConfig.fromAccount(acc);
}

const clockLabel = (ms) => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });
const mapTriggerStatus = (status) => {
  if (status === 'done') return 'done';
  if (status === 'skipped' || status === 'aborted') return 'failed';
  return 'pending';
};
const triggerKey = (point) => (point && point.mode === 'random'
  ? `r:${point.from}-${point.to}`
  : `f:${point && point.time}`);

function triggerText(point, statePoint) {
  if (point.mode !== 'random') return point.time;
  const at = statePoint ? Number(statePoint.startAt) : 0;
  return at > 0 ? clockLabel(at) : `${point.from}–${point.to}`;
}

// Today's schedule progress for the home page. Stale state from another day is ignored here;
// the scheduler replaces it with a fresh day state.
function scheduleRuntime(acc, day, plan, sends = []) {
  const state = repos.getBurstState(acc.id);
  const live = state && state.day === day && Array.isArray(state.points) ? state : null;
  const byKey = new Map();
  for (const p of live ? live.points : []) {
    if (!p) continue;
    const key = p.mode === 'random' && p.from && p.to ? `r:${p.from}-${p.to}` : `f:${p.time}`;
    if (!byKey.has(key)) byKey.set(key, p);
  }
  const points = plan.points.map((p) => {
    const sp = byKey.get(triggerKey(p)) || null;
    return {
      mode: p.mode,
      time: p.time,
      from: p.from,
      to: p.to,
      label: triggerText(p, sp),
      count: sp ? Math.max(1, Number(sp.count) || p.count) : p.count,
      sent: sp ? Math.max(0, Number(sp.sent) || 0) : 0,
      status: sp ? String(sp.status || 'pending') : 'pending',
      startAt: sp ? Number(sp.startAt) || null : null,
      nextAt: sp ? Number(sp.nextAt) || null : null,
    };
  });
  const total = points.reduce((n, p) => n + p.count, 0);
  const sent = points.reduce((n, p) => n + p.sent, 0);
  const status = live ? String(live.status || 'pending') : 'pending';
  const activeIndex = live
    ? Number(live.active)
    : points.findIndex((p) => p.status === 'pending' || p.status === 'running');
  const active = activeIndex >= 0 && activeIndex < points.length ? points[activeIndex] : null;
  const open = status === 'pending' || status === 'running';
  let nextAt = null;
  if (open && active) {
    if (active.status === 'running' && active.nextAt) nextAt = clockLabel(active.nextAt);
    else if (active.mode === 'fixed') nextAt = active.time;
    else if (active.startAt) nextAt = clockLabel(active.startAt);
    else nextAt = `${active.from}–${active.to}`;
  } else if (open) {
    const nowMs = Date.now();
    const upcoming = plan.points
      .map((p) => ({
        p,
        at: p.mode === 'fixed' ? burstPlanner.startAt(day, p.time) : burstPlanner.startAt(day, p.from),
      }))
      .filter((x) => x.at !== null && x.at >= nowMs)
      .sort((a, b) => a.at - b.at)[0];
    if (upcoming) nextAt = upcoming.p.mode === 'fixed' ? upcoming.p.time : `${upcoming.p.from}–${upcoming.p.to}`;
  }
  const timeline = points.map((p) => ({
    time: p.status === 'running' && p.nextAt ? clockLabel(p.nextAt) : p.label,
    status: mapTriggerStatus(p.status),
  }));
  return {
    points,
    pointCount: points.length,
    count: total,
    sent,
    status,
    active: activeIndex,
    nextAt,
    minSec: plan.minSec,
    maxSec: plan.maxSec,
    floor: plan.floor,
    fallbackSec: plan.fallbackSec,
    lastDurationMs: live ? Math.max(0, Math.round(Number(live.lastDurationMs) || 0)) : 0,
    lastTitle: live ? String(live.lastTitle || '') : '',
    lastError: live ? String(live.lastError || '') : '',
    timeline,
  };
}

// Clear today's progress. If the first trigger's earliest moment already passed, it starts now
// instead of being skipped as late; later triggers keep their configured/resolved moments.
function resetSchedule(acc) {
  const plan = scheduleFromAccount(acc);
  const day = today();
  const now = Date.now();
  const next = burstPlanner.resetPlan({ day, burst: plan, nowMs: now });
  repos.saveBurstState(acc.id, next);
  const first = plan.points[0];
  const earliest = first ? burstPlanner.earliestTriggerAt(day, first) : null;
  return { forceNow: earliest !== null && now >= earliest, plan, day };
}

function configFromDb(acc = currentAccount()) {
  const plan = scheduleFromAccount(acc);
  const pools = {};
  for (const p of repos.listAccountPools(acc.id)) pools[p.name] = !!p.enabled;
  const sendMode = repos.getAccountSetting(acc.id, 'sendMode', 'auto');
  const videoSource = repos.getAccountSetting(acc.id, 'videoSource', 'pool');
  const metricFilters = videoPicker.normalizeMetricFilters({
    minLikes: repos.getAccountSetting(acc.id, 'filterMinLikes', 0),
    minComments: repos.getAccountSetting(acc.id, 'filterMinComments', 0),
    minFavorites: repos.getAccountSetting(acc.id, 'filterMinFavorites', 0),
    minShares: repos.getAccountSetting(acc.id, 'filterMinShares', 0),
  });
  const metricSwitches = videoPicker.normalizeFilterSwitches({
    likesEnabled: repos.getAccountSetting(acc.id, 'filterLikesEnabled', null),
    commentsEnabled: repos.getAccountSetting(acc.id, 'filterCommentsEnabled', null),
    favoritesEnabled: repos.getAccountSetting(acc.id, 'filterFavoritesEnabled', null),
    sharesEnabled: repos.getAccountSetting(acc.id, 'filterSharesEnabled', null),
  }, metricFilters);
  return {
    account: acc.label,
    accountName: acc.display_name || acc.label,
    enabled: !!acc.enabled,
    friend: repos.listEnabledFriendNames(acc.id)[0] || acc.friend,
    schedulePoints: plan.points,
    scheduleTotal: plan.totalCount,
    burstMinSec: plan.minSec,
    burstMaxSec: plan.maxSec,
    burstDurationFloor: plan.floor,
    burstFallbackSec: plan.fallbackSec,
    scheduleState: repos.getBurstState(acc.id),
    poolDelayMs: repos.getAccountSetting(acc.id, 'poolDelayMs', 2500),
    maxVideoAgeDays: Number(repos.getAccountSetting(acc.id, 'maxVideoAgeDays', 7)),
    recommendMaxAgeDays: Number(repos.getAccountSetting(acc.id, 'recommendMaxAgeDays', 30)),
    naturalShare: (() => { const v = repos.getAccountSetting(acc.id, 'naturalShare', false); return v === true || v === 1 || v === '1' || v === 'true'; })(),
    naturalText: (() => { const v = repos.getAccountSetting(acc.id, 'naturalText', true); return !(v === false || v === 0 || v === '0' || v === 'false'); })(),
    sendMode: sendMode === 'browser' ? 'browser' : 'auto',
    videoSource: videoSource === 'recommend' ? 'recommend' : 'pool',
    aiMode: repos.getAccountSetting(acc.id, 'aiMode', 'off'),
    filterAgeEnabled: !(() => { const v = repos.getAccountSetting(acc.id, 'filterAgeEnabled', true); return v === false || v === 0 || v === '0' || v === 'false'; })(),
    filterMinLikes: metricFilters.minLikes,
    filterMinComments: metricFilters.minComments,
    filterMinFavorites: metricFilters.minFavorites,
    filterMinShares: metricFilters.minShares,
    filterLikesEnabled: metricSwitches.likes,
    filterCommentsEnabled: metricSwitches.comments,
    filterFavoritesEnabled: metricSwitches.favorites,
    filterSharesEnabled: metricSwitches.shares,
    pools,
    banWords: repos.getAccountSetting(acc.id, 'banWords', []),
  };
}

function dataFromDb() {
  const acc = currentAccount();
  const day = today();
  const plan = scheduleFromAccount(acc);
  const sends = repos.listSends({ accountId: acc.id, limit: 200 });
  const schedule = scheduleRuntime(acc, day, plan, sends);
  return {
    account: acc.label,
    accountName: acc.display_name || acc.label,
    enabled: !!acc.enabled,
    friend: repos.listEnabledFriendNames(acc.id)[0] || acc.friend,
    friends: repos.listEnabledFriendNames(acc.id),
    schedule,
    todayPlan: schedule.count,
    todayDone: repos.countSendsByDay(day, acc.id),
    todayTimeline: schedule.timeline,
    nextTime: schedule.nextAt,
    totalSends: sends.length,
    bucketStats: Object.fromEntries(repos.bucketStats(acc.id).map((r) => [r.bucket || '-', r.n])),
    sends: sends.map((s) => ({
      ts: s.ts,
      local: new Date(s.ts).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }),
      bucket: s.bucket,
      source: s.source || 'pool',
      title: s.title,
      author: s.author,
      friend: s.friend,
      likes: s.likes,
      ok: s.ok,
      toast: s.toast,
      shot: s.shot,
    })),
    generatedAt: new Date().toISOString(),
  };
}

// one ad-hoc send at a time; the browser profile cannot serve two senders
const sendJob = { id: null, startedAt: null, status: 'idle', result: null, dry: false, account: null };
// A manual click can be repeated by double-click, a stale tab, or a second client.
// Keep a short cooldown after the job finishes so natural-share batches cannot stack.
const MANUAL_SEND_COOLDOWN_MS = 90 * 1000;
let lastManualSend = { account: null, at: 0 };

function manualSendBlocked(acc, dry = false) {
  if (dry) return null;
  if (sendJob.status === 'running') return { status: 409, error: '已经有一条在发送中' };
  const label = acc && acc.label;
  if (label && lastManualSend.account === label) {
    const left = MANUAL_SEND_COOLDOWN_MS - (Date.now() - lastManualSend.at);
    if (left > 0) return { status: 429, error: `刚手动发送过，请 ${Math.ceil(left / 1000)} 秒后再试，避免重复发送` };
  }
  return null;
}

function markManualSend(acc) {
  if (acc && acc.label) lastManualSend = { account: acc.label, at: Date.now() };
}

async function runSendJob({ dry = false, accountLabel = null } = {}) {
  const scheduler = require('./scheduler');
  const cfg = scheduler.runtimeConfig();
  sendJob.id = `job-${Date.now()}`;
  sendJob.startedAt = new Date().toISOString();
  sendJob.status = 'running';
  sendJob.result = null;
  sendJob.dry = dry;
  sendJob.account = accountLabel || (cfg && cfg.account && cfg.account.label) || null;
  try {
    // sendOne decides whether the browser is needed (pure-API mode skips it entirely) and
    // starts/stops the browser itself on the fallback path.
    const res = await scheduler.sendOne(cfg, { dryRun: dry }).catch((e) => ({ ok: false, error: e.message }));
    sendJob.result = res;
    sendJob.status = res && res.ok ? 'done' : 'failed';
  } catch (e) {
    sendJob.result = { ok: false, error: e.message.split('\n')[0] };
    sendJob.status = 'failed';
  }
  repos.logEvent('manual-send', { dry, status: sendJob.status, result: sendJob.result });
  if (!dry && sendJob.account) markManualSend({ label: sendJob.account });
  return sendJob;
}

async function ensureAccountBrowser(acc, waitMs = 20000) {
  let state = await service.browserStatus(acc.port);
  if (state.up) return state;
  try { startBrowserFor(acc); } catch (e) { return { up: false, error: e.message }; }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    state = await service.browserStatus(acc.port);
    if (state.up) return state;
  }
  return state;
}

const mutualCacheKey = (label) => `mutualFriends:${label}`;

function readMutualCache(label) {
  const cache = repos.getSetting(mutualCacheKey(label), null);
  return cache && typeof cache === 'object' && Array.isArray(cache.mutual) ? cache : null;
}

function saveMutualCache(label, out) {
  const cache = { ...out, label, fetchedAt: new Date().toISOString() };
  repos.setSetting(mutualCacheKey(label), cache);
  return cache;
}

function mutualUserFor(acc, name) {
  const cache = readMutualCache(acc.label);
  return cache ? cache.mutual.find((u) => u.name === name) || null : null;
}

async function fetchMutualFriends(acc) {
  const state = await ensureAccountBrowser(acc);
  if (!state.up) throw new Error(state.error || '浏览器未能启动');
  const js = `
    (async () => {
      const common = 'device_platform=webapp&aid=6383&channel=channel_pc_web&pc_client_type=1&source_type=1&count=50';
      const prof = await fetch('/aweme/v1/web/user/profile/self/?' + common, { credentials: 'include', headers: { referer: location.href } })
        .then((r) => r.json()).catch((e) => ({ error: e.message }));
      if (!prof || !prof.user || !prof.user.sec_uid) return { ok: false, error: (prof && prof.status_msg) || '未登录' };
      const sec = encodeURIComponent(prof.user.sec_uid);
      const mutual = [];
      const seen = new Set();
      const seenMutual = new Set();
      // following/list pages are bounded by min_time, not max_time. Passing max_time back
      // only re-reads the top of the list and silently drops most of the roster.
      let maxTime = 0;
      let page = 0;
      let scanned = 0;
      let error = null;
      while (page < 30) {
        const url = '/aweme/v1/web/user/following/list/?' + common + '&sec_user_id=' + sec + '&max_time=' + maxTime + '&min_time=0&offset=0';
        const j = await fetch(url, { credentials: 'include', headers: { referer: location.href } })
          .then((r) => r.json()).catch((e) => ({ error: e.message }));
        if (!j || j.status_code !== 0) { error = String((j && (j.status_msg || j.error)) || '接口失败'); break; }
        const list = j.followings || [];
        for (const u of list) {
          const id = String(u.uid || u.sec_uid || '');
          if (!id || seen.has(id)) continue;
          seen.add(id);
          scanned++;
          // follow_status 2 / relation_label 好友 = 互相关注
          if (u.follow_status === 2 || (u.relation_label && String(u.relation_label).includes('好友'))) {
            if (seenMutual.has(id)) continue;
            seenMutual.add(id);
            mutual.push({ name: u.nickname || '', uid: String(u.uid || ''), sec_uid: u.sec_uid || '', unique_id: u.unique_id || '' });
          }
        }
        if (!j.has_more) break;
        const nextMaxTime = Number(j.min_time) || 0;
        if (!nextMaxTime || (maxTime && nextMaxTime >= maxTime)) {
          error = '关注列表分页游标没有进展';
          break;
        }
        maxTime = nextMaxTime;
        page++;
      }
      const followingTotal = Number(prof.user.following_count) || scanned;
      return {
        ok: true,
        self: { nickname: prof.user.nickname, uid: String(prof.user.uid || ''), sec_uid: prof.user.sec_uid },
        mutual,
        following: scanned,
        followingTotal,
        complete: scanned >= followingTotal,
        followers: Number(prof.user.follower_count) || null,
        errors: error ? [error] : [],
      };
    })()
  `;
  const res = await fetch(`http://127.0.0.1:${acc.port}/eval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ js }),
    signal: AbortSignal.timeout(90000),
  });
  const out = await res.json();
  if (!out.out || !out.out.ok) throw new Error((out.out && out.out.error) || '读取失败');
  return out.out;
}

function profileDirFor(label) {
  const slug = String(label || 'account').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 16) || 'account';
  const hash = crypto.createHash('sha1').update(String(label)).digest('hex').slice(0, 6);
  return path.join(env.DATA_DIR, `profile-${slug}-${hash}`);
}

function startBrowserFor(acc) {
  const child = spawn(
    process.execPath,
    [path.join(env.ROOT, 'src', 'browser-server.js'), '--profile', env.browserProfileDir(acc.profile_dir), '--port', String(acc.port)],
    { cwd: env.ROOT, env: process.env, detached: true, stdio: 'ignore', windowsHide: true }
  );
  child.unref();
  return true;
}

async function statusFromDb() {
  const acc = currentAccount();
  const sched = service.schedulerStatus();
  const browser = await service.browserStatus(acc.port);
  return {
    scheduler: sched,
    browser,
    account: acc.label,
    accountName: acc.display_name || acc.label,
    enabled: !!acc.enabled,
  };
}

function sanitize(input) {
  const src = input && typeof input === 'object' ? input : {};
  const plan = burstPlanner.normalizeConfig({
    points: src.schedulePoints ?? src.burstPoints,
    minSec: src.burstMinSec ?? src.burst_min_sec,
    maxSec: src.burstMaxSec ?? src.burst_max_sec,
    floor: src.burstDurationFloor ?? src.burst_duration_floor,
    fallbackSec: src.burstFallbackSec ?? src.burst_fallback_sec,
  });
  const metrics = videoPicker.normalizeMetricFilters({
    minLikes: src.filterMinLikes,
    minComments: src.filterMinComments,
    minFavorites: src.filterMinFavorites,
    minShares: src.filterMinShares,
  });
  const switches = videoPicker.normalizeFilterSwitches({
    likesEnabled: src.filterLikesEnabled,
    commentsEnabled: src.filterCommentsEnabled,
    favoritesEnabled: src.filterFavoritesEnabled,
    sharesEnabled: src.filterSharesEnabled,
  }, metrics);
  const ageRaw = src.filterAgeEnabled;
  const ageEnabled = ageRaw === undefined ? true : !(ageRaw === false || ageRaw === 0 || ageRaw === '0' || ageRaw === 'false');
  return {
    enabled: src.enabled !== false,
    friend: String(src.friend || '').trim(),
    schedulePoints: plan.points,
    burstMinSec: plan.minSec,
    burstMaxSec: plan.maxSec,
    burstDurationFloor: plan.floor,
    burstFallbackSec: plan.fallbackSec,
    poolDelayMs: Math.min(30000, Math.max(0, Math.round(Number(src.poolDelayMs ?? 2500)))),
    maxVideoAgeDays: Math.min(30, Math.max(1, Math.round(Number(src.maxVideoAgeDays ?? 7)) || 7)),
    recommendMaxAgeDays: Math.min(365, Math.max(0, Math.round(Number(src.recommendMaxAgeDays ?? 30)) || 0)),
    naturalShare: src.naturalShare === true,
    naturalText: src.naturalText !== false,
    videoSource: src.videoSource === 'recommend' ? 'recommend' : 'pool',
    filterAgeEnabled: ageEnabled,
    filterMinLikes: metrics.minLikes,
    filterMinComments: metrics.minComments,
    filterMinFavorites: metrics.minFavorites,
    filterMinShares: metrics.minShares,
    filterLikesEnabled: switches.likes,
    filterCommentsEnabled: switches.comments,
    filterFavoritesEnabled: switches.favorites,
    filterSharesEnabled: switches.shares,
    pools: src.pools && typeof src.pools === 'object' ? src.pools : {},
    banWords: (Array.isArray(src.banWords) ? src.banWords : [])
      .map((w) => String(w).trim())
      .filter(Boolean)
      .slice(0, 200),
  };
}

function persist(cfg, acc = currentAccount()) {
  const conn = require('./db').open();
  conn.exec('BEGIN');
  try {
    conn.prepare('UPDATE accounts SET enabled = ? WHERE id = ?').run(cfg.enabled ? 1 : 0, acc.id);
    repos.syncAccountFriend(acc.id);
    repos.setAccountSetting(acc.id, 'schedulePoints', cfg.schedulePoints);
    repos.setAccountSetting(acc.id, 'burstMinSec', cfg.burstMinSec);
    repos.setAccountSetting(acc.id, 'burstMaxSec', cfg.burstMaxSec);
    repos.setAccountSetting(acc.id, 'burstDurationFloor', !!cfg.burstDurationFloor);
    repos.setAccountSetting(acc.id, 'burstFallbackSec', cfg.burstFallbackSec);
    repos.setAccountSetting(acc.id, 'poolDelayMs', cfg.poolDelayMs);
    repos.setAccountSetting(acc.id, 'maxVideoAgeDays', cfg.maxVideoAgeDays);
    repos.setAccountSetting(acc.id, 'recommendMaxAgeDays', cfg.recommendMaxAgeDays);
    repos.setAccountSetting(acc.id, 'naturalShare', !!cfg.naturalShare);
    repos.setAccountSetting(acc.id, 'naturalText', cfg.naturalText !== false);
    repos.setAccountSetting(acc.id, 'videoSource', cfg.videoSource);
    repos.setAccountSetting(acc.id, 'filterAgeEnabled', cfg.filterAgeEnabled !== false);
    repos.setAccountSetting(acc.id, 'filterMinLikes', cfg.filterMinLikes);
    repos.setAccountSetting(acc.id, 'filterMinComments', cfg.filterMinComments);
    repos.setAccountSetting(acc.id, 'filterMinFavorites', cfg.filterMinFavorites);
    repos.setAccountSetting(acc.id, 'filterMinShares', cfg.filterMinShares);
    repos.setAccountSetting(acc.id, 'filterLikesEnabled', cfg.filterLikesEnabled !== false);
    repos.setAccountSetting(acc.id, 'filterCommentsEnabled', cfg.filterCommentsEnabled !== false);
    repos.setAccountSetting(acc.id, 'filterFavoritesEnabled', cfg.filterFavoritesEnabled !== false);
    repos.setAccountSetting(acc.id, 'filterSharesEnabled', cfg.filterSharesEnabled !== false);
    repos.setAccountSetting(acc.id, 'banWords', cfg.banWords);
    for (const p of repos.listPools()) {
      if (Object.prototype.hasOwnProperty.call(cfg.pools, p.name)) {
        repos.setAccountPoolEnabled(acc.id, p.name, cfg.pools[p.name] !== false);
      }
    }
    conn.exec('COMMIT');
  } catch (e) {
    conn.exec('ROLLBACK');
    throw e;
  }
  return configFromDb(acc);
}

// "重排今日" in the unified model means "start today's schedule over".
function regenerateToday(acc) {
  const { forceNow, plan } = resetSchedule(acc);
  repos.logEvent('schedule-reset', { account: acc.label, reason: 'regenerate', forceNow, points: plan.pointCount });
  return { count: plan.totalCount, schedule: true, times: [], notes: ['已重置今天的发送计划'] };
}

const PAGE = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8');
const APP_VERSION = require('../package.json').version;

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

function startServer({ host = env.dashboard.host, port = env.dashboard.port } = {}) {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://${host}`);
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (u.pathname.startsWith('/assets/dsh-pet/')) {
        const map = {
          'idle.webm': ['video/webm', 'idle.webm'],
          'look.webm': ['video/webm', 'look.webm'],
          'think.webm': ['video/webm', 'think.webm'],
          'cheer.webm': ['video/webm', 'cheer.webm'],
          'happy.webm': ['video/webm', 'happy.webm'],
          'sleep-start.webm': ['video/webm', 'sleep-start.webm'],
          'sleep-loop.webm': ['video/webm', 'sleep-loop.webm'],
          'sleep-wake.webm': ['video/webm', 'sleep-wake.webm'],
          'surprised.webm': ['video/webm', 'surprised.webm'],
          'stretch.webm': ['video/webm', 'stretch.webm'],
          'character.png': ['image/png', 'character.png'],
          'character-transparent.png': ['image/png', 'character-transparent.png'],
        };
        const hit = map[u.pathname.slice('/assets/dsh-pet/'.length)];
        if (hit) {
          const file = path.join(__dirname, 'assets', 'dsh-pet', hit[1]);
          if (!fs.existsSync(file)) return send(res, 404, { error: 'asset not found' });
          res.setHeader('Content-Type', hit[0]);
          res.setHeader('Cache-Control', 'public, max-age=86400');
          return res.end(fs.readFileSync(file));
        }
      }
      if (u.pathname === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        const pools = repos.listPools().map((p) => p.name);
        return res.end(PAGE.replace('__POOL_NAMES__', JSON.stringify(pools)).replaceAll('__APP_VERSION__', APP_VERSION));
      }
      if (u.pathname === '/viewer' || u.pathname === '/viewer.html') {
        const file = path.join(env.ROOT, 'app', 'viewer.html');
        if (!fs.existsSync(file)) return send(res, 404, { error: 'viewer not found' });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(fs.readFileSync(file));
      }
      if (u.pathname === '/api/data') return send(res, 200, dataFromDb());
      if (u.pathname === '/api/status') return send(res, 200, await statusFromDb());
      if (u.pathname === '/api/send-now' && req.method === 'GET') {
        return send(res, 200, { job: sendJob });
      }
      if (u.pathname === '/api/send-now' && req.method === 'POST') {
        let dry = false;
        try {
          const body = await new Promise((resolve) => {
            let b = '';
            req.on('data', (c) => (b += c));
            req.on('end', () => resolve(b));
          });
          dry = !!(JSON.parse(body || '{}').dry);
        } catch (e) {}
        const acc = currentAccount();
        const blocked = manualSendBlocked(acc, dry);
        if (blocked) return send(res, blocked.status, { ok: false, error: blocked.error });
        const browser = await service.browserStatus(acc.port);
        if (browser.up) return send(res, 409, { ok: false, error: '浏览器窗口已被占用(可能调度正在发送),稍后再试' });
        runSendJob({ dry, accountLabel: acc.label }).catch(() => {});
        return send(res, 202, { ok: true, job: sendJob });
      }
      if (u.pathname === '/api/browser/start' && req.method === 'POST') {
        const acc = currentAccount();
        const state = await service.browserStatus(acc.port);
        if (state.up) return send(res, 200, { ok: true, already: true, url: state.url || null });
        try {
          startBrowserFor(acc);
          repos.logEvent('browser-start', { account: acc.label });
          return send(res, 200, { ok: true, started: true });
        } catch (e) {
          return send(res, 500, { ok: false, error: e.message.split('\n')[0] });
        }
      }
      if (u.pathname === '/api/screen') {
        const acc = currentAccount();
        try {
          const r = await fetch(`http://127.0.0.1:${acc.port}/screen`, { signal: AbortSignal.timeout(8000) });
          if (!r.ok) return send(res, 502, { ok: false, error: 'browser not ready' });
          const buf = Buffer.from(await r.arrayBuffer());
          res.setHeader('Content-Type', 'image/png');
          res.setHeader('Cache-Control', 'no-store');
          return res.end(buf);
        } catch (e) {
          return send(res, 502, { ok: false, error: 'browser not running' });
        }
      }
      if (u.pathname === '/api/click' && req.method === 'POST') {
        const acc = currentAccount();
        let body = '';
        for await (const c of req) body += c;
        const { x, y } = JSON.parse(body || '{}');
        try {
          const out = await fetch(`http://127.0.0.1:${acc.port}/click`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ x: Math.round(x), y: Math.round(y) }),
            signal: AbortSignal.timeout(10000),
          }).then((r) => r.json());
          return send(res, 200, out);
        } catch (e) {
          return send(res, 502, { ok: false, error: 'browser not running' });
        }
      }
      if (u.pathname === '/api/window' && req.method === 'POST') {
        const acc = currentAccount();
        let body = '';
        for await (const c of req) body += c;
        const input = JSON.parse(body || '{}');
        try {
          const out = await fetch(`http://127.0.0.1:${acc.port}/window`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ show: !!input.show, minimized: !!input.minimized }),
            signal: AbortSignal.timeout(10000),
          }).then((r) => r.json());
          return send(res, 200, out);
        } catch (e) {
          return send(res, 502, { ok: false, error: 'browser not running' });
        }
      }
      if (u.pathname === '/api/api-session') {
        const acc = currentAccount();
        const session = apiSession.load(acc.label);
        const state = apiSession.status(session, null);
        const accountFriendEntries = repos
          .listFriends(acc.id)
          .filter((f) => f.enabled)
          .map((f) => ({ name: f.name, userid: f.userid || '', apiCapable: !!f.userid || apiSession.canSendTo(session, f.name) }));
        return send(res, 200, {
          present: !!session,
          valid: state.valid,
          reason: state.reason || null,
          ageHours: state.ageHours,
          createdAt: (session && session.createdAt) || null,
          account: (session && session.account) || acc.label,
          accountName: (session && session.accountName) || acc.display_name || acc.label,
          friend: (session && session.friend) || null,
          defaultFriend: (session && session.friend) || repos.listEnabledFriendNames(acc.id)[0] || acc.friend,
          accountFriends: repos.listEnabledFriendNames(acc.id),
          accountFriendEntries,
          templateBytes: session && session.template ? session.template.bodyB64.length : 0,
          cookies: session ? (session.cookies || []).length : 0,
          friends: session ? (session.friends || []) : [],
          friendCount: session ? (session.friends || []).length : 0,
          hasCreateTemplate: !!(session && session.createTemplate),
          hasFeedUrl: !!(session && session.feedUrl),
          feedPaths: session && Array.isArray(session.feedPaths) ? session.feedPaths : [],
          sendMode: repos.getAccountSetting(acc.id, 'sendMode', 'auto'),
          videoSource: repos.getAccountSetting(acc.id, 'videoSource', 'pool'),
          autoRefresh: settingOn('apiAutoRefresh'),
          maxAgeHours: apiSession.DEFAULT_MAX_AGE_HOURS,
        });
      }
      if (u.pathname === '/api/api-session/refresh' && req.method === 'POST') {
        try {
          const label = currentAccount().label;
          const child = spawn(process.execPath, [path.join(env.ROOT, 'src', 'index.js'), 'api:export', '--account', label], {
            cwd: env.ROOT,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          });
          child.unref();
          return send(res, 202, { ok: true, started: true });
        } catch (e) {
          return send(res, 500, { ok: false, error: e.message.split('\n')[0] });
        }
      }
      if (u.pathname === '/api/api-session/send' && req.method === 'POST') {
        const acc = currentAccount();
        let body = '';
        for await (const c of req) body += c;
        const input = JSON.parse(body || '{}');
        const list = Array.isArray(input.friends)
          ? [...new Set(input.friends.map((f) => String(f || '').trim()).filter(Boolean))]
          : [String(input.friend || '').trim()].filter(Boolean);
        if (!list.length) return send(res, 400, { ok: false, error: '没有选择好友' });
        const dry = !!input.dry;
        const blocked = manualSendBlocked(acc, dry);
        if (blocked) return send(res, blocked.status, { ok: false, error: blocked.error });
        const apiSender = require('./api-sender');
        const session = apiSession.load(acc.label);
        const state = apiSession.status(session, null);
        if (!state.valid) return send(res, 400, { ok: false, error: `api session 不可用：${state.reason}` });
        const accountSource = repos.getAccountSetting(acc.id, 'videoSource', 'pool');
        const source = input.source === 'recommend' || input.source === 'pool'
          ? input.source
          : (accountSource === 'recommend' ? 'recommend' : 'pool');
        let pool = null;
        if (source === 'pool') {
          const pools = repos.listAccountPools(acc.id).filter((p) => p.enabled);
          if (!pools.length) return send(res, 400, { ok: false, error: '没有启用的视频池' });
          pool = pools[Math.floor(Math.random() * pools.length)];
        } else if (!session || !session.feedUrl) {
          return send(res, 400, { ok: false, error: '当前账户的纯 API 会话没有捕获到首页推荐 feed，请先重新导出会话' });
        }
        try {
          const history = videoPicker.buildHistory(repos.listRecentSentVideos(acc.id, videoPicker.DEFAULT_HISTORY_DAYS));
          const pickOptions = {
            banWords: repos.getAccountSetting(acc.id, 'banWords', []),
            excludeVideoIds: history.ids,
            excludeTitles: history.titles,
          };
          const poolMaxAgeDays = Number(repos.getAccountSetting(acc.id, 'maxVideoAgeDays', 7));
          const recommendMaxAgeDays = Number(repos.getAccountSetting(acc.id, 'recommendMaxAgeDays', 30));
          let video;
          if (source === 'recommend') {
            const collected = await apiSender.collectFeedCandidates(session, { ...pickOptions, maxAgeDays: recommendMaxAgeDays });
            const interests = repos.listAccountPools(acc.id).filter((p) => p.enabled).map((p) => p.name);
            const ranked = await aiRanker.rankCandidates(collected.candidates, {
              mode: repos.getAccountSetting(acc.id, 'aiMode', 'off'),
              interests,
              banWords: pickOptions.banWords,
            });
            if (ranked.used && !ranked.candidates.length) throw new Error('AI 过滤后没有安全候选');
            if (ranked.used) {
              repos.logEvent('ai-rank', { account: acc.label, model: ranked.model, kept: ranked.candidates.length, reason: ranked.reason, via: 'panel' });
            }
            const chosen = videoPicker.chooseVideo(ranked.candidates.length ? ranked.candidates : collected.candidates, {
              ids: pickOptions.excludeVideoIds,
              titles: pickOptions.excludeTitles,
            });
            if (!chosen) throw new Error('推荐 feed 没有可用候选');
            video = { ...chosen, source: 'recommend', bucket: '默认推荐' };
          } else {
            const keyword = (() => {
              const value = chooseKeyword(pool);
              return value.startsWith('@') ? pool.name : value;
            })();
            const aiMode = repos.getAccountSetting(acc.id, 'aiMode', 'off');
            if (aiRanker.active(aiMode)) {
              const collected = await apiSender.collectSearchCandidates(session, {
                keyword,
                banWords: pickOptions.banWords,
                maxAgeDays: poolMaxAgeDays,
              });
              const interests = repos.listAccountPools(acc.id).filter((p) => p.enabled).map((p) => p.name);
              const ranked = await aiRanker.rankCandidates(collected.candidates, {
                mode: aiMode,
                interests,
                banWords: pickOptions.banWords,
              });
              if (ranked.used && !ranked.candidates.length) throw new Error('AI 过滤后没有安全候选');
              if (ranked.used) {
                repos.logEvent('ai-rank', { account: acc.label, model: ranked.model, kept: ranked.candidates.length, reason: ranked.reason, via: 'panel', source: 'pool' });
              }
              const chosen = videoPicker.chooseVideo(ranked.candidates.length ? ranked.candidates : collected.candidates, {
                ids: pickOptions.excludeVideoIds,
                titles: pickOptions.excludeTitles,
              });
              if (!chosen) throw new Error('池搜索没有可用候选');
              video = { ...chosen, source: 'pool', bucket: pool.name };
            } else {
              video = await apiSender.pick(session, {
                ...pickOptions,
                maxAgeDays: poolMaxAgeDays,
                keyword,
              });
            }
          }
          const bucket = source === 'recommend' ? '默认推荐' : pool.name;
          if (dry) {
            return send(res, 200, { ok: true, dry: true, source, bucket, friends: list, picked: video });
          }
          const results = [];
          for (const friend of list) {
            const row = repos.getFriendByName(acc.id, friend);
            const mutual = mutualUserFor(acc, friend);
            const toUserId = (row && row.userid) || (mutual && mutual.uid) || '';
            if (!apiSession.canSendTo(session, friend) && !toUserId) {
              results.push({ friend, ok: false, error: '好友不在会话好友列表里，也不是互关好友（刷新互关或重新导出会话）' });
              continue;
            }
            const out = await apiSender.sendVideo(session, video, { friend, toUserId }).catch((e) => ({ ok: false, error: e.message }));
            if (out.ok) {
              repos.insertSend({
                accountId: acc.id,
                ts: new Date().toISOString(),
                day: today(),
                bucket,
                title: video.title,
                author: video.author,
                likes: video.likes,
                friend,
                ok: true,
                toast: 'HTTP API (panel)',
                shot: null,
                videoId: video.awemeId,
                source,
              });
              repos.logEvent('sent-api', { source, pool: bucket, title: video.title, friend, serverMessageId: out.serverMessageId, via: 'panel' });
            } else {
              repos.logEvent('api-send-rejected', { source, statusCode: out.statusCode, statusMessage: out.statusMessage, title: video.title, friend });
            }
            results.push({ ...out, friend });
          }
          const ok = results.some((r) => r.ok);
          if (!dry && ok) markManualSend(acc);
          return send(res, ok ? 200 : 502, { ok, source, bucket, friends: list, results, video });
        } catch (e) {
          repos.logEvent('api-send-error', { source, error: (e.message || '').split('\n')[0], friends: list });
          return send(res, 500, { ok: false, error: e.message.split('\n')[0] });
        }
      }
      if (u.pathname === '/api/api-session/mode' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const input = JSON.parse(body || '{}') || {};
        const mode = input.mode;
        if (!['auto', 'browser'].includes(mode)) return send(res, 400, { ok: false, error: 'mode must be auto|browser' });
        const acc = accountFromInput(input);
        repos.setAccountSetting(acc.id, 'sendMode', mode);
        repos.logEvent('send-mode', { account: acc.label, mode });
        // scheduler children re-read their account config before each slot; no full restart
        return send(res, 200, { ok: true, mode, account: acc.label, restarted: false });
      }
      if (u.pathname === '/api/api-session/auto-refresh' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const enabled = !!(JSON.parse(body || '{}') || {}).enabled;
        repos.setSetting('apiAutoRefresh', enabled ? '1' : '0');
        return send(res, 200, { ok: true, enabled });
      }
      if (u.pathname === '/api/database' && req.method === 'GET') {
        const configured = dbConfig.load();
        const active = require('./db').dialect;
        return send(res, 200, {
          ok: true,
          active,
          config: dbConfig.publicConfig(configured),
          restartRequired: configured.driver !== active,
        });
      }
      if (u.pathname === '/api/database' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const input = JSON.parse(body || '{}') || {};
        try {
          const patch = {};
          for (const key of ['driver', 'sqliteFile', 'host', 'database', 'user', 'password', 'url']) {
            if (input[key] != null) patch[key] = input[key];
          }
          if (input.port != null && input.port !== '') patch.port = Number(input.port);
          if (input.ssl != null) patch.ssl = !!input.ssl;
          const saved = dbConfig.save(patch);
          const active = require('./db').dialect;
          return send(res, 200, { ok: true, config: saved, active, restartRequired: saved.driver !== active });
        } catch (e) {
          return send(res, 400, { ok: false, error: e.message.split('\n')[0] });
        }
      }
      if (u.pathname === '/api/database/test' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const input = JSON.parse(body || '{}') || {};
        try {
          const current = dbConfig.load();
          const patch = {};
          for (const key of ['driver', 'sqliteFile', 'host', 'database', 'user', 'password', 'url']) {
            if (input[key] != null) patch[key] = input[key];
          }
          if (input.port != null && input.port !== '') patch.port = Number(input.port);
          if (input.ssl != null) patch.ssl = !!input.ssl;
          const testConfig = { ...current, ...patch };
          if (!input.password) testConfig.password = current.password;
          const result = await dbConfig.testConnection(testConfig);
          return send(res, 200, { ok: true, ...result });
        } catch (e) {
          return send(res, 502, { ok: false, error: e.message.split('\n')[0] });
        }
      }
      if (u.pathname === '/api/ai/status') {
        const acc = currentAccount();
        const conf = aiClient.load();
        return send(res, 200, {
          ok: true,
          config: aiClient.publicConfig(conf),
          account: acc.label,
          accountName: acc.display_name || acc.label,
          aiMode: repos.getAccountSetting(acc.id, 'aiMode', 'off'),
        });
      }
      if (u.pathname === '/api/ai/config' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const input = JSON.parse(body || '{}') || {};
        const patch = {};
        for (const key of ['enabled', 'assistantEnabled']) {
          if (input[key] != null) patch[key] = !!input[key];
        }
        for (const key of ['baseUrl', 'model', 'apiKey']) {
          if (input[key] != null) patch[key] = String(input[key]).trim();
        }
        if (input.timeoutMs != null) patch.timeoutMs = Number(input.timeoutMs);
        const acc = accountFromInput(input);
        const modes = ['off', 'moderate', 'rank', 'rank+moderate'];
        if (input.aiMode != null) {
          if (!modes.includes(input.aiMode)) return send(res, 400, { ok: false, error: 'aiMode 必须是 off|moderate|rank|rank+moderate' });
          repos.setAccountSetting(acc.id, 'aiMode', input.aiMode);
        }
        const publicConf = aiClient.save(patch);
        return send(res, 200, { ok: true, config: publicConf, account: acc.label, aiMode: repos.getAccountSetting(acc.id, 'aiMode', 'off') });
      }
      if (u.pathname === '/api/ai/test' && req.method === 'POST') {
        try {
          const out = await aiClient.chat({
            messages: [{ role: 'user', content: '只回复两个字母：OK' }],
            timeoutMs: 15000,
          });
          return send(res, 200, { ok: true, answer: out.content.slice(0, 200), usage: out.usage });
        } catch (e) {
          return send(res, 502, { ok: false, error: e.message.split('\n')[0] });
        }
      }
      if (u.pathname === '/api/ai/action' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const input = JSON.parse(body || '{}') || {};
        const acc = accountFromInput(input);
        try {
          const out = await aiActions.propose({ acc, text: input.question, history: input.history });
          return send(res, 200, { ok: true, answer: out.answer, actions: out.actions, model: out.model });
        } catch (e) {
          return send(res, 502, { ok: false, error: e.message.split('\n')[0] });
        }
      }
      if (u.pathname === '/api/ai/execute' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const input = JSON.parse(body || '{}') || {};
        const acc = accountFromInput(input);
        const action = aiActions.validateAction(input.action, acc);
        if (!action) return send(res, 400, { ok: false, error: '不支持的 AI 操作或参数无效' });
        const publicAction = aiActions.publicAction(action, acc);
        let result = {};
        switch (action.type) {
          case 'set_enabled': {
            repos.setAccountEnabled(acc.id, action.args.enabled);
            repos.logEvent(action.args.enabled ? 'ai-resume' : 'ai-pause', { account: acc.label });
            result = { enabled: action.args.enabled };
            break;
          }
          case 'set_schedule': {
            const current = configFromDb(acc);
            const cfg = sanitize({
              ...current,
              schedulePoints: action.args.schedulePoints ?? current.schedulePoints,
              burstMinSec: action.args.burstMinSec ?? current.burstMinSec,
              burstMaxSec: action.args.burstMaxSec ?? current.burstMaxSec,
              burstDurationFloor: action.args.burstDurationFloor ?? current.burstDurationFloor,
              burstFallbackSec: action.args.burstFallbackSec ?? current.burstFallbackSec,
            });
            result = { config: persist(cfg, acc) };
            break;
          }
          case 'set_video_source': {
            repos.setAccountSetting(acc.id, 'videoSource', action.args.source);
            result = { videoSource: action.args.source };
            break;
          }
          case 'set_ai_mode': {
            repos.setAccountSetting(acc.id, 'aiMode', action.args.mode);
            result = { aiMode: action.args.mode };
            break;
          }
          case 'set_ban_words': {
            repos.setAccountSetting(acc.id, 'banWords', action.args.words);
            result = { banWords: action.args.words };
            break;
          }
          case 'set_pools': {
            for (const p of repos.listPools()) {
              repos.setAccountPoolEnabled(acc.id, p.name, action.args.pools.includes(p.name));
            }
            result = { pools: action.args.pools };
            break;
          }
          case 'set_natural_share': {
            repos.setAccountSetting(acc.id, 'naturalShare', !!action.args.enabled);
            result = { naturalShare: !!action.args.enabled };
            break;
          }
          case 'replan_today': {
            result = regenerateToday(acc);
            break;
          }
          case 'refresh_session': {
            const child = spawn(process.execPath, [path.join(env.ROOT, 'src', 'index.js'), 'api:export', '--account', acc.label], {
              cwd: env.ROOT,
              env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
              detached: true,
              stdio: 'ignore',
              windowsHide: true,
            });
            child.unref();
            result = { started: true };
            break;
          }
          case 'send_now': {
            const blocked = manualSendBlocked(acc, false);
            if (blocked) return send(res, blocked.status, { ok: false, error: blocked.error });
            const browser = await service.browserStatus(acc.port);
            if (browser.up) return send(res, 409, { ok: false, error: '浏览器窗口已被占用，稍后再试' });
            runSendJob({ accountLabel: acc.label }).catch(() => {});
            result = { started: true, jobId: sendJob.id };
            break;
          }
          default:
            return send(res, 400, { ok: false, error: '不支持的 AI 操作' });
        }
        repos.logEvent('ai-action', { account: acc.label, type: action.type, summary: publicAction.summary });
        return send(res, 200, { ok: true, type: action.type, summary: publicAction.summary, result });
      }
      if (u.pathname === '/api/ai/ask' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const input = JSON.parse(body || '{}') || {};
        const acc = accountFromInput(input);
        try {
          const out = await aiAssistant.ask({ acc, question: input.question, history: input.history });
          return send(res, 200, { ok: true, answer: out.answer, usage: out.usage });
        } catch (e) {
          return send(res, 502, { ok: false, error: e.message.split('\n')[0] });
        }
      }
      if (u.pathname === '/api/ai/config-draft' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const input = JSON.parse(body || '{}') || {};
        const acc = accountFromInput(input);
        try {
          const out = await aiAssistant.draftConfig({ acc, text: input.text });
          return send(res, 200, { ok: true, draft: out.draft, usage: out.usage });
        } catch (e) {
          return send(res, 502, { ok: false, error: e.message.split('\n')[0] });
        }
      }
      if (u.pathname === '/api/pools' && req.method === 'GET') {
        const acc = currentAccount();
        return send(res, 200, { account: acc.label, pools: repos.listAccountPools(acc.id) });
      }
      if (u.pathname === '/api/pools/generalize' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const input = JSON.parse(body || '{}') || {};
        const acc = accountFromInput(input);
        const parentName = String(input.parent || '').trim();
        const parent = repos.listPools().find((p) => p.name === parentName);
        if (!parent) return send(res, 404, { ok: false, error: '父分类不存在' });
        try {
          const existing = repos.listPools().map((p) => p.name);
          const out = await aiPools.expand({ parent, existing, hint: String(input.hint || '').slice(0, 80) });
          const added = [];
          for (const cat of out.categories) {
            const row = repos.addPool({ name: cat.name, keyword: cat.keyword, parentName: parent.name, enabled: false });
            repos.setAccountPoolEnabled(acc.id, cat.name, true);
            added.push({ id: row.id, name: cat.name, keyword: cat.keyword, parentName: parent.name });
          }
          repos.setAccountPoolEnabled(acc.id, parent.name, true);
          repos.logEvent('pool-ai-generalize', { account: acc.label, parent: parent.name, added: added.map((x) => x.name) });
          return send(res, 200, { ok: true, model: out.model, categories: added, pools: repos.listAccountPools(acc.id) });
        } catch (e) {
          return send(res, 502, { ok: false, error: e.message.split('\n')[0] });
        }
      }
      if (u.pathname === '/api/friends' && req.method === 'GET') {
        const acc = currentAccount();
        return send(res, 200, { account: acc.label, accountName: acc.display_name || acc.label, friends: repos.listFriends(acc.id) });
      }
      if (u.pathname === '/api/friends' && req.method === 'POST') {
        const acc = currentAccount();
        let body = '';
        for await (const c of req) body += c;
        const input = JSON.parse(body || '{}') || {};
        const name = String(input.name || '').trim();
        const userid = String(input.userid || '').trim();
        if (!name) return send(res, 400, { ok: false, error: '好友昵称不能为空' });
        repos.addFriend(acc.id, name, userid);
        repos.logEvent('friend-add', { account: acc.label, name, userid: userid || undefined });
        return send(res, 200, { ok: true, friends: repos.listFriends(acc.id) });
      }
      if (u.pathname === '/api/friends' && req.method === 'PATCH') {
        const acc = currentAccount();
        let body = '';
        for await (const c of req) body += c;
        const input = JSON.parse(body || '{}');
        repos.setFriendEnabled(acc.id, Number(input.id), input.enabled !== false);
        return send(res, 200, { ok: true, friends: repos.listFriends(acc.id) });
      }
      if (u.pathname.startsWith('/api/friends/') && req.method === 'DELETE') {
        const acc = currentAccount();
        const id = Number(u.pathname.split('/').pop());
        if (!Number.isInteger(id)) return send(res, 400, { ok: false, error: 'bad id' });
        repos.removeFriend(acc.id, id);
        repos.logEvent('friend-remove', { account: acc.label, id });
        return send(res, 200, { ok: true, friends: repos.listFriends(acc.id) });
      }
      if (u.pathname === '/api/accounts/add' && req.method === 'POST') {
        if (databaseRestartRequired()) return send(res, 409, { ok: false, error: '数据库后端配置已变更，请先重启应用再添加账户' });
        let body = '';
        for await (const c of req) body += c;
        const input = JSON.parse(body || '{}');
        const name = String(input.name || '').trim().slice(0, 40);
        if (!name) return send(res, 400, { ok: false, error: '账户名称不能为空' });
        if (repos.getAccount(name)) return send(res, 409, { ok: false, error: `账户「${name}」已存在` });
        const ports = repos.listAccounts().map((a) => Number(a.port));
        const port = Number(input.port) || (ports.length ? Math.max(9333, ...ports) + 1 : 9334);
        const profileDir = profileDirFor(name);
        const acc = repos.upsertAccount({ label: name, profileDir, port, friend: '', enabled: false });
        repos.updateAccountDisplayName(acc.id, name);
        repos.replaceBands(acc.id, [
          { name: '早间', startMin: 9 * 60, endMin: 12 * 60, minCount: 1, maxCount: 2 },
          { name: '下午', startMin: 14 * 60, endMin: 18 * 60, minCount: 2, maxCount: 4 },
          { name: '晚间', startMin: 20 * 60, endMin: 23 * 60, minCount: 2, maxCount: 4 },
        ]);
        const friend = String(input.friend || '').trim();
        if (friend) repos.addFriend(acc.id, friend);
        repos.seedAccountDefaults(acc.id);
        repos.setSetting('activeAccount', acc.label);
        repos.logEvent('account-add', { label: acc.label, port: acc.port });
        const restarted = service.restartScheduler();
        return send(res, 200, { ok: true, account: { label: acc.label, name, port: acc.port }, restarted });
      }
      if (u.pathname === '/api/accounts/rename' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const input = JSON.parse(body || '{}');
        const acc = input.label ? repos.getAccount(String(input.label)) : currentAccount();
        if (!acc) return send(res, 404, { ok: false, error: '账户不存在' });
        const name = String(input.name || '').trim().slice(0, 40);
        if (!name) return send(res, 400, { ok: false, error: '名称不能为空' });
        repos.updateAccountDisplayName(acc.id, name);
        repos.logEvent('account-rename', { label: acc.label, name });
        return send(res, 200, { ok: true, label: acc.label, name });
      }
      if (u.pathname === '/api/accounts/enable' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const input = JSON.parse(body || '{}');
        const acc = input.label ? repos.getAccount(String(input.label)) : currentAccount();
        if (!acc) return send(res, 404, { ok: false, error: '账户不存在' });
        repos.setAccountEnabled(acc.id, input.enabled !== false);
        repos.logEvent(input.enabled === false ? 'account-pause' : 'account-resume', { label: acc.label });
        // each scheduler child re-reads its account state on the next loop; avoid restarting all accounts
        return send(res, 200, { ok: true, label: acc.label, enabled: input.enabled !== false, restarted: false });
      }
      if (u.pathname === '/api/accounts/add-qr' && req.method === 'POST') {
        if (databaseRestartRequired()) return send(res, 409, { ok: false, error: '数据库后端配置已变更，请先重启应用再添加账户' });
        let body = '';
        for await (const c of req) body += c;
        const input = JSON.parse(body || '{}');
        const wanted = String(input.name || '').trim().slice(0, 40);
        const existing = repos.listAccounts();
        let name = wanted;
        if (!name) {
          let n = existing.length + 1;
          do { name = `新账户${n++}`; } while (repos.listAccounts().some((a) => a.display_name === name || a.label === name));
        }
        let label = name;
        let suffix = 2;
        while (repos.getAccount(label)) label = `${name}-${suffix++}`;
        const ports = existing.map((a) => Number(a.port));
        const port = Number(input.port) || (ports.length ? Math.max(9333, ...ports) + 1 : 9334);
        const profileDir = profileDirFor(label);
        const acc = repos.upsertAccount({ label, profileDir, port, friend: '', enabled: false });
        repos.updateAccountDisplayName(acc.id, name);
        repos.replaceBands(acc.id, [
          { name: '早间', startMin: 9 * 60, endMin: 12 * 60, minCount: 1, maxCount: 2 },
          { name: '下午', startMin: 14 * 60, endMin: 18 * 60, minCount: 2, maxCount: 4 },
          { name: '晚间', startMin: 20 * 60, endMin: 23 * 60, minCount: 2, maxCount: 4 },
        ]);
        const friend = String(input.friend || '').trim();
        if (friend) repos.addFriend(acc.id, friend);
        repos.seedAccountDefaults(acc.id);
        repos.setSetting('activeAccount', acc.label);
        repos.logEvent('account-add-qr', { label: acc.label, port: acc.port });
        try { startBrowserFor(acc); } catch (e) {}
        const restarted = service.restartScheduler();
        return send(res, 200, {
          ok: true,
          account: { label: acc.label, name, port: acc.port, profile: acc.profile_dir },
          restarted,
        });
      }
      if (u.pathname === '/api/accounts/detect-name' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const input = JSON.parse(body || '{}');
        const acc = input.label ? repos.getAccount(String(input.label)) : currentAccount();
        if (!acc) return send(res, 404, { ok: false, error: '账户不存在' });
        const state = await service.browserStatus(acc.port);
        if (!state.up) return send(res, 200, { ok: true, loggedIn: false, reason: '浏览器尚未启动' });
        let profile = null;
        try {
          const js = "fetch('/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383&channel=channel_pc_web&publish_video_strategy_type=2&source=channel_pc_web',{credentials:'include',headers:{referer:location.href}}).then(r=>r.json()).then(j=>({status:j.status_code,nickname:j.user&&j.user.nickname,uid:j.user&&j.user.uid})).catch(e=>({error:e.message}))";
          const r = await fetch(`http://127.0.0.1:${acc.port}/eval`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ js }),
            signal: AbortSignal.timeout(8000),
          });
          const out = await r.json();
          profile = out.out || null;
        } catch (e) {
          return send(res, 200, { ok: true, loggedIn: false, reason: '读取登录状态失败：' + e.message.split('\n')[0] });
        }
        if (!profile || profile.status !== 0 || !profile.nickname) {
          return send(res, 200, { ok: true, loggedIn: false, reason: profile && profile.error ? profile.error : '尚未登录' });
        }
        const auto = !acc.display_name || /^新账户/.test(acc.display_name) || acc.display_name === acc.label;
        let renamed = false;
        if (auto) {
          repos.updateAccountDisplayName(acc.id, profile.nickname);
          renamed = true;
          repos.logEvent('account-detected', { label: acc.label, nickname: profile.nickname, uid: profile.uid });
        }
        return send(res, 200, {
          ok: true,
          loggedIn: true,
          nickname: profile.nickname,
          uid: profile.uid,
          renamed,
          label: acc.label,
          accountName: repos.getAccount(acc.label).display_name || acc.label,
        });
      }
      if (u.pathname === '/api/accounts/mutual-friends' && req.method === 'GET') {
        const label = u.searchParams.get('label');
        const acc = label ? repos.getAccount(String(label)) : currentAccount();
        if (!acc) return send(res, 404, { ok: false, error: '账户不存在' });
        const cache = readMutualCache(acc.label);
        const ageMs = cache && cache.fetchedAt ? Date.now() - Date.parse(cache.fetchedAt) : null;
        return send(res, 200, cache
          ? { ok: true, cached: true, stale: !(Number.isFinite(ageMs) && ageMs < 6 * 60 * 60 * 1000), ...cache }
          : { ok: true, cached: false, label: acc.label, mutual: [], errors: [] });
      }
      if (u.pathname === '/api/accounts/mutual-friends' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const input = JSON.parse(body || '{}');
        const acc = input.label ? repos.getAccount(String(input.label)) : currentAccount();
        if (!acc) return send(res, 404, { ok: false, error: '账户不存在' });
        try {
          const out = await fetchMutualFriends(acc);
          const cache = saveMutualCache(acc.label, out);
          repos.logEvent('mutual-friends', { account: acc.label, mutual: out.mutual.length, following: out.following, followers: out.followers });
          return send(res, 200, { ...cache, ok: true, cached: true, stale: false, errors: out.errors || [] });
        } catch (e) {
          return send(res, 500, { ok: false, error: e.message.split('\n')[0] });
        }
      }
      if (u.pathname === '/api/accounts/switch' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const { label } = JSON.parse(body || '{}');
        const target = repos.getAccount(String(label || ''));
        if (!target) return send(res, 404, { ok: false, error: `没有账户 ${label}` });
        const from = currentAccount().label;
        repos.setSetting('activeAccount', target.label);
        repos.logEvent('account-switch', { from, to: target.label });
        // all accounts schedule independently; switching only changes what the panel displays
        return send(res, 200, { ok: true, active: target.label, restarted: false });
      }
      if (u.pathname === '/api/accounts') {
        const rows = require('./db').open().prepare('SELECT * FROM accounts ORDER BY id').all();
        const accounts = rows.map((a) => ({
          id: a.id,
          label: a.label,
          name: a.display_name || a.label,
          port: a.port,
          friend: repos.listEnabledFriendNames(a.id)[0] || a.friend,
          friends: repos.listEnabledFriendNames(a.id),
          enabled: !!a.enabled,
          profile: a.profile_dir,
          points: scheduleConfig.fromAccount(a).pointCount,
          dailyTotal: scheduleConfig.fromAccount(a).totalCount,
          sends: repos.listSends({ accountId: a.id, limit: 100000 }).length,
        }));
        return send(res, 200, { accounts, active: currentAccount().label });
      }
      if (u.pathname === '/api/events') {
        const limit = Math.min(200, Number(u.searchParams.get('limit')) || 40);
        return send(res, 200, { events: repos.listEvents(limit) });
      }
      if (u.pathname === '/api/control' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const { action } = JSON.parse(body || '{}');
        const acc = currentAccount();
        const conn = require('./db').open();
        if (action === 'pause') {
          conn.prepare('UPDATE accounts SET enabled = 0 WHERE id = ?').run(acc.id);
          repos.logEvent('manual-pause', { account: acc.label });
        } else if (action === 'resume') {
          conn.prepare('UPDATE accounts SET enabled = 1 WHERE id = ?').run(acc.id);
          repos.logEvent('manual-resume', { account: acc.label });
        } else if (action !== 'restart') {
          return send(res, 400, { ok: false, error: 'unknown action' });
        }
        if (action === 'restart' && databaseRestartRequired()) {
          return send(res, 409, { ok: false, error: '数据库后端配置已变更，请重启整个应用（不是只重启调度）' });
        }
        const restarted = action === 'restart' ? service.restartScheduler() : { ok: true, kind: 'next-loop' };
        return send(res, 200, { ok: true, action, restarted });
      }
      if (u.pathname === '/api/config' && req.method === 'GET') return send(res, 200, configFromDb());
      if (u.pathname === '/api/config' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const input = JSON.parse(body || '{}');
        const acc = accountFromInput(input);
        const cfg = sanitize(input);
        return send(res, 200, { ok: true, config: persist(cfg, acc) });
      }
      if (u.pathname === '/api/preview' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const cfg = sanitize(JSON.parse(body));
        const plan = burstPlanner.normalizeConfig({
          points: cfg.schedulePoints,
          minSec: cfg.burstMinSec, maxSec: cfg.burstMaxSec,
          floor: cfg.burstDurationFloor, fallbackSec: cfg.burstFallbackSec,
        });
        const est = burstPlanner.estimate(plan);
        const last = est.points[est.points.length - 1];
        return send(res, 200, {
          ok: true,
          mode: 'schedule',
          points: est.points,
          pointCount: plan.pointCount,
          count: est.totalCount,
          requested: est.totalCount,
          summary: burstPlanner.summary(plan),
          estimate: { perSec: est.perSec, totalMinutes: est.totalMinutes, end: last ? last.end : '' },
          times: [],
          bands: [],
          allocation: [],
          notes: [],
        });
      }
      if (u.pathname === '/api/today/burst-reset' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const input = body ? JSON.parse(body) : {};
        const acc = accountFromInput(input);
        const { forceNow, plan } = resetSchedule(acc);
        repos.logEvent('schedule-reset', { account: acc.label, reason: 'manual', forceNow, points: plan.pointCount });
        return send(res, 200, { ok: true, forceNow });
      }
      if (u.pathname === '/api/today/regenerate' && req.method === 'POST') {
        const acc = currentAccount();
        return send(res, 200, { ok: true, ...regenerateToday(acc) });
      }
      if (u.pathname.startsWith('/shot/')) {
        const name = decodeURIComponent(u.pathname.slice(6));
        if (!/^[\w.-]+\.png$/.test(name)) return send(res, 400, { error: 'bad name' });
        const file = path.join(SHOTS_DIR, name);
        if (!fs.existsSync(file)) return send(res, 404, { error: 'not found' });
        res.setHeader('Content-Type', 'image/png');
        return res.end(fs.readFileSync(file));
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      return send(res, e && e.statusCode ? e.statusCode : 500, { ok: false, error: e.message.split('\n')[0] });
    }
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve({ server, url: `http://${host}:${actual}`, port: actual });
    });
  });
}

module.exports = { startServer, configFromDb, dataFromDb, persist, sanitize };
