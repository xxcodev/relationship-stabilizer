/**
 * @file HTTP control panel: renders the UI and exposes the /api endpoints backed by SQLite.
 */
// Dashboard backed by SQLite. Same UI as the prototype, but every value comes from the DB.
const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const env = require('./env');
const repos = require('./repos');
const burstPlanner = require('./burst');
const slowMail = require('./slow-mail');
const autoRead = require('./auto-read');
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

const SHOTS_DIR = path.resolve(env.ROOT, process.env.SHOTS_DIR || env.SHOTS_DIR);

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
const mapTriggerStatus = (status, reason) => {
  if (status === 'skipped' && reason === 'slow-mail') return 'deferred';
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

function seededRandom(seedStr) {
  const hex = crypto.createHash('sha1').update(String(seedStr || '')).digest('hex').slice(0, 8);
  let s = (parseInt(hex, 16) >>> 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// Today's schedule progress for the home page. Stale state from another day is ignored here;
// the scheduler replaces it with a fresh day state.
function scheduleRuntime(acc, day, plan, sends = []) {
  const state = repos.getBurstState(acc.id);
  const live = state && state.day === day && Array.isArray(state.points) ? state : null;
  const weekendActive = Boolean((live && live.weekendMode) || (plan.weekendRandom && burstPlanner.isWeekendDay(day)));
  const byKey = new Map();
  for (const p of live ? live.points : []) {
    if (!p) continue;
    const key = p.mode === 'random' && p.from && p.to ? `r:${p.from}-${p.to}` : `f:${p.time}`;
    if (!byKey.has(key)) byKey.set(key, p);
  }
  const sourcePoints = live && Array.isArray(live.points) && live.points.length
    ? live.points
    : burstPlanner.resolveDayPoints(day, plan, seededRandom(`${day}:${acc.id}:${plan.totalCount}`));
  const points = sourcePoints.map((p) => {
    const sp = byKey.get(triggerKey(p)) || p;
    const normalizedSp = sp && sp.status ? sp : null;
    return {
      mode: p.mode,
      time: p.time,
      from: p.from,
      to: p.to,
      label: triggerText(p, normalizedSp),
      count: Math.max(1, Number((normalizedSp && normalizedSp.count) || p.count) || 1),
      sent: normalizedSp ? Math.max(0, Number(normalizedSp.sent) || 0) : 0,
      status: normalizedSp ? String(normalizedSp.status || 'pending') : 'pending',
      startAt: normalizedSp ? Number(normalizedSp.startAt) || null : null,
      nextAt: normalizedSp ? Number(normalizedSp.nextAt) || null : null,
      lastError: normalizedSp ? String(normalizedSp.lastError || '') : '',
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
  let nextAtMs = null;
  if (open && active) {
    if (active.status === 'running' && active.nextAt) {
      nextAt = clockLabel(active.nextAt);
      nextAtMs = Number(active.nextAt) || null;
    } else if (active.mode === 'fixed') {
      nextAt = active.time;
      nextAtMs = burstPlanner.startAt(day, active.time);
    } else if (active.startAt) {
      nextAt = clockLabel(active.startAt);
      nextAtMs = Number(active.startAt) || null;
    } else {
      nextAt = `${active.from}–${active.to}`;
    }
  } else if (open) {
    const nowMs = Date.now();
    const upcoming = sourcePoints
      .map((p) => ({
        p,
        at: p.mode === 'fixed' ? burstPlanner.startAt(day, p.time) : burstPlanner.startAt(day, p.from),
      }))
      .filter((x) => x.at !== null && x.at >= nowMs)
      .sort((a, b) => a.at - b.at)[0];
    if (upcoming) {
      nextAt = upcoming.p.mode === 'fixed' ? upcoming.p.time : `${upcoming.p.from}–${upcoming.p.to}`;
      if (upcoming.p.mode === 'fixed') nextAtMs = upcoming.at;
    }
  }
  const timeline = points.map((p) => ({
    time: p.status === 'running' && p.nextAt ? clockLabel(p.nextAt) : p.label,
    status: mapTriggerStatus(p.status, p.lastError),
    reason: p.lastError || '',
  }));
  return {
    points,
    pointCount: points.length,
    count: total,
    sent,
    status,
    active: activeIndex,
    nextAt,
    nextAtMs,
    weekendActive,
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

// ---------- 慢递 (ad-hoc slow-mail session) ----------
// Config is per account (slowMail*); runtime state is one JSON blob (slowMailState). The
// scheduler child owns sending; the dashboard only writes pending/stopped and renders progress.

function slowError(status, message) {
  const e = new Error(message);
  e.statusCode = status;
  return e;
}

function schedulerLockUp(label) {
  try {
    const safe = String(label || 'default').replace(/[^a-zA-Z0-9._-]+/g, '_') || 'default';
    const info = JSON.parse(fs.readFileSync(path.join(env.DATA_DIR, 'run', `schedule-${safe}.lock`), 'utf8'));
    const pid = Number(info.pid);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

function slowConfigFromDb(acc) {
  const cfg = slowMail.normalizeConfig({
    durationMin: repos.getAccountSetting(acc.id, 'slowMailDurationMin', slowMail.DEFAULTS.durationMin),
    minGapSec: repos.getAccountSetting(acc.id, 'slowMailMinGapSec', slowMail.DEFAULTS.minGapSec),
    maxGapSec: repos.getAccountSetting(acc.id, 'slowMailMaxGapSec', slowMail.DEFAULTS.maxGapSec),
    bufferSec: repos.getAccountSetting(acc.id, 'slowMailBufferSec', slowMail.DEFAULTS.bufferSec),
    fallbackSec: repos.getAccountSetting(acc.id, 'slowMailFallbackSec', slowMail.DEFAULTS.fallbackSec),
    maxSends: repos.getAccountSetting(acc.id, 'slowMailMaxSends', slowMail.DEFAULTS.maxSends),
    friend: repos.getAccountSetting(acc.id, 'slowMailFriend', ''),
    friendUid: repos.getAccountSetting(acc.id, 'slowMailFriendUid', ''),
    readEnabled: repos.getAccountSetting(acc.id, 'slowMailReadEnabled', '1') !== '0',
  });
  const rows = repos.listFriends(acc.id).filter((f) => f.enabled);
  const byUid = cfg.friendUid ? rows.find((f) => String(f.userid || '') === cfg.friendUid) : null;
  const byName = cfg.friend ? rows.find((f) => f.name === cfg.friend) : null;
  const friend = byUid || byName || rows[0] || null;
  cfg.friend = friend ? friend.name : '';
  cfg.friendUid = friend ? String(friend.userid || cfg.friendUid || '') : '';
  return cfg;
}

function slowFriendsState(acc) {
  const session = apiSession.load(acc.label);
  const api = apiSession.status(session, null);
  const allFriends = repos.listFriends(acc.id);
  const enabled = allFriends.filter((f) => f.enabled);
  const friends = enabled.map((f) => ({
    name: f.name,
    uid: String(f.userid || ''),
    userid: f.userid || '',
    apiCapable: !!f.userid || (api.valid && apiSession.canSendTo(session, f.name)),
    source: 'friend',
  }));
  // The slow-mail recipient list is the union of enabled send friends and every mutual friend
  // from the last sync. Selecting a mutual-only entry adds/enables just that friend at start.
  const cache = repos.getSetting(`mutualFriends:${acc.label}`, null);
  const mutual = Array.isArray(cache && cache.mutual) ? cache.mutual : [];
  const seenUids = new Set(friends.map((f) => f.uid).filter(Boolean));
  const seenNames = new Set(friends.map((f) => f.name));
  const extra = [];
  for (const p of mutual) {
    const uid = String((p && p.uid) || '').trim();
    const name = String((p && p.name) || '').trim();
    if (!uid || !name || seenUids.has(uid) || seenNames.has(name)) continue;
    seenUids.add(uid);
    seenNames.add(name);
    extra.push({ name, uid, userid: uid, apiCapable: true, source: 'mutual' });
  }
  return {
    api,
    friends: [...friends, ...extra],
    present: !!session,
    counts: {
      enabled: enabled.length,
      disabled: allFriends.filter((f) => !f.enabled).length,
      mutual: mutual.length,
      extra: extra.length,
    },
  };
}

function slowStateView(state, now = Date.now()) {
  if (!state) return null;
  return {
    id: state.id,
    status: state.status,
    friend: state.friend,
    friendUid: state.friendUid || '',
    startedAt: state.startedAt,
    endsAt: state.endsAt,
    remainingMs: slowMail.remainingMs(state, now),
    nextAt: state.nextAt || null,
    nextInMs: slowMail.nextInMs(state, now),
    sent: state.sent || 0,
    failed: state.failed || 0,
    maxSends: state.maxSends || 0,
    minGapSec: state.minGapSec,
    maxGapSec: state.maxGapSec,
    bufferSec: state.bufferSec,
    lastAt: state.lastAt || null,
    lastDurationMs: state.lastDurationMs || 0,
    lastTitle: state.lastTitle || '',
    lastError: state.lastError || '',
    doneReason: state.doneReason || '',
    readEnabled: state.readEnabled !== false,
    conversationId: state.conversationId || '',
    conversationShortId: state.conversationShortId || '',
    lastReadAt: state.lastReadAt || null,
    lastReadOk: state.lastReadOk === undefined ? null : state.lastReadOk,
    readError: state.readError || '',
    pausedAt: state.pausedAt || null,
    pausedMs: state.pausedMs || 0,
    stoppedAt: state.stoppedAt || null,
    updatedAt: state.updatedAt || '',
  };
}

function slowView(acc = currentAccount()) {
  const config = slowConfigFromDb(acc);
  const state = repos.getSlowMailState(acc.id);
  const { api, friends, present, counts } = slowFriendsState(acc);
  return {
    config,
    state: slowStateView(state),
    live: slowMail.isLive(state),
    estimate: slowMail.estimate(config),
    friends,
    counts,
    accountEnabled: !!acc.enabled,
    schedulerUp: schedulerLockUp(acc.label),
    api: { present, valid: !!api.valid, reason: api.reason || '', ageHours: api.ageHours },
    videoSource: repos.getAccountSetting(acc.id, 'videoSource', 'pool') === 'recommend' ? 'recommend' : 'pool',
    sendMode: 'api',
  };
}

function startSlowSession(input = {}) {
  input = input && typeof input === 'object' ? input : {};
  const acc = accountFromInput(input);
  if (!acc.enabled) throw slowError(409, '账户已暂停，先点顶部「继续」');
  if (sendJob.status === 'running') throw slowError(409, '手动发送进行中，稍后再开始慢递');
  const existing = repos.getSlowMailState(acc.id);
  if (slowMail.isLive(existing)) throw slowError(409, `已经有一条慢递在跑（发给 ${existing.friend}）`);
  if (!schedulerLockUp(acc.label)) throw slowError(409, '后台调度未运行，慢递不会开始；先启动或重启调度');

  const base = slowConfigFromDb(acc);
  const pick = (key) => (input[key] === undefined || input[key] === null || input[key] === ''
    ? base[key]
    : Number(input[key]));
  const inputFriend = String(input.friend || '').trim();
  const inputUid = String(input.friendUid || input.userid || '').trim();
  const readEnabled = input.readEnabled === undefined || input.readEnabled === null
    ? base.readEnabled !== false
    : (input.readEnabled === true || input.readEnabled === 1 || input.readEnabled === '1' || input.readEnabled === 'true');
  const raw = {
    durationMin: pick('durationMin'),
    minGapSec: pick('minGapSec'),
    maxGapSec: pick('maxGapSec'),
    bufferSec: pick('bufferSec'),
    fallbackSec: pick('fallbackSec'),
    maxSends: pick('maxSends'),
    friend: inputFriend || base.friend || '',
    friendUid: inputUid || (inputFriend ? '' : (base.friendUid || '')),
    readEnabled,
  };
  const limits = [
    ['durationMin', 15, 480, '时长'],
    ['minGapSec', 10, 3600, '间隔下限'],
    ['maxGapSec', 10, 3600, '间隔上限'],
    ['bufferSec', 0, 60, '视频时长让路'],
    ['fallbackSec', 0, 300, '未知时长兜底'],
    ['maxSends', 1, 200, '条数上限'],
  ];
  for (const [key, min, max, label] of limits) {
    const n = Number(raw[key]);
    if (!Number.isFinite(n) || n < min || n > max) throw slowError(400, `${label}需要在 ${min}–${max} 之间`);
  }
  if (Number(raw.maxGapSec) < Number(raw.minGapSec)) throw slowError(400, '间隔上限不能小于下限');

  let friend = (() => {
    const enabled = repos.listFriends(acc.id).filter((f) => f.enabled);
    if (raw.friendUid) {
      const byUid = enabled.find((f) => String(f.userid || '') === raw.friendUid);
      if (byUid) return byUid;
    }
    return enabled.find((f) => f.name === raw.friend) || null;
  })();
  if (!friend && raw.friendUid) {
    const cache = repos.getSetting(`mutualFriends:${acc.label}`, null);
    const mutual = Array.isArray(cache && cache.mutual) ? cache.mutual : [];
    const picked = mutual.find((p) => String((p && p.uid) || '') === raw.friendUid);
    if (picked && picked.uid) {
      try {
        repos.upsertFriendByUid(acc.id, picked.name, String(picked.uid));
        let row = repos.listFriends(acc.id).find((f) => String(f.userid || '') === raw.friendUid);
        if (row && !row.enabled) {
          repos.setFriendEnabled(acc.id, row.id, true);
          row = repos.listFriends(acc.id).find((f) => String(f.userid || '') === raw.friendUid);
        }
        friend = row || null;
        if (friend) {
          repos.logEvent('slow-friend-add', {
            account: acc.label, friend: friend.name, friendUid: friend.userid, source: 'mutual',
          });
        }
      } catch (e) {
        throw slowError(409, `加入互关好友失败：${e.message}`);
      }
    }
  }
  if (!friend) throw slowError(400, '请选择一位发送好友或互关好友');
  if (raw.friendUid && friend.userid && String(friend.userid) !== raw.friendUid) {
    throw slowError(409, '收件人的 UID 与好友记录不一致，请刷新互关后再试');
  }
  if (raw.friendUid && !friend.userid) {
    // Legacy name-only row: attach the UID now so the session can survive a later rename.
    repos.setFriendUserid(acc.id, friend.id, raw.friendUid);
    friend.userid = raw.friendUid;
  }
  raw.friend = friend.name;
  raw.friendUid = raw.friendUid || String(friend.userid || '');
  if (repos.getAccountSetting(acc.id, 'videoSource', 'pool') === 'recommend') {
    if (repos.getAccountSetting(acc.id, 'sendMode', 'auto') === 'browser') {
      throw slowError(400, '推荐源需要把发送模式切到「纯 API 优先」');
    }
    const session = apiSession.load(acc.label);
    const st = apiSession.status(session, null);
    if (!st.valid) throw slowError(400, `默认推荐需要可用的纯 API 会话：${st.reason || '不可用'}`);
    if (!friend.userid && !apiSession.canSendTo(session, friend.name)) {
      throw slowError(400, `好友「${friend.name}」不在纯 API 会话里，也没有 userid；请先刷新会话或换好友`);
    }
  }

  const cfg = slowMail.normalizeConfig({ ...raw, friend: friend.name });
  const state = slowMail.createState({ cfg: { ...cfg, account: acc.label }, nowMs: Date.now() });
  const defaults = {
    slowMailDurationMin: cfg.durationMin,
    slowMailMinGapSec: cfg.minGapSec,
    slowMailMaxGapSec: cfg.maxGapSec,
    slowMailBufferSec: cfg.bufferSec,
    slowMailFallbackSec: cfg.fallbackSec,
    slowMailMaxSends: cfg.maxSends,
    slowMailFriend: cfg.friend,
    slowMailFriendUid: cfg.friendUid,
    slowMailReadEnabled: cfg.readEnabled ? '1' : '0',
  };
  for (const [key, value] of Object.entries(defaults)) repos.setAccountSetting(acc.id, key, value);
  repos.saveSlowMailState(acc.id, state);
  repos.logEvent('slow-request', {
    account: acc.label, sessionId: state.id, friend: state.friend, friendUid: state.friendUid,
    durationMin: cfg.durationMin, minGapSec: cfg.minGapSec, maxGapSec: cfg.maxGapSec,
    maxSends: cfg.maxSends, readEnabled: cfg.readEnabled, endsAt: new Date(state.endsAt).toISOString(),
  });
  return { ok: true, state: slowStateView(state), config: cfg, estimate: slowMail.estimate(cfg) };
}

function stopSlowSession(acc = currentAccount()) {
  const state = repos.getSlowMailState(acc.id);
  if (!state) throw slowError(404, '还没有慢递记录');
  if (!slowMail.isLive(state)) return { ok: true, already: true, state: slowStateView(state) };
  const next = slowMail.stop(state, Date.now());
  repos.saveSlowMailState(acc.id, next);
  repos.logEvent('slow-stop-request', { account: acc.label, sessionId: next.id, sent: next.sent, by: 'panel' });
  return { ok: true, already: false, state: slowStateView(next) };
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
    dailyReadEnabled: (() => { const v = repos.getAccountSetting(acc.id, 'dailyReadEnabled', '1'); return !(v === false || v === 0 || v === '0' || v === 'false'); })(),
    weekendRandomEnabled: (() => { const v = repos.getAccountSetting(acc.id, 'weekendRandomEnabled', true); return !(v === false || v === 0 || v === '0' || v === 'false'); })(),
    sendMode: 'api',
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

function formatSendRow(s) {
  return {
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
  };
}

function resolveNextSend({ enabled, slow, schedule }) {
  if (!enabled) return { text: '已暂停', label: '已暂停', source: 'paused', at: null };
  if (slow && slow.live && slow.state) {
    const st = slow.state;
    if (st.status === 'paused') {
      return { text: '慢递暂停中', label: '慢递暂停中', source: 'slow-paused', at: null };
    }
    if (st.status === 'pending') {
      const t = st.nextAt ? clockLabel(st.nextAt) : '准备中';
      return { text: t, label: '慢递 · ' + t, source: 'slow', at: Number(st.nextAt) || null };
    }
    if (st.nextAt) {
      const t = clockLabel(st.nextAt);
      return { text: t, label: '慢递 · ' + t, source: 'slow', at: Number(st.nextAt) || null };
    }
    return { text: '准备下一条', label: '慢递 · 准备下一条', source: 'slow', at: null };
  }
  if (schedule && schedule.nextAt) {
    const tag = schedule.weekendActive ? '周末随机' : '排班';
    return {
      text: schedule.nextAt,
      label: tag + ' · ' + schedule.nextAt,
      source: schedule.weekendActive ? 'weekend' : 'schedule',
      at: Number(schedule.nextAtMs) || null,
    };
  }
  if (schedule && schedule.status === 'done') {
    return { text: '今日已完成', label: '今日已完成', source: 'done', at: null };
  }
  return { text: '—', label: '—', source: 'none', at: null };
}

function dataFromDb() {
  const acc = currentAccount();
  const day = today();
  const plan = scheduleFromAccount(acc);
  const sends = repos.listSends({ accountId: acc.id, limit: 200 });
  const totalSends = repos.countSends({ accountId: acc.id });
  const totalOkSends = repos.countSends({ accountId: acc.id, ok: true });
  const schedule = scheduleRuntime(acc, day, plan, sends);
  const slow = slowView(acc);
  const nextSend = resolveNextSend({ enabled: !!acc.enabled, slow, schedule });
  return {
    account: acc.label,
    accountName: acc.display_name || acc.label,
    enabled: !!acc.enabled,
    friend: repos.listEnabledFriendNames(acc.id)[0] || acc.friend,
    friends: repos.listEnabledFriendNames(acc.id),
    schedule,
    slow,
    todayPlan: schedule.count,
    todayDone: repos.countSendsByDay(day, acc.id),
    todayTimeline: schedule.timeline,
    nextTime: nextSend.label || nextSend.text,
    nextSend,
    totalSends,
    totalOkSends,
    bucketStats: Object.fromEntries(repos.bucketStats(acc.id).map((r) => [r.bucket || '-', r.n])),
    sends: sends.map(formatSendRow),
    generatedAt: new Date().toISOString(),
  };
}

// one ad-hoc send at a time; the browser profile cannot serve two senders
const sendJob = { id: null, startedAt: null, status: 'idle', result: null, dry: false, account: null };
// Only one manual send may run at a time; there is no post-send time cooldown.
function manualSendBlocked(acc, dry = false) {
  if (dry) return null;
  if (sendJob.status === 'running') return { status: 409, error: '已经有一条在发送中' };
  return null;
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
    // "立即发送一次" means exactly one video. Natural-share batches remain for the daily plan
    // and slow-mail; turning it off here prevents one manual click from producing two records.
    const manualCfg = { ...cfg, naturalShare: false };
    const res = await scheduler.sendOne(manualCfg, { dryRun: dry }).catch((e) => ({ ok: false, error: e.message }));
    sendJob.result = res;
    sendJob.status = res && res.ok ? 'done' : 'failed';
  } catch (e) {
    sendJob.result = { ok: false, error: e.message.split('\n')[0] };
    sendJob.status = 'failed';
  }
  repos.logEvent('manual-send', { dry, status: sendJob.status, result: sendJob.result });
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

function mutualUserFor(acc, name, uid = '') {
  const cache = readMutualCache(acc.label);
  if (!cache) return null;
  const wanted = String(uid || '').trim();
  if (wanted) {
    const byUid = cache.mutual.find((u) => String(u.uid || '').trim() === wanted);
    if (byUid) return byUid;
  }
  return cache.mutual.find((u) => u.name === name) || null;
}

function sessionCookieHeader(session) {
  const cookies = Array.isArray(session && session.cookies) ? session.cookies : [];
  return cookies.filter((c) => c && c.name).map((c) => `${c.name}=${c.value == null ? '' : c.value}`).join('; ');
}

async function fetchDouyinWebJson(session, apiPath, { baseUrl = process.env.DOUYIN_API_BASE || 'https://www.douyin.com', timeoutMs = 15000 } = {}) {
  const cookie = sessionCookieHeader(session);
  if (!cookie) throw new Error('纯 API 会话缺少 cookies，请先导入或刷新会话');
  const url = baseUrl.replace(/\/$/, '') + apiPath;
  const res = await fetch(url, {
    headers: {
      accept: 'application/json, text/plain, */*',
      cookie,
      referer: 'https://www.douyin.com/',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!text || !text.trim()) throw new Error(`接口返回空响应（HTTP ${res.status}），会话可能已过期`);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`接口返回非 JSON（HTTP ${res.status}）`);
  }
}

async function fetchMutualFriends(acc, opts = {}) {
  const session = apiSession.load(acc.label);
  if (!session || !Array.isArray(session.cookies) || !session.cookies.length) {
    throw new Error('没有可用的纯 API 会话，请先在「配置 → 05 高级与维护」导入或刷新会话');
  }
  const common = 'device_platform=webapp&aid=6383&channel=channel_pc_web&pc_client_type=1&source_type=1&count=50';
  const get = (p) => fetchDouyinWebJson(session, p, opts).catch((e) => ({ error: e.message }));
  const prof = await get('/aweme/v1/web/user/profile/self/?' + common);
  if (!prof || !prof.user || !prof.user.sec_uid) {
    throw new Error((prof && (prof.status_msg || prof.error)) || '纯 API 会话未登录或已过期');
  }
  const sec = encodeURIComponent(prof.user.sec_uid);
  const errors = [];
  const collect = async (kind) => {
    const apiPath = kind === 'following' ? '/aweme/v1/web/user/following/list/' : '/aweme/v1/web/user/follower/list/';
    const field = kind === 'following' ? 'followings' : 'followers';
    const out = [];
    const seen = new Set();
    let maxTime = 0;
    let page = 0;
    let scanned = 0;
    let complete = true;
    while (page < 30) {
      const p = apiPath + '?' + common + '&sec_user_id=' + sec + '&max_time=' + maxTime + '&min_time=0&offset=0';
      const j = await get(p);
      if (!j || j.status_code !== 0) {
        errors.push(kind + '：' + String((j && (j.status_msg || j.error)) || '接口失败'));
        complete = false;
        break;
      }
      const list = j[field] || [];
      for (const u of list) {
        const uid = String(u.uid || '');
        const id = uid || String(u.sec_uid || '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        scanned++;
        out.push({
          name: u.nickname || '',
          uid,
          sec_uid: u.sec_uid || '',
          unique_id: u.unique_id || '',
          follow_status: u.follow_status,
          relation_label: u.relation_label || '',
        });
      }
      if (!j.has_more) break;
      const nextMaxTime = Number(j.min_time) || 0;
      if (!nextMaxTime || (maxTime && nextMaxTime >= maxTime)) {
        errors.push(kind + '：分页游标没有进展');
        complete = false;
        break;
      }
      maxTime = nextMaxTime;
      page++;
    }
    return { out, scanned, complete };
  };
  const following = await collect('following');
  const followers = await collect('follower');
  const followingByUid = new Map();
  for (const u of following.out) if (u.uid) followingByUid.set(u.uid, u);
  const followerByUid = new Map();
  for (const u of followers.out) if (u.uid) followerByUid.set(u.uid, u);
  const mutual = [];
  const mutualSeen = new Set();
  for (const u of following.out) {
    if (!u.uid || mutualSeen.has(u.uid)) continue;
    if (followerByUid.has(u.uid) || u.follow_status === 2 || (u.relation_label && String(u.relation_label).includes('好友'))) {
      mutualSeen.add(u.uid);
      mutual.push(u);
    }
  }
  const followingOnly = following.out.filter((u) => u.uid && !followerByUid.has(u.uid));
  const followerOnly = followers.out.filter((u) => u.uid && !followingByUid.has(u.uid));
  const followingTotal = Number(prof.user.following_count) || following.scanned;
  const followersTotal = Number(prof.user.follower_count) || followers.scanned;
  return {
    ok: true,
    self: { nickname: prof.user.nickname, uid: String(prof.user.uid || ''), sec_uid: prof.user.sec_uid },
    mutual,
    followingList: following.out,
    followerList: followers.out,
    following: following.scanned,
    followingTotal,
    followers: followers.scanned,
    followersTotal,
    complete: {
      following: following.complete && following.scanned >= followingTotal,
      followers: followers.complete && followers.scanned >= followersTotal,
    },
    analysis: {
      mutual: mutual.length,
      following: following.scanned,
      followers: followers.scanned,
      followingOnly: followingOnly.length,
      followerOnly: followerOnly.length,
      mutualRate: following.scanned ? Math.round((mutual.length / following.scanned) * 1000) / 10 : null,
    },
    errors,
  };
}

/**
 * Keep existing friend rows current by UID. A rename updates the display name; a name-only
 * legacy row gets its UID attached. New mutuals are never auto-added or auto-enabled.
 */
function syncFriendNamesFromMutual(acc, mutual) {
  const rows = repos.listFriends(acc.id);
  const byUid = new Map(rows.filter((r) => String(r.userid || '').trim()).map((r) => [String(r.userid), r]));
  const byName = new Map(rows.map((r) => [r.name, r]));
  const list = Array.isArray(mutual) ? mutual : [];
  const nameUids = new Map();
  for (const u of list) {
    const uid = String((u && u.uid) || '').trim();
    const name = String((u && u.name) || '').trim();
    if (!uid || !name) continue;
    if (!nameUids.has(name)) nameUids.set(name, new Set());
    nameUids.get(name).add(uid);
  }
  let renamed = 0;
  let linked = 0;
  let conflicts = 0;
  for (const u of list) {
    const uid = String((u && u.uid) || '').trim();
    const name = String((u && u.name) || '').trim();
    if (!uid || !name) continue;
    const row = byUid.get(uid);
    if (row) {
      if (row.name === name) continue;
      const clash = byName.get(name);
      if (clash && clash.id !== row.id) { conflicts++; continue; }
      try {
        repos.updateFriendName(acc.id, row.id, name);
        byName.delete(row.name);
        byName.set(name, { ...row, name });
        row.name = name;
        renamed++;
      } catch (e) {
        conflicts++;
      }
      continue;
    }
    const sameName = byName.get(name);
    if (!sameName) continue;
    // A nickname shared by two different UIDs is not enough to attach a UID: that could link
    // the wrong person. The same person appearing in both lists (same UID) is fine.
    if ((nameUids.get(name) ? nameUids.get(name).size : 0) !== 1) { conflicts++; continue; }
    const oldUid = String(sameName.userid || '').trim();
    if (!oldUid) {
      try {
        repos.setFriendUserid(acc.id, sameName.id, uid);
        byUid.set(uid, { ...sameName, userid: uid });
        linked++;
      } catch (e) {
        conflicts++;
      }
    } else if (oldUid !== uid) {
      conflicts++;
    }
  }
  if (renamed || linked) repos.syncAccountFriend(acc.id);
  return { renamed, linked, conflicts };
}

const MUTUAL_SYNC_DEFAULT_HOURS = 6;
const MUTUAL_SYNC_RETRY_MS = 60 * 60 * 1000;
let mutualSyncTimer = null;
let mutualSyncBusy = false;
let mutualSyncRetryAt = 0;

function mutualSyncHours() {
  const n = Number(repos.getSetting('mutualSyncHours', MUTUAL_SYNC_DEFAULT_HOURS));
  return Number.isFinite(n) && n >= 1 ? Math.min(168, Math.round(n)) : MUTUAL_SYNC_DEFAULT_HOURS;
}

function mutualSyncOn() {
  const v = repos.getSetting('mutualSyncEnabled', true);
  return !(v === false || v === 0 || v === '0' || v === 'false');
}

function mutualSyncDue(acc, now = Date.now()) {
  const cache = readMutualCache(acc.label);
  if (!cache || !cache.fetchedAt) return true;
  const at = Date.parse(cache.fetchedAt);
  if (!Number.isFinite(at)) return true;
  return now - at >= mutualSyncHours() * 3600 * 1000;
}

async function syncMutualFriends(acc, { reason = 'manual', baseUrl } = {}) {
  const out = await fetchMutualFriends(acc, baseUrl ? { baseUrl } : {});
  const cache = saveMutualCache(acc.label, out);
  const people = [...(out.followingList || []), ...(out.followerList || [])];
  const touched = syncFriendNamesFromMutual(acc, people);
  repos.logEvent('mutual-sync', {
    account: acc.label, reason,
    mutual: out.mutual.length, following: out.following, followers: out.followers,
    renamed: touched.renamed, linked: touched.linked, conflicts: touched.conflicts,
    errors: out.errors || [],
  });
  return { ...cache, ok: true, touched };
}

/**
 * Periodic sync: one due account per 15-minute tick. Skip while a manual/slow send is running;
 * a failure backs off for an hour instead of starting a browser every tick.
 */
async function runMutualSyncTick() {
  if (mutualSyncBusy || !mutualSyncOn()) return;
  if (Date.now() < mutualSyncRetryAt) return;
  if (sendJob.status === 'running') return;
  const accounts = repos.listAccounts().filter((a) => a.enabled);
  if (!accounts.length) return;
  const active = activeLabel();
  accounts.sort((a, b) => (a.label === active ? -1 : 0) - (b.label === active ? -1 : 0));
  const acc = accounts.find((a) => mutualSyncDue(a));
  if (!acc) return;
  if (slowMail.isLive(repos.getSlowMailState(acc.id))) return;
  mutualSyncBusy = true;
  try {
    await syncMutualFriends(acc, { reason: 'auto', closeBrowser: true });
    mutualSyncRetryAt = 0;
  } catch (e) {
    mutualSyncRetryAt = Date.now() + MUTUAL_SYNC_RETRY_MS;
    repos.logEvent('mutual-sync-error', {
      account: acc.label, reason: 'auto', error: (e.message || '').split('\n')[0],
    });
  } finally {
    mutualSyncBusy = false;
  }
}

function startMutualSync() {
  if (mutualSyncTimer) return;
  mutualSyncTimer = setInterval(() => { runMutualSyncTick().catch(() => {}); }, 15 * 60 * 1000);
  if (mutualSyncTimer.unref) mutualSyncTimer.unref();
  const first = setTimeout(() => { runMutualSyncTick().catch(() => {}); }, 3 * 60 * 1000);
  if (first.unref) first.unref();
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
  const session = apiSession.load(acc.label);
  const api = apiSession.status(session, null);
  return {
    scheduler: sched,
    mode: 'api',
    api: { present: !!session, valid: !!api.valid, reason: api.reason || null, ageHours: api.ageHours },
    browser: { up: false, disabled: true },
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
    dailyReadEnabled: src.dailyReadEnabled !== false,
    weekendRandomEnabled: src.weekendRandomEnabled !== false,
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
    repos.setAccountSetting(acc.id, 'dailyReadEnabled', cfg.dailyReadEnabled !== false);
    repos.setAccountSetting(acc.id, 'weekendRandomEnabled', cfg.weekendRandomEnabled !== false);
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

function autoReadView(acc = currentAccount()) {
  const slow = slowFriendsState(acc);
  return autoRead.view(acc, { friends: slow.friends, api: slow.api });
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
    const u = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (u.pathname === '/healthz' && req.method === 'GET') {
        return send(res, 200, { ok: true, version: APP_VERSION });
      }
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
        const pools = repos.listPools().map((p) => p.name);
        const html = PAGE.replace('__POOL_NAMES__', JSON.stringify(pools)).replaceAll('__APP_VERSION__', APP_VERSION);
        const etag = '"' + crypto.createHash('sha1').update(html).digest('hex').slice(0, 16) + '"';
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'no-cache');
        if (req.headers['if-none-match'] === etag) {
          res.statusCode = 304;
          return res.end();
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        if (String(req.headers['accept-encoding'] || '').includes('gzip')) {
          res.setHeader('Content-Encoding', 'gzip');
          res.setHeader('Vary', 'Accept-Encoding');
          return res.end(zlib.gzipSync(Buffer.from(html, 'utf8')));
        }
        return res.end(html);
      }
      if (u.pathname === '/api/records' && req.method === 'GET') {
        const acc = currentAccount();
        const day = today();
        const page = Math.max(1, Math.round(Number(u.searchParams.get('page')) || 1));
        const pageSize = Math.min(200, Math.max(1, Math.round(Number(u.searchParams.get('pageSize')) || 20)));
        const search = String(u.searchParams.get('q') || '').trim();
        const bucket = String(u.searchParams.get('bucket') || '').trim();
        const result = String(u.searchParams.get('result') || '').trim();
        const ok = result === 'ok' ? true : (result === 'failed' ? false : null);
        const filterTotal = repos.countSends({ accountId: acc.id, bucket, ok, search });
        const totalPages = Math.max(1, Math.ceil(filterTotal / pageSize));
        const safePage = Math.min(page, totalPages);
        const items = repos.querySends({
          accountId: acc.id, bucket, ok, search, limit: pageSize, offset: (safePage - 1) * pageSize,
        }).map(formatSendRow);
        const allTotal = repos.countSends({ accountId: acc.id });
        const okCount = repos.countSends({ accountId: acc.id, ok: true });
        return send(res, 200, {
          ok: true,
          account: acc.label,
          items,
          total: filterTotal,
          allTotal,
          okCount,
          failCount: Math.max(0, allTotal - okCount),
          todayDone: repos.countSendsByDay(day, acc.id),
          buckets: repos.listSendBuckets(acc.id),
          page: safePage,
          pageSize,
          totalPages,
        });
      }
      if (u.pathname === '/api/records/export.csv' && req.method === 'GET') {
        const acc = currentAccount();
        const search = String(u.searchParams.get('q') || '').trim();
        const bucket = String(u.searchParams.get('bucket') || '').trim();
        const result = String(u.searchParams.get('result') || '').trim();
        const ok = result === 'ok' ? true : (result === 'failed' ? false : null);
        const rows = repos.querySends({ accountId: acc.id, bucket, ok, search, limit: 5000, offset: 0 }).map(formatSendRow);
        const head = ['时间', '分类', '标题', '作者', '好友', '赞', '结果', '截图'];
        const escCsv = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
        const lines = [
          head.map(escCsv).join(','),
          ...rows.map((s) => [
            s.local, s.bucket, s.title, s.author, s.friend || '', s.likes,
            s.ok ? (s.toast || '成功') : (s.toast || '失败'), s.shot || '',
          ].map(escCsv).join(',')),
        ];
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="heartbeat-sends-${today()}.csv"`);
        return res.end('\ufeff' + lines.join('\n'));
      }
      if (u.pathname === '/api/read-records' && req.method === 'GET') {
        const acc = currentAccount();
        const day = today();
        const page = Math.max(1, Math.round(Number(u.searchParams.get('page')) || 1));
        const pageSize = Math.min(200, Math.max(1, Math.round(Number(u.searchParams.get('pageSize')) || 20)));
        const search = String(u.searchParams.get('q') || '').trim().toLowerCase();
        const kind = String(u.searchParams.get('kind') || '').trim();
        const result = String(u.searchParams.get('result') || '').trim();
        const kindLabels = { auto: '定时自动已读', daily: '发送后已读', slow: '慢递已读' };
        const all = repos
          .listReadEvents(1000)
          .map((row) => {
            let payload = {};
            try { payload = JSON.parse(row.payload || '{}') || {}; } catch (e) {}
            const accountLabel = payload.account ? String(payload.account) : '';
            if (accountLabel && accountLabel !== acc.label) return null;
            const k = row.event.startsWith('auto-') ? 'auto' : (row.event.startsWith('daily-') ? 'daily' : 'slow');
            const ok = !row.event.endsWith('-fail');
            const friends = Array.isArray(payload.friends)
              ? payload.friends.filter(Boolean)
              : (payload.friend ? [String(payload.friend)] : []);
            const localDay = new Date(row.ts).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
            const local = new Date(row.ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
            return {
              id: row.id,
              ts: row.ts,
              local,
              day: localDay,
              kind: k,
              kindLabel: kindLabels[k] || row.event,
              event: row.event,
              ok,
              friends,
              friendText: friends.join('、') || '-',
              count: Number(payload.count) || friends.length || 1,
              conversationId: String(payload.conversationId || ''),
              nextAt: payload.nextAt ? new Date(payload.nextAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '',
              error: String(payload.error || ''),
            };
          })
          .filter(Boolean);
        const allTotal = all.length;
        const okCount = all.filter((x) => x.ok).length;
        const failCount = allTotal - okCount;
        const todayCount = all.filter((x) => x.ok && x.day === day).length;
        const filtered = all.filter((item) => {
          if (kind && item.kind !== kind) return false;
          if (result === 'ok' && !item.ok) return false;
          if (result === 'failed' && item.ok) return false;
          if (search) {
            const hay = `${item.friendText} ${item.kindLabel} ${item.conversationId} ${item.error}`.toLowerCase();
            if (!hay.includes(search)) return false;
          }
          return true;
        });
        const total = filtered.length;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const safePage = Math.min(page, totalPages);
        const offset = (safePage - 1) * pageSize;
        return send(res, 200, {
          ok: true,
          account: acc.label,
          items: filtered.slice(offset, offset + pageSize),
          total,
          allTotal,
          okCount,
          failCount,
          todayCount,
          page: safePage,
          pageSize,
          totalPages,
        });
      }
      if (u.pathname === '/viewer' || u.pathname === '/viewer.html') {
        const file = path.join(env.ROOT, 'app', 'viewer.html');
        if (!fs.existsSync(file)) return send(res, 404, { error: 'viewer not found' });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(fs.readFileSync(file));
      }
      if (u.pathname === '/api/data') return send(res, 200, dataFromDb());
      if (u.pathname === '/api/slow' && req.method === 'GET') {
        return send(res, 200, { ok: true, ...slowView() });
      }
      if (u.pathname === '/api/slow/start' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const input = body ? JSON.parse(body) : {};
        return send(res, 202, startSlowSession(input));
      }
      if (u.pathname === '/api/slow/stop' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const input = body ? JSON.parse(body) : {};
        return send(res, 200, stopSlowSession(accountFromInput(input)));
      }
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
        if (slowMail.isLive(repos.getSlowMailState(acc.id))) {
          return send(res, 409, { ok: false, error: '慢递进行中，先收束再手动发送' });
        }
        const blocked = manualSendBlocked(acc, dry);
        if (blocked) return send(res, blocked.status, { ok: false, error: blocked.error });
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
          sendMode: 'api',
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
      if (u.pathname === '/api/auto-read' && req.method === 'GET') {
        return send(res, 200, autoReadView());
      }
      if (u.pathname === '/api/auto-read' && req.method === 'POST') {
        const acc = currentAccount();
        let body = '';
        for await (const c of req) body += c;
        const input = body ? JSON.parse(body) : {};
        const previous = autoRead.config(acc);
        const enabled = input.enabled === undefined ? previous.enabled : input.enabled !== false;
        const rawFriends = input.friends === undefined ? previous.friends : input.friends;
        const seen = new Set();
        const friends = (Array.isArray(rawFriends) ? rawFriends : [])
          .map((f) => ({
            uid: String((f && (f.uid || f.userid)) || '').trim(),
            name: String((f && f.name) || '').trim(),
          }))
          .filter((f) => {
            if (!/^\d+$/.test(f.uid) || seen.has(f.uid)) return false;
            seen.add(f.uid);
            if (!f.name) f.name = f.uid;
            return true;
          });
        if (enabled && !friends.length) return send(res, 400, { ok: false, error: '开启自动已读前至少选择一位好友' });
        const clamp = (v, min, max, def) => {
          const n = Math.round(Number(v));
          if (!Number.isFinite(n)) return def;
          return Math.min(max, Math.max(min, n));
        };
        const minMin = clamp(input.minMin, autoRead.MIN_MIN_MIN, autoRead.MAX_MIN_MIN, autoRead.DEFAULT_MIN_MIN);
        const maxMin = clamp(input.maxMin, minMin, autoRead.MAX_MIN_MIN, autoRead.DEFAULT_MAX_MIN);
        const time = (v, def) => (/^\d{1,2}:\d{2}$/.test(String(v || '').trim()) ? String(v).trim() : def);
        const windowEnabled = input.windowEnabled === undefined ? previous.windowEnabled : !!input.windowEnabled;
        const windowStart = time(input.windowStart, previous.windowStart || autoRead.DEFAULT_WINDOW_START);
        const windowEnd = time(input.windowEnd, previous.windowEnd || autoRead.DEFAULT_WINDOW_END);
        const windowIntervalMin = clamp(input.windowIntervalMin, 1, autoRead.MAX_MIN_MIN, autoRead.DEFAULT_WINDOW_INTERVAL_MIN);
        const outside = String(input.outside || previous.outside || 'random') === 'pause' ? 'pause' : 'random';
        repos.setAccountSetting(acc.id, 'autoReadEnabled', !!enabled);
        repos.setAccountSetting(acc.id, 'autoReadFriends', friends);
        repos.setAccountSetting(acc.id, 'autoReadMinMin', minMin);
        repos.setAccountSetting(acc.id, 'autoReadMaxMin', Math.max(minMin, maxMin));
        repos.setAccountSetting(acc.id, 'autoReadWindowEnabled', !!windowEnabled);
        repos.setAccountSetting(acc.id, 'autoReadWindowStart', windowStart);
        repos.setAccountSetting(acc.id, 'autoReadWindowEnd', windowEnd);
        repos.setAccountSetting(acc.id, 'autoReadWindowIntervalMin', windowIntervalMin);
        repos.setAccountSetting(acc.id, 'autoReadOutside', outside);
        autoRead.clearState(acc);
        repos.logEvent('auto-read-config', {
          account: acc.label,
          enabled: !!enabled,
          friends: friends.map((f) => f.name),
          friendUids: friends.map((f) => f.uid),
          minMin,
          maxMin,
          windowEnabled: !!windowEnabled,
          windowStart,
          windowEnd,
          windowIntervalMin,
          outside,
        });
        return send(res, 200, autoReadView(acc));
      }
      if (u.pathname === '/api/auto-read/now' && req.method === 'POST') {
        const acc = currentAccount();
        const result = await autoRead.tick(acc, { force: true });
        return send(res, 200, { ...autoReadView(acc), ok: !!result.ok, error: result.error, result });
      }
      if (u.pathname === '/api/api-session/import' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const input = JSON.parse(body || '{}') || {};
        const acc = accountFromInput(input);
        let payload = input.session && typeof input.session === 'object' ? input.session : input;
        if (typeof input.raw === 'string' && input.raw.trim()) {
          try { payload = JSON.parse(input.raw); } catch (e) { return send(res, 400, { ok: false, error: '会话 JSON 格式无效' }); }
        }
        if (!payload || !Array.isArray(payload.cookies) || !payload.cookies.length) {
          return send(res, 400, { ok: false, error: '会话 JSON 缺少有效的 cookies 数组' });
        }
        const session = {
          ...payload,
          account: acc.label,
          accountName: acc.display_name || payload.accountName || acc.label,
          createdAt: payload.createdAt || new Date().toISOString(),
        };
        apiSession.save(session, acc.label);
        repos.logEvent('api-session-import', { account: acc.label, cookies: session.cookies.length, hasTemplate: !!(session.template && session.template.bodyB64) });
        const st = apiSession.status(session, null);
        return send(res, 200, { ok: true, valid: st.valid, reason: st.reason || null, cookies: session.cookies.length });
      }
      if (u.pathname === '/api/api-session/mode' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const input = JSON.parse(body || '{}') || {};
        if (input.mode === 'browser') return send(res, 400, { ok: false, error: '已全面切换为纯 API 模式，不再支持浏览器发送' });
        const acc = accountFromInput(input);
        repos.setAccountSetting(acc.id, 'sendMode', 'api');
        repos.logEvent('send-mode', { account: acc.label, mode: 'api' });
        return send(res, 200, { ok: true, mode: 'api', account: acc.label, restarted: false });
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
      const poolsWithMeta = (accountId) => {
        const builtinSet = new Set(require('./pools').POOLS.map((p) => p.name));
        return repos.listAccountPools(accountId).map((p) => ({ ...p, builtin: builtinSet.has(p.name) }));
      };
      if (u.pathname === '/api/pools' && req.method === 'GET') {
        const acc = currentAccount();
        return send(res, 200, { account: acc.label, pools: poolsWithMeta(acc.id) });
      }
      if (u.pathname === '/api/pools' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const input = JSON.parse(body || '{}') || {};
        const acc = accountFromInput(input);
        const name = String(input.name || '').trim().slice(0, 40);
        if (!name) return send(res, 400, { ok: false, error: '分类名不能为空' });
        const keyword = String(input.keyword || '').trim().slice(0, 80) || name;
        if (repos.listPools().some((p) => p.name === name)) {
          return send(res, 409, { ok: false, error: '分类「' + name + '」已存在' });
        }
        const row = repos.addPool({ name, keyword, parentName: null, enabled: false });
        repos.setAccountPoolEnabled(acc.id, row.name, true);
        repos.logEvent('pool-add', { account: acc.label, name: row.name, keyword: row.keyword });
        return send(res, 200, { ok: true, pool: row, pools: poolsWithMeta(acc.id) });
      }
      if (u.pathname === '/api/pools' && req.method === 'DELETE') {
        let body = '';
        for await (const c of req) body += c;
        const input = JSON.parse(body || '{}') || {};
        const acc = accountFromInput(input);
        const name = String(input.name || u.searchParams.get('name') || '').trim();
        if (!name) return send(res, 400, { ok: false, error: '缺少分类名称' });
        const { POOLS } = require('./pools');
        if (POOLS.some((p) => p.name === name)) {
          return send(res, 400, { ok: false, error: '内置基础分类不支持删除，取消勾选即可' });
        }
        const out = repos.deletePool(name);
        if (!out.deleted) return send(res, 404, { ok: false, error: '分类不存在' });
        repos.logEvent('pool-delete', { account: acc.label, name: out.name, children: out.children });
        return send(res, 200, { ok: true, deleted: out.name, children: out.children, pools: poolsWithMeta(acc.id) });
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
          return send(res, 200, { ok: true, model: out.model, categories: added, pools: poolsWithMeta(acc.id) });
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
        try {
          if (userid) repos.upsertFriendByUid(acc.id, name, userid);
          else repos.addFriend(acc.id, name);
        } catch (e) {
          return send(res, 409, { ok: false, error: e.message });
        }
        repos.logEvent('friend-add', { account: acc.label, name, userid: userid || undefined });
        return send(res, 200, { ok: true, friends: repos.listFriends(acc.id) });
      }
      if (u.pathname === '/api/friends/batch' && req.method === 'POST') {
        const acc = currentAccount();
        let body = '';
        for await (const c of req) body += c;
        const input = JSON.parse(body || '{}') || {};
        const list = Array.isArray(input.friends) ? input.friends : [];
        if (!list.length) return send(res, 400, { ok: false, error: '没有可添加的好友' });
        const out = repos.batchAddFriends(acc.id, list);
        repos.logEvent('friend-batch-add', { account: acc.label, added: out.added, failed: out.failed });
        return send(res, 200, { ok: true, ...out });
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
        repos.logEvent('account-add-qr', { label: acc.label, port: acc.port, mode: process.env.DF_APP_BRIDGE_URL ? 'electron' : 'external' });
        let mode = 'external';
        if (process.env.DF_APP_BRIDGE_URL) {
          try {
            const br = await fetch(`${process.env.DF_APP_BRIDGE_URL}/qr-login`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-bridge-token': process.env.DF_APP_BRIDGE_TOKEN || '',
              },
              body: JSON.stringify({ label: acc.label, name: wanted || acc.display_name || acc.label, friend, isNew: true }),
              signal: AbortSignal.timeout(5000),
            });
            const bd = await br.json().catch(() => ({}));
            if (!br.ok || !bd.ok) throw new Error(bd.error || `HTTP ${br.status}`);
            mode = 'electron';
          } catch (e) {
            return send(res, 502, { ok: false, error: '打开应用内扫码窗口失败：' + e.message });
          }
        } else {
          try { startBrowserFor(acc); } catch (e) {}
        }
        const restarted = service.restartScheduler();
        return send(res, 200, {
          ok: true,
          mode,
          account: { label: acc.label, name, port: acc.port, profile: acc.profile_dir },
          restarted,
        });
      }
      if (u.pathname === '/api/accounts/qr-status' && req.method === 'GET') {
        const label = String(u.searchParams.get('label') || '').trim();
        if (!label) return send(res, 400, { ok: false, error: '缺少 label' });
        const acc = repos.getAccount(label);
        let bridgeState = null;
        if (process.env.DF_APP_BRIDGE_URL) {
          try {
            const br = await fetch(`${process.env.DF_APP_BRIDGE_URL}/qr-status?label=${encodeURIComponent(label)}`, {
              headers: { 'x-bridge-token': process.env.DF_APP_BRIDGE_TOKEN || '' },
              signal: AbortSignal.timeout(3000),
            });
            if (br.ok) bridgeState = await br.json();
          } catch (e) {}
        }
        const sess = apiSession.load(label);
        const nickname = (bridgeState && bridgeState.nickname) || (sess && sess.accountName) || (acc && acc.display_name) || '';
        const hasCookies = Boolean((bridgeState && bridgeState.hasCookies) || (sess && Array.isArray(sess.cookies) && sess.cookies.length));
        return send(res, 200, {
          ok: true,
          label,
          status: (bridgeState && bridgeState.status) || (hasCookies ? 'done' : 'waiting'),
          nickname,
          accountName: (acc && acc.display_name) || nickname || label,
          hasCookies,
          hasFeed: Boolean((bridgeState && bridgeState.hasFeed) || (sess && sess.feedUrl)),
          hasSearch: Boolean((bridgeState && bridgeState.hasSearch) || (sess && sess.searchUrl)),
          error: (bridgeState && bridgeState.error) || '',
        });
      }
      if ((u.pathname === '/api/accounts' && req.method === 'DELETE') || (u.pathname === '/api/accounts/delete' && req.method === 'POST')) {
        let body = '';
        for await (const c of req) body += c;
        const input = body ? JSON.parse(body) : {};
        const label = String(input.label || u.searchParams.get('label') || '').trim();
        if (!label) return send(res, 400, { ok: false, error: '缺少账户标识' });
        let out;
        try {
          out = repos.deleteAccount(label);
        } catch (e) {
          return send(res, 400, { ok: false, error: e.message });
        }
        if (!out.deleted) return send(res, 404, { ok: false, error: '账户不存在' });
        apiSession.clearAccount(out.label);
        if (process.env.DF_APP_BRIDGE_URL) {
          await fetch(`${process.env.DF_APP_BRIDGE_URL}/clear-partition`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-bridge-token': process.env.DF_APP_BRIDGE_TOKEN || '',
            },
            body: JSON.stringify({ label: out.label }),
            signal: AbortSignal.timeout(2000),
          }).catch(() => {});
        }
        repos.logEvent('account-delete', { label: out.label, name: out.name, nextActive: out.nextActive });
        const restarted = service.restartScheduler();
        return send(res, 200, {
          ok: true,
          deleted: out.label,
          name: out.name,
          active: out.nextActive || currentAccount().label,
          restarted,
        });
      }
      if (u.pathname === '/api/accounts/detect-name' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const input = JSON.parse(body || '{}');
        const acc = input.label ? repos.getAccount(String(input.label)) : currentAccount();
        if (!acc) return send(res, 404, { ok: false, error: '账户不存在' });
        const session = apiSession.load(acc.label);
        if (!session || !Array.isArray(session.cookies) || !session.cookies.length) {
          return send(res, 200, { ok: true, loggedIn: false, reason: '没有可用的纯 API 会话，请先在「配置 → 05 高级与维护」导入或刷新会话' });
        }
        let profile = null;
        try {
          const j = await fetchDouyinWebJson(session, '/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383&channel=channel_pc_web&publish_video_strategy_type=2&source=channel_pc_web', { timeoutMs: 8000 });
          profile = { status: j.status_code, nickname: j.user && j.user.nickname, uid: j.user && j.user.uid, error: j.status_msg };
        } catch (e) {
          return send(res, 200, { ok: true, loggedIn: false, reason: '纯 API 读取登录状态失败：' + e.message.split('\n')[0] });
        }
        if (!profile || profile.status !== 0 || !profile.nickname) {
          return send(res, 200, { ok: true, loggedIn: false, reason: profile && profile.error ? profile.error : '会话未登录或已过期' });
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
        const hours = mutualSyncHours();
        const fresh = Number.isFinite(ageMs) && ageMs < hours * 60 * 60 * 1000;
        return send(res, 200, cache
          ? { ok: true, cached: true, stale: !fresh, syncHours: hours, autoSync: mutualSyncOn(), ...cache }
          : {
            ok: true, cached: false, label: acc.label, mutual: [], followingList: [], followerList: [],
            errors: [], syncHours: hours, autoSync: mutualSyncOn(),
          });
      }
      if (u.pathname === '/api/accounts/mutual-friends' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const input = JSON.parse(body || '{}');
        const acc = input.label ? repos.getAccount(String(input.label)) : currentAccount();
        if (!acc) return send(res, 404, { ok: false, error: '账户不存在' });
        if (mutualSyncBusy) return send(res, 409, { ok: false, error: '互关同步正在进行中，稍后再试' });
        mutualSyncBusy = true;
        try {
          const out = await syncMutualFriends(acc, { reason: 'manual' });
          mutualSyncRetryAt = 0;
          return send(res, 200, {
            ...out, ok: true, cached: true, stale: false,
            syncHours: mutualSyncHours(), autoSync: mutualSyncOn(),
            errors: out.errors || [],
          });
        } catch (e) {
          return send(res, 500, { ok: false, error: e.message.split('\n')[0] });
        } finally {
          mutualSyncBusy = false;
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
        const sendCounts = repos.countSendsByAccount();
        const accounts = rows.map((a) => {
          const sched = scheduleConfig.fromAccount(a);
          const enabledFriends = repos.listEnabledFriendNames(a.id);
          return {
            id: a.id,
            label: a.label,
            name: a.display_name || a.label,
            port: a.port,
            friend: enabledFriends[0] || a.friend,
            friends: enabledFriends,
            enabled: !!a.enabled,
            profile: a.profile_dir,
            points: sched.pointCount,
            dailyTotal: sched.totalCount,
            sends: sendCounts[a.id] || 0,
          };
        });
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
      if (u.pathname === '/api/config/copy' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const input = JSON.parse(body || '{}') || {};
        const fromLabel = String(input.fromAccount || '').trim();
        if (!fromLabel) return send(res, 400, { ok: false, error: '请选择来源账户' });
        const fromAcc = repos.getAccount(fromLabel);
        if (!fromAcc) return send(res, 404, { ok: false, error: `来源账户不存在: ${fromLabel}` });
        const toAcc = accountFromInput({ account: input.toAccount || input.account });
        if (fromAcc.id === toAcc.id) return send(res, 400, { ok: false, error: '不能从当前账户复制到自己' });
        const stats = repos.copyAccountConfig(fromAcc.id, toAcc.id);
        repos.logEvent('config-copy', { from: fromAcc.label, to: toAcc.label, ...stats });
        return send(res, 200, { ok: true, ...stats, config: configFromDb(toAcc) });
      }
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
          weekendRandom: cfg.weekendRandomEnabled !== false,
        });
        const est = burstPlanner.estimate(plan);
        const last = est.points[est.points.length - 1];
        const day = today();
        const weekendActive = !!(plan.weekendRandom && burstPlanner.isWeekendDay(day));
        const weekendPlan = plan.weekendRandom
          ? { ...plan, points: burstPlanner.weekendClusters(plan) }
          : null;
        const weekendEst = weekendPlan ? burstPlanner.estimate(weekendPlan) : null;
        return send(res, 200, {
          ok: true,
          mode: 'schedule',
          points: est.points,
          pointCount: plan.pointCount,
          count: est.totalCount,
          requested: est.totalCount,
          summary: burstPlanner.summary(plan),
          estimate: { perSec: est.perSec, totalMinutes: est.totalMinutes, end: last ? last.end : '' },
          weekendRandomEnabled: !!plan.weekendRandom,
          weekendActive,
          weekendPoints: weekendEst ? weekendEst.points : [],
          weekendSummary: weekendPlan ? burstPlanner.summary(weekendPlan) : '',
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
        if (slowMail.isLive(repos.getSlowMailState(acc.id))) {
          return send(res, 409, { ok: false, error: '慢递进行中，先收束再重置今日计划' });
        }
        const { forceNow, plan } = resetSchedule(acc);
        repos.logEvent('schedule-reset', { account: acc.label, reason: 'manual', forceNow, points: plan.pointCount });
        return send(res, 200, { ok: true, forceNow });
      }
      if (u.pathname === '/api/today/regenerate' && req.method === 'POST') {
        const acc = currentAccount();
        if (slowMail.isLive(repos.getSlowMailState(acc.id))) {
          return send(res, 409, { ok: false, error: '慢递进行中，先收束再重置今日计划' });
        }
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
      startMutualSync();
      resolve({ server, url: `http://${host}:${actual}`, port: actual });
    });
  });
}

module.exports = {
  startServer, configFromDb, dataFromDb, persist, sanitize,
  syncFriendNamesFromMutual, syncMutualFriends, runMutualSyncTick,
};
