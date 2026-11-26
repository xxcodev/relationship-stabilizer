/**
 * @file Scheduler loop: reads config from SQLite, plans the day, drives browser-server, writes results back.
 */
// Scheduler: reads its whole configuration from SQLite, drives the browser server,
// and records plans/sends back into SQLite.
const { spawn } = require('child_process');
const path = require('path');
const env = require('./env');
const repos = require('./repos');
const burstPlanner = require('./burst');
const scheduleConfig = require('./schedule');
const { chooseKeyword } = require('./pools');
const picker = require('./picker');
const apiSender = require('./api-sender');
const apiSession = require('./api-session');
const friendPicker = require('./friend-picker');
const videoPicker = require('./video-picker');
const aiRanker = require('./ai/ranker');
const commentReader = require('./comments');
const naturalAi = require('./ai/natural');

const sleep = picker.sleep;
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function runtimeConfig(accountLabel = process.env.ACCOUNT || null) {
  const acc = repos.getAccount(accountLabel || repos.getSetting('activeAccount', null));
  if (!acc) throw new Error('no account configured');
  const num = (value, dflt) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : dflt;
  };
  const cfg = {
    enabled: !!acc.enabled,
    // The unified schedule: trigger points + shared second-level pacing.
    schedule: scheduleConfig.fromAccount(acc),
    friend: acc.friend,
    accountId: acc.id,
    accountLabel: acc.label,
    accountName: acc.display_name || acc.label,
    profileDir: env.browserProfileDir(acc.profile_dir),
    port: acc.port,
    pools: repos
      .listAccountPools(acc.id)
      .map((p) => ({ name: p.name, keyword: p.keyword, enabled: !!p.enabled })),
    banWords: repos.getAccountSetting(acc.id, 'banWords', []),
    metricFilters: (() => {
      const thresholds = videoPicker.normalizeMetricFilters({
        minLikes: repos.getAccountSetting(acc.id, 'filterMinLikes', 0),
        minComments: repos.getAccountSetting(acc.id, 'filterMinComments', 0),
        minFavorites: repos.getAccountSetting(acc.id, 'filterMinFavorites', 0),
        minShares: repos.getAccountSetting(acc.id, 'filterMinShares', 0),
      });
      const switches = videoPicker.normalizeFilterSwitches({
        likesEnabled: repos.getAccountSetting(acc.id, 'filterLikesEnabled', null),
        commentsEnabled: repos.getAccountSetting(acc.id, 'filterCommentsEnabled', null),
        favoritesEnabled: repos.getAccountSetting(acc.id, 'filterFavoritesEnabled', null),
        sharesEnabled: repos.getAccountSetting(acc.id, 'filterSharesEnabled', null),
      }, thresholds);
      return {
        ...thresholds,
        likesEnabled: switches.likes,
        commentsEnabled: switches.comments,
        favoritesEnabled: switches.favorites,
        sharesEnabled: switches.shares,
      };
    })(),
  };
  const maxVideoAgeDays = Number(repos.getAccountSetting(acc.id, 'maxVideoAgeDays', 7));
  cfg.maxVideoAgeDays = Number.isFinite(maxVideoAgeDays) ? Math.min(30, Math.max(1, Math.round(maxVideoAgeDays))) : 7;
  const recommendMaxAgeDays = Number(repos.getAccountSetting(acc.id, 'recommendMaxAgeDays', 30));
  cfg.recommendMaxAgeDays = Number.isFinite(recommendMaxAgeDays) ? Math.min(365, Math.max(0, Math.round(recommendMaxAgeDays))) : 30;
  const ageEnabledRaw = repos.getAccountSetting(acc.id, 'filterAgeEnabled', true);
  cfg.ageEnabled = !(ageEnabledRaw === false || ageEnabledRaw === 0 || ageEnabledRaw === '0' || ageEnabledRaw === 'false');
  cfg.poolDelayMs = repos.getAccountSetting(acc.id, 'poolDelayMs', 2500);
  // 'auto' = try the pure-HTTP path first, fall back to the browser (pool source only);
  // 'browser' = old behavior. Recommendation source is API-only.
  const sendMode = repos.getAccountSetting(acc.id, 'sendMode', 'auto');
  cfg.sendMode = sendMode === 'browser' ? 'browser' : 'auto';
  const videoSource = repos.getAccountSetting(acc.id, 'videoSource', 'pool');
  cfg.videoSource = videoSource === 'recommend' ? 'recommend' : 'pool';
  cfg.aiMode = repos.getAccountSetting(acc.id, 'aiMode', 'off');
  const naturalRaw = repos.getAccountSetting(acc.id, 'naturalShare', false);
  cfg.naturalShare = naturalRaw === true || naturalRaw === 1 || naturalRaw === '1' || naturalRaw === 'true';
  const naturalTextRaw = repos.getAccountSetting(acc.id, 'naturalText', true);
  cfg.naturalText = !(naturalTextRaw === false || naturalTextRaw === 0 || naturalTextRaw === '0' || naturalTextRaw === 'false');
  cfg.friendRows = repos
    .listFriends(acc.id)
    .filter((f) => f.enabled)
    .map((f) => ({ name: f.name, userid: f.userid || '' }));
  if (!cfg.friendRows.length && acc.friend) cfg.friendRows = [{ name: acc.friend, userid: '' }];
  cfg.friends = cfg.friendRows.map((f) => f.name);
  cfg.friend = cfg.friends[0] || acc.friend || '';
  return cfg;
}

const baseOf = (cfg) => `http://127.0.0.1:${cfg.port}`;

// Rotate friends by their successful sends today: everyone gets a turn before anyone gets
// a second message. When all friends have been used, another evenly spread round starts.
function chooseFriendToday(cfg, names) {
  const last = repos.listSends({ accountId: cfg.accountId, limit: 1 })[0];
  return friendPicker.chooseFriend(
    names,
    repos.friendSendCounts(cfg.accountId, ymd(new Date())),
    Math.random,
    last && last.friend
  );
}

function recentVideoHistory(accountId) {
  return videoPicker.buildHistory(repos.listRecentSentVideos(accountId, videoPicker.DEFAULT_HISTORY_DAYS));
}

async function aiRankCandidates(cfg, candidates, source) {
  const ranked = await aiRanker.rankCandidates(candidates, {
    mode: cfg.aiMode,
    interests: cfg.pools.filter((p) => p.enabled).map((p) => p.name),
    banWords: cfg.banWords,
  });
  if (ranked.used) {
    repos.logEvent('ai-rank', { account: cfg.accountLabel, model: ranked.model, kept: ranked.candidates.length, reason: ranked.reason, source });
  } else if (cfg.aiMode && cfg.aiMode !== 'off') {
    repos.logEvent('ai-fallback', { account: cfg.accountLabel, mode: cfg.aiMode, reason: ranked.reason, source });
  }
  return ranked;
}

async function serverUp(cfg) {
  try {
    const r = await fetch(baseOf(cfg) + '/state', { signal: AbortSignal.timeout(4000) });
    return await r.json();
  } catch (e) {
    return null;
  }
}

async function startServer(cfg) {
  if (await serverUp(cfg)) return true;
  const child = spawn(
    process.execPath,
    [path.join(__dirname, 'browser-server.js'), '--profile', cfg.profileDir, '--port', String(cfg.port)],
    { detached: true, stdio: 'ignore', cwd: env.ROOT, windowsHide: true }
  );
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    if (await serverUp(cfg)) return true;
  }
  repos.logEvent('server-start-failed', { port: cfg.port });
  return false;
}

async function stopServer(cfg) {
  try {
    await fetch(baseOf(cfg) + '/quit', { method: 'POST', signal: AbortSignal.timeout(5000) });
  } catch (e) {}
  for (let i = 0; i < 20; i++) {
    await sleep(700);
    if (!(await serverUp(cfg))) return true;
  }
  return false;
}

async function naturalCandidates(cfg, session, source, pool, history) {
  let candidates;
  let bucket;
  const ids = history.ids instanceof Set ? history.ids : new Set((history.ids || []).map(String));
  const titles = history.titles instanceof Set ? history.titles : new Set((history.titles || []).map(videoPicker.normalizeTitle));
  if (source === 'recommend') {
    const collected = await apiSender.collectFeedCandidates(session, {
      banWords: cfg.banWords,
      excludeVideoIds: ids,
      excludeTitles: titles,
      maxAgeDays: cfg.ageEnabled ? cfg.recommendMaxAgeDays : 0,
      filters: cfg.metricFilters,
    });
    candidates = collected.candidates;
    bucket = '默认推荐';
  } else {
    const keyword = (() => {
      const value = chooseKeyword(pool);
      return value.startsWith('@') ? pool.name : value;
    })();
    const collected = await apiSender.collectSearchCandidates(session, {
      keyword,
      banWords: cfg.banWords,
      maxAgeDays: cfg.ageEnabled ? cfg.maxVideoAgeDays : 0,
      filters: cfg.metricFilters,
    });
    candidates = collected.candidates;
    bucket = pool.name;
  }
  const fresh = candidates.filter((c) => {
    const id = String(c.awemeId || c.videoId || '');
    return (!id || !ids.has(id)) && (!c.title || !titles.has(videoPicker.normalizeTitle(c.title)));
  });
  const ranked = await aiRankCandidates(cfg, fresh.length ? fresh : candidates, source);
  if (ranked.used && !ranked.candidates.length) throw new Error('AI 过滤后没有安全候选');
  return { candidates: ranked.candidates.length ? ranked.candidates : (fresh.length ? fresh : candidates), bucket, source };
}

function chooseNaturalVideos(candidates, max = 2) {
  const list = (Array.isArray(candidates) ? candidates : []).filter(Boolean);
  if (!list.length) return [];
  const wanted = list.length > 1 && Math.random() < 0.5 ? Math.min(2, max) : 1;
  const pool = [...list];
  const out = [];
  while (out.length < wanted && pool.length) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return out;
}

async function commentsFor(session, video, cfg) {
  try {
    const out = await commentReader.fetchComments(session, video.awemeId, { limit: 6 });
    repos.logEvent('natural-comments', { account: cfg.accountLabel, videoId: video.awemeId, count: out.comments.length });
    return out.comments;
  } catch (e) {
    repos.logEvent('natural-comments-failed', { account: cfg.accountLabel, videoId: video.awemeId, error: e.message.split('\n')[0] });
    return [];
  }
}

async function apiNaturalAttempt(cfg, { session, friend, toUserId, source, pool, history, dryRun = false }) {
  const picked = await naturalCandidates(cfg, session, source, pool, history);
  const videos = chooseNaturalVideos(picked.candidates, 2);
  if (!videos.length) throw new Error('自然分享没有可用视频');
  const withText = cfg.naturalText !== false;
  const prepared = [];
  for (const video of videos) {
    let comments = [];
    let messages = [];
    if (withText) {
      comments = await commentsFor(session, video, cfg);
      const note = await naturalAi.composeShareNotes({ video, comments });
      messages = note.messages;
    }
    prepared.push({ video, comments, messages, used: withText });
    if (withText) await sleep(400 + Math.floor(Math.random() * 700));
  }
  if (dryRun) {
    return {
      ok: true, dryRun: true, natural: true, api: true, source, bucket: picked.bucket, friend,
      title: videos[0].title, videos: prepared.map((x) => ({ title: x.video.title, awemeId: x.video.awemeId, comments: x.comments.length, durationMs: Number(x.video.durationMs) || 0 })),
      messages: prepared.flatMap((x) => x.messages), durationMs: Number(videos[videos.length - 1].durationMs) || 0,
    };
  }

  const sent = [];
  const sentMessages = [];
  let conversation = {};
  let textCount = 0;
  for (let i = 0; i < prepared.length; i++) {
    if (i > 0 && !(await interruptibleWait(1400 + Math.floor(Math.random() * 2400), cfg))) break;
    const video = prepared[i].video;
    const res = await apiSender.sendVideo(session, video, { friend, toUserId, ...conversation });
    if (!res.ok) {
      if (!sent.length) throw new Error(res.error || res.statusMessage || '视频发送失败');
      repos.logEvent('natural-video-failed', { account: cfg.accountLabel, title: video.title, error: res.error || res.statusMessage });
      break;
    }
    conversation = { conversationId: res.conversationId, conversationShortId: res.conversationShortId };
    repos.insertSend({
      accountId: cfg.accountId,
      ts: new Date().toISOString(),
      day: ymd(new Date()),
      bucket: picked.bucket,
      title: video.title,
      author: video.author,
      likes: video.likes,
      friend,
      ok: true,
      toast: 'HTTP API · 自然分享',
      shot: null,
      videoId: video.awemeId,
      source,
    });
    sent.push({ title: video.title, awemeId: video.awemeId, serverMessageId: res.serverMessageId, durationMs: Number(video.durationMs) || 0 });
    const notes = withText ? (prepared[i].messages || []).slice(0, 2) : [];
    for (const text of notes) {
      if (textCount >= 2) break;
      if (!(await interruptibleWait(1100 + Math.floor(Math.random() * 2600), cfg))) break;
      const tr = await apiSender.sendText(session, text, { friend, toUserId, ...conversation });
      if (tr.ok) {
        sentMessages.push(text);
        textCount++;
        conversation = { conversationId: tr.conversationId || conversation.conversationId, conversationShortId: tr.conversationShortId || conversation.conversationShortId };
        repos.logEvent('natural-text', { account: cfg.accountLabel, friend, text, serverMessageId: tr.serverMessageId });
      } else {
        repos.logEvent('natural-text-failed', { account: cfg.accountLabel, friend, error: tr.error || tr.statusMessage });
      }
    }
  }
  if (!sent.length) throw new Error('自然分享没有成功发送');
  repos.logEvent('natural-share', {
    account: cfg.accountLabel, friend, source, videos: sent.length, texts: sentMessages.length,
    comments: prepared.reduce((n, x) => n + x.comments.length, 0),
  });
  return {
    ok: true, natural: true, api: true, source, bucket: picked.bucket, title: sent[0].title, friend,
    toast: 'HTTP API · 自然分享', serverMessageId: sent[0].serverMessageId,
    videos: sent, messages: sentMessages, durationMs: sent[sent.length - 1].durationMs,
  };
}

/**
 * Pure-HTTP attempt. Returns a result object when the API path handled the send, or null to let
 * the caller fall back to the browser path (no/invalid session, template rejected, network error).
 * The recommendation source is API-only: its failures are returned as final results, never
 * delegated to the browser.
 */
async function apiAttempt(cfg, { dryRun = false } = {}) {
  const source = cfg.videoSource === 'recommend' ? 'recommend' : 'pool';
  const apiOnly = source === 'recommend';
  const fail = (error) => apiOnly ? { ok: false, error, source, noFallback: true } : null;
  if (cfg.sendMode === 'browser') {
    return fail('推荐源只支持纯 API：请把该账户的发送模式切到「纯 API 优先」');
  }
  const session = apiSession.load(cfg.accountLabel);
  const state = apiSession.status(session, null);
  if (!state.valid) {
    if (session) repos.logEvent('api-session-invalid', { account: cfg.accountLabel, reason: state.reason, ageHours: state.ageHours });
    return fail(`纯 API 会话不可用：${state.reason}`);
  }
  const rows = (cfg.friendRows || [])
    .map((row) => ({
      ...row,
      apiCapable: !!row.userid || apiSession.canSendTo(session, row.name),
    }))
    .filter((row) => row.apiCapable);
  if (!rows.length) {
    repos.logEvent('api-fallback-friend', { account: cfg.accountLabel, friends: cfg.friends });
    return fail('没有可用于纯 API 的收件人（好友不在会话里且没有 userid）');
  }
  const apiNames = rows.map((row) => row.name);
  const picked = chooseFriendToday(cfg, apiNames);
  if (!picked) return fail('没有可用好友');
  cfg.friend = picked;
  const row = rows.find((r) => r.name === picked) || rows[0];
  const friend = row.name;
  const toUserId = row.userid || null;

  let pool = null;
  if (!apiOnly) {
    const pools = cfg.pools.filter((p) => p.enabled);
    if (!pools.length) return null;
    pool = pools[Math.floor(Math.random() * pools.length)];
  }
  try {
    const history = recentVideoHistory(cfg.accountId);
    if (cfg.naturalShare) {
      return await apiNaturalAttempt(cfg, { session, friend, toUserId, source, pool, history, dryRun });
    }
    let video;
    if (apiOnly) {
      const collected = await apiSender.collectFeedCandidates(session, {
        banWords: cfg.banWords,
        excludeVideoIds: history.ids,
        excludeTitles: history.titles,
        maxAgeDays: cfg.ageEnabled ? cfg.recommendMaxAgeDays : 0,
        filters: cfg.metricFilters,
      });
      const ranked = await aiRankCandidates(cfg, collected.candidates, 'recommend');
      if (ranked.used && !ranked.candidates.length) throw new Error('AI 过滤后没有安全候选');
      const chosen = videoPicker.chooseVideo(ranked.candidates.length ? ranked.candidates : collected.candidates, {
        ids: history.ids,
        titles: history.titles,
      });
      if (!chosen) throw new Error('推荐 feed 没有可用候选');
      video = { ...chosen, source: 'recommend', bucket: '默认推荐' };
    } else {
      const keyword = (() => {
        const value = chooseKeyword(pool);
        return value.startsWith('@') ? pool.name : value;
      })();
      if (aiRanker.active(cfg.aiMode)) {
        const collected = await apiSender.collectSearchCandidates(session, {
          keyword,
          banWords: cfg.banWords,
          maxAgeDays: cfg.ageEnabled ? cfg.maxVideoAgeDays : 0,
          filters: cfg.metricFilters,
        });
        const ranked = await aiRankCandidates(cfg, collected.candidates, 'pool');
        if (ranked.used && !ranked.candidates.length) throw new Error('AI 过滤后没有安全候选');
        const chosen = videoPicker.chooseVideo(ranked.candidates.length ? ranked.candidates : collected.candidates, {
          ids: history.ids,
          titles: history.titles,
        });
        if (!chosen) throw new Error('池搜索没有可用候选');
        video = { ...chosen, source: 'pool', bucket: pool.name };
      } else {
        video = await apiSender.pick(session, {
          keyword,
          banWords: cfg.banWords,
          excludeVideoIds: history.ids,
          excludeTitles: history.titles,
          maxAgeDays: cfg.ageEnabled ? cfg.maxVideoAgeDays : 0,
          filters: cfg.metricFilters,
        });
      }
    }
    const bucket = apiOnly ? '默认推荐' : pool.name;
    if (dryRun) {
      repos.logEvent('api-dry-run', { account: cfg.accountLabel, friend, title: video.title, pool: bucket, source });
      return { ok: true, dryRun: true, api: true, source, bucket, title: video.title, friend, video, durationMs: Number(video.durationMs) || 0 };
    }
    const res = await apiSender.sendVideo(session, video, { friend, toUserId });
    if (res.ok) {
      repos.insertSend({
        accountId: cfg.accountId,
        ts: new Date().toISOString(),
        day: ymd(new Date()),
        bucket,
        title: video.title,
        author: video.author,
        likes: video.likes,
        friend: cfg.friend,
        ok: true,
        toast: 'HTTP API',
        shot: null,
        videoId: video.awemeId,
        source,
      });
      repos.logEvent('sent-api', { account: cfg.accountLabel, pool: bucket, source, friend, title: video.title, serverMessageId: res.serverMessageId });
      return { ok: true, api: true, source, bucket, title: video.title, friend, toast: 'HTTP API', serverMessageId: res.serverMessageId, durationMs: Number(video.durationMs) || 0 };
    }
    repos.logEvent('api-send-rejected', { source, statusCode: res.statusCode, statusMessage: res.statusMessage, title: video.title, friend });
    return fail(res.statusMessage || `发送被拒绝（${res.statusCode || res.httpStatus || 'unknown'}）`);
  } catch (e) {
    const message = (e.message || '').split('\n')[0];
    repos.logEvent('api-send-error', { source, error: message, friend });
    // The browser fallback can only verify likes; refuse it when comment/favorite/share
    // thresholds are set instead of silently sending an unchecked video.
    if (e && e.code === 'metric-filter') {
      const f = cfg.metricFilters || {};
      const sw = videoPicker.normalizeFilterSwitches(f, f);
      if ((sw.comments && f.minComments > 0) || (sw.favorites && f.minFavorites > 0) || (sw.shares && f.minShares > 0)) {
        return { ok: false, error: message, source, noFallback: true };
      }
    }
    return fail(apiOnly ? message : null);
  }
}

async function sendOne(cfg, { dryRun = false } = {}) {
  if (!Array.isArray(cfg.friends) || !cfg.friends.length) return { ok: false, error: 'no friend configured' };
  const picked = chooseFriendToday(cfg, cfg.friends);
  if (picked) cfg.friend = picked;
  const api = await apiAttempt(cfg, { dryRun });
  if (api) return api;
  if (cfg.videoSource === 'recommend') {
    return { ok: false, error: '推荐源只支持纯 API，未启动浏览器', source: 'recommend', noFallback: true };
  }
  const startedHere = !(await serverUp(cfg));
  if (startedHere && !(await startServer(cfg))) return { ok: false, error: 'server failed' };
  try {
    return await sendOneBrowser(cfg, { dryRun });
  } finally {
    if (startedHere) await stopServer(cfg);
  }
}

async function sendOneBrowser(cfg, { dryRun = false } = {}) {
  if (cfg.videoSource === 'recommend') return { ok: false, error: '推荐源只支持纯 API' };
  const base = baseOf(cfg);
  const health = await serverUp(cfg);
  if (health && health.challenge) {
    repos.logEvent('captcha-blocked', { port: cfg.port, url: health.url });
    return { ok: false, error: 'captcha' };
  }
  const history = recentVideoHistory(cfg.accountId);
  const outcome = await picker.pick({
    base,
    pools: cfg.pools,
    banWords: cfg.banWords,
    excludeTitles: history.titles,
    maxAgeDays: cfg.ageEnabled ? cfg.maxVideoAgeDays : 0,
    count: 1,
    poolDelayMs: cfg.poolDelayMs,
    filters: cfg.metricFilters,
  });
  const target = outcome.picked[0];
  if (!target) {
    if (outcome.metricFiltered > 0) {
      const desc = videoPicker.describeMetricFilters(cfg.metricFilters);
      return {
        ok: false,
        error: `没有达到互动指标（${desc}）的候选；浏览器回退只能校验点赞数，请改用纯 API`,
        metricFiltered: outcome.metricFiltered,
      };
    }
    return { ok: false, error: 'no candidate' };
  }
  const opened = await picker.open(base, target);
  if (!opened.ok) return { ok: false, error: opened.error, title: target.title };

  await fetch(base + '/openshare', { method: 'POST' }).then((r) => r.json()).catch(() => ({}));
  if (dryRun) {
    const check = await fetch(base + '/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: cfg.friend, confirm: false }),
    }).then((r) => r.json());
    return { ok: !!check.ok, dryRun: true, title: target.title, check, durationMs: Number(target.durationMs) || 0 };
  }

  const res = await fetch(base + '/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: cfg.friend, confirm: true }),
  }).then((r) => r.json());

  const ts = new Date().toISOString();
  repos.insertSend({
    accountId: cfg.accountId,
    ts,
    day: ymd(new Date()),
    bucket: target.pool,
    title: target.title,
    author: target.author,
    likes: target.likes,
    friend: cfg.friend,
    ok: !!(res && res.ok),
    toast: (res && (res.toast || res.error)) || '',
    shot: res && res.shot ? path.basename(res.shot) : null,
    videoId: (opened.url.match(/modal_id=(\d+)/) || [])[1] || null,
    source: 'pool',
  });
  return { ...res, durationMs: Number(target.durationMs) || 0 };
}

function accountEnabled(cfg) {
  try {
    const acc = repos.getAccount(cfg.accountLabel);
    return !!(acc && acc.enabled);
  } catch (e) {
    // a transient DB error should not abort an otherwise healthy send loop
    return true;
  }
}

function refreshConfig(cfg) {
  try {
    return runtimeConfig(cfg.accountLabel);
  } catch (e) {
    return cfg;
  }
}

async function interruptibleWait(ms, cfg) {
  let left = Math.max(0, Number(ms) || 0);
  while (left > 0) {
    if (!accountEnabled(cfg)) return false;
    const step = Math.min(left, 2000);
    await sleep(step);
    left -= step;
  }
  return accountEnabled(cfg);
}

/**
 * Unified schedule runner. Every trigger point (fixed time, or a random moment inside a range)
 * sends its own count of videos, one at a time. The gap is drawn in [minSec, maxSec] and is
 * never shorter than the previous video's duration. A trigger that is missed or fails is
 * skipped on its own; later triggers still run. Progress lives in account_settings so a
 * scheduler restart resumes instead of replaying the day.
 *
 * Natural share is muted here: a batch of 1-2 videos sent ~2s apart would break the
 * "wait for the previous clip" rule that defines this pacing.
 */
function persistSchedule(cfg, state) {
  const prev = repos.getBurstState(cfg.accountId);
  if (!prev || JSON.stringify(prev) !== JSON.stringify(state)) repos.saveBurstState(cfg.accountId, state);
  return state;
}

function scheduleResult(state, extra = {}) {
  const summary = burstPlanner.counts(state);
  return { ...summary, ok: true, done: state.status === 'done', status: state.status, ...extra };
}

async function runSchedule(cfg, day, { now = () => new Date(), retryDelayMs = 15000 } = {}) {
  const nowMs = () => now().getTime();
  const stored = repos.getBurstState(cfg.accountId);
  const newDay = !stored || stored.day !== day || !Array.isArray(stored.points);
  let state = burstPlanner.reconcileState(stored, { day, burst: cfg.schedule, nowMs: nowMs() });
  persistSchedule(cfg, state);
  if (newDay) {
    repos.logEvent('schedule-plan', {
      account: cfg.accountLabel, day,
      points: state.points.map((p) => burstPlanner.triggerLabel(p) + 'x' + p.count),
      minSec: cfg.schedule.minSec, maxSec: cfg.schedule.maxSec,
      floor: cfg.schedule.floor, fallbackSec: cfg.schedule.fallbackSec,
    });
  }

  for (;;) {
    const at = now();
    if (ymd(at) !== day) return scheduleResult(state, { dayChanged: true });
    if (!accountEnabled(cfg)) return scheduleResult(state, { paused: true });

    // Re-read the account config on every step so pause/edit takes effect mid-run.
    const latest = refreshConfig(cfg);
    cfg = { ...latest, naturalShare: false };
    if (burstPlanner.fingerprint(cfg.schedule) !== state.configKey) {
      state = burstPlanner.reconcileState(state, { day, burst: cfg.schedule, nowMs: nowMs() });
      persistSchedule(cfg, state);
      repos.logEvent('schedule-config', { account: cfg.accountLabel, day, points: state.points.length, sent: state.sent });
    }

    // The dashboard may reset today's schedule (or a manual DB edit may land) while this loop
    // is waiting. updatedAt is the state revision: any write that is not ours bumps it.
    const persisted = repos.getBurstState(cfg.accountId);
    if (!persisted || persisted.day !== day || !Array.isArray(persisted.points) || persisted.updatedAt !== state.updatedAt) {
      state = burstPlanner.reconcileState(persisted, { day, burst: cfg.schedule, nowMs: nowMs() });
      persistSchedule(cfg, state);
      repos.logEvent('schedule-state-sync', { account: cfg.accountLabel, day, active: state.active, status: state.status });
    }

    if (state.status === 'done') return scheduleResult(state);

    const point = state.points[state.active];
    if (!point) {
      burstPlanner.settleState(state);
      continue;
    }
    const trigger = burstPlanner.triggerLabel(point);

    const t = nowMs();
    if (point.sent === 0 && t > Number(point.startAt) + burstPlanner.FIRST_START_GRACE_MS) {
      point.status = 'skipped';
      point.nextAt = null;
      point.lastError = 'late-start';
      state.lastError = 'late-start';
      state.updatedAt = new Date(t).toISOString();
      burstPlanner.settleState(state);
      persistSchedule(cfg, state);
      repos.logEvent('schedule-trigger-skipped', {
        account: cfg.accountLabel, day, trigger, reason: 'late-start',
        lateMin: Math.round((t - Number(point.startAt)) / 60000),
      });
      if (state.status === 'done') {
        repos.logEvent('schedule-done', { account: cfg.accountLabel, day, sent: state.sent, total: burstPlanner.counts(state).total });
        return scheduleResult(state);
      }
      continue;
    }
    if (point.sent > 0 && t > Number(point.nextAt) + burstPlanner.RESUME_GRACE_MS) {
      point.status = 'skipped';
      point.nextAt = null;
      point.lastError = 'late-resume';
      state.lastError = 'late-resume';
      state.updatedAt = new Date(t).toISOString();
      burstPlanner.settleState(state);
      persistSchedule(cfg, state);
      repos.logEvent('schedule-trigger-skipped', {
        account: cfg.accountLabel, day, trigger, reason: 'late-resume',
        sent: point.sent, count: point.count,
        lateMin: Math.round((t - Number(point.nextAt)) / 60000),
      });
      if (state.status === 'done') {
        repos.logEvent('schedule-done', { account: cfg.accountLabel, day, sent: state.sent, total: burstPlanner.counts(state).total });
        return scheduleResult(state);
      }
      continue;
    }
    if (t < Number(point.nextAt)) {
      const left = Number(point.nextAt) - t;
      // poll often near the target, lazily far away (config edits are still picked up)
      const chunk = left > 60000 ? 30000 : Math.min(5000, Math.max(250, left));
      if (!(await interruptibleWait(chunk, cfg))) return scheduleResult(state, { paused: true });
      continue;
    }

    const startedAt = nowMs();
    let res = await sendOne(cfg).catch((e) => ({ ok: false, error: e.message }));
    if (!res || !res.ok) {
      repos.logEvent('schedule-retry', {
        account: cfg.accountLabel, day, trigger, sent: point.sent,
        error: (res && (res.error || res.reason)) || 'send failed',
      });
      if (retryDelayMs > 0 && !(await interruptibleWait(retryDelayMs, cfg))) return scheduleResult(state, { paused: true });
      const again = refreshConfig(cfg);
      cfg = { ...again, naturalShare: false };
      res = await sendOne(cfg).catch((e) => ({ ok: false, error: e.message }));
    }
    if (!res || !res.ok) {
      if (res && res.error === 'captcha') repos.logEvent('captcha-blocked', { account: cfg.accountLabel, day, trigger, mode: 'schedule' });
      point.status = 'aborted';
      point.nextAt = null;
      point.lastError = (res && (res.error || res.reason)) || 'send failed';
      state.lastError = point.lastError;
      state.updatedAt = new Date(nowMs()).toISOString();
      burstPlanner.settleState(state);
      persistSchedule(cfg, state);
      repos.logEvent('schedule-trigger-aborted', {
        account: cfg.accountLabel, day, trigger,
        sent: point.sent, count: point.count, error: point.lastError,
      });
      if (state.status === 'done') {
        repos.logEvent('schedule-done', { account: cfg.accountLabel, day, sent: state.sent, total: burstPlanner.counts(state).total });
        return scheduleResult(state);
      }
      continue;
    }

    const durationMs = Math.max(0, Number(res.durationMs) || 0);
    point.sent += 1;
    point.status = 'running';
    point.lastAt = startedAt;
    point.lastDurationMs = durationMs;
    point.lastTitle = res.title || '';
    point.lastError = '';
    state.lastAt = startedAt;
    state.lastDurationMs = durationMs;
    state.lastTitle = res.title || '';
    state.lastError = '';
    state.updatedAt = new Date(nowMs()).toISOString();

    let gapInfo = null;
    if (point.sent >= point.count) {
      point.status = 'done';
      point.nextAt = null;
      repos.logEvent('schedule-trigger-done', {
        account: cfg.accountLabel, day, trigger, sent: point.sent, count: point.count,
      });
    } else {
      gapInfo = burstPlanner.gapMs({
        minSec: cfg.schedule.minSec, maxSec: cfg.schedule.maxSec, fallbackSec: cfg.schedule.fallbackSec,
        floor: cfg.schedule.floor, prevDurationMs: durationMs,
      });
      point.nextAt = Math.max(startedAt + gapInfo.gapMs, nowMs() + 200);
    }
    burstPlanner.settleState(state);
    persistSchedule(cfg, state);
    repos.logEvent('schedule-send', {
      account: cfg.accountLabel, day, trigger, n: point.sent, count: point.count,
      sentToday: state.sent, totalToday: burstPlanner.counts(state).total,
      title: res.title || '', durationMs,
      gapMs: gapInfo ? gapInfo.gapMs : null,
      baseMs: gapInfo ? gapInfo.baseMs : null,
      floored: gapInfo ? gapInfo.floored : null,
      nextAt: point.nextAt ? new Date(point.nextAt).toISOString() : null,
    });
    if (state.status === 'done') {
      repos.logEvent('schedule-done', { account: cfg.accountLabel, day, sent: state.sent, total: burstPlanner.counts(state).total });
      return scheduleResult(state);
    }
  }
}

async function runLoop({ once = false } = {}) {
  for (;;) {
    const cfg = runtimeConfig();
    if (!cfg.enabled) {
      if (once) return { ok: false, reason: 'disabled' };
      await sleep(5 * 60 * 1000);
      continue;
    }
    if (!Array.isArray(cfg.friends) || !cfg.friends.length) {
      if (once) return { ok: false, reason: 'no friends configured' };
      repos.logEvent('no-friends', { account: cfg.accountLabel });
      await sleep(5 * 60 * 1000);
      continue;
    }
    const day = ymd(new Date());
    const r = await runSchedule(cfg, day);
    if (once) return r;
    if (r && r.paused) {
      await sleep(5000);
      continue;
    }
    if (r && r.dayChanged) continue;
    // done / all triggers settled: re-check once a minute so a config edit (or the next day)
    // is picked up without restarting the scheduler child.
    await interruptibleWait(60 * 1000, cfg);
  }
}

module.exports = { runLoop, runSchedule, runBurst: runSchedule, sendOne, sendOneBrowser, apiAttempt, runtimeConfig, startServer, stopServer };
