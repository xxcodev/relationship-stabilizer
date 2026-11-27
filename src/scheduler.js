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
const slowMail = require('./slow-mail');
const scheduleConfig = require('./schedule');
const { chooseKeyword } = require('./pools');
const picker = require('./picker');
const apiSender = require('./api-sender');
const apiSession = require('./api-session');
const apiRead = require('./api-read');
const autoRead = require('./auto-read');
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
  // Pure-API only: browser sending and fallback have been removed.
  cfg.sendMode = 'api';
  const videoSource = repos.getAccountSetting(acc.id, 'videoSource', 'pool');
  cfg.videoSource = videoSource === 'recommend' ? 'recommend' : 'pool';
  cfg.aiMode = repos.getAccountSetting(acc.id, 'aiMode', 'off');
  const naturalRaw = repos.getAccountSetting(acc.id, 'naturalShare', false);
  cfg.naturalShare = naturalRaw === true || naturalRaw === 1 || naturalRaw === '1' || naturalRaw === 'true';
  const naturalTextRaw = repos.getAccountSetting(acc.id, 'naturalText', true);
  cfg.naturalText = !(naturalTextRaw === false || naturalTextRaw === 0 || naturalTextRaw === '0' || naturalTextRaw === 'false');
  const dailyReadRaw = repos.getAccountSetting(acc.id, 'dailyReadEnabled', '1');
  cfg.dailyReadEnabled = !(dailyReadRaw === false || dailyReadRaw === 0 || dailyReadRaw === '0' || dailyReadRaw === 'false');
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
// a second message. A row carries the stable UID; the name is only the display label.
function chooseFriendToday(cfg, rows) {
  const list = (Array.isArray(rows) ? rows : [])
    .map((row) => (typeof row === 'string' ? { name: row, userid: '' } : row))
    .filter((row) => row && row.name);
  if (!list.length) return null;
  const last = repos.listSends({ accountId: cfg.accountId, limit: 1 })[0];
  const picked = friendPicker.chooseFriend(
    list.map((row) => row.name),
    repos.friendSendCounts(cfg.accountId, ymd(new Date())),
    Math.random,
    last && last.friend
  );
  return list.find((row) => row.name === picked) || null;
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

function noFreshCandidates(message) {
  const err = new Error(message);
  err.code = 'no-fresh-candidate';
  return err;
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
  const fresh = videoPicker.filterHistory(candidates, history);
  if (!fresh.length) throw noFreshCandidates('候选都已发送过，暂无新视频');
  const ranked = await aiRankCandidates(cfg, fresh, source);
  if (ranked.used && !ranked.candidates.length) throw new Error('AI 过滤后没有安全候选');
  return { candidates: ranked.candidates.length ? ranked.candidates : fresh, bucket, source };
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
    conversationId: conversation.conversationId || null,
    conversationShortId: conversation.conversationShortId || null,
    videos: sent, messages: sentMessages, durationMs: sent[sent.length - 1].durationMs,
  };
}

const MAX_POOL_FALLBACKS = 6;
const POOL_RETRYABLE_CODES = new Set(['no-fresh-candidate', 'metric-filter', 'no-candidate']);

function shufflePools(list) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function isPoolCandidateError(err) {
  if (!err) return false;
  if (POOL_RETRYABLE_CODES.has(err.code)) return true;
  const msg = String(err.message || '');
  return /AI 过滤后没有安全候选|no candidate|没有达到互动指标|暂无新视频|没有新的候选/i.test(msg);
}

async function pickPoolVideo(cfg, session, pool, history) {
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
    const fresh = videoPicker.filterHistory(collected.candidates, history);
    if (!fresh.length) throw noFreshCandidates('池搜索的候选都已发送过，暂无新视频');
    const ranked = await aiRankCandidates(cfg, fresh, 'pool');
    if (ranked.used && !ranked.candidates.length) throw new Error('AI 过滤后没有安全候选');
    const chosen = videoPicker.chooseVideo(ranked.candidates.length ? ranked.candidates : fresh, {
      ids: history.ids,
      titles: history.titles,
    });
    if (!chosen) throw noFreshCandidates('池搜索没有新的候选');
    return { ...chosen, source: 'pool', bucket: pool.name };
  }
  const picked = await apiSender.pick(session, {
    keyword,
    banWords: cfg.banWords,
    excludeVideoIds: history.ids,
    excludeTitles: history.titles,
    maxAgeDays: cfg.ageEnabled ? cfg.maxVideoAgeDays : 0,
    filters: cfg.metricFilters,
  });
  return { ...picked, source: 'pool', bucket: pool.name };
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
  const fail = (error, code = '') => ({ ok: false, error: error || '纯 API 发送失败', source, noFallback: true, code });
  const session = apiSession.load(cfg.accountLabel);
  const state = apiSession.status(session, null);
  if (!state.valid) {
    if (session) repos.logEvent('api-session-invalid', { account: cfg.accountLabel, reason: state.reason, ageHours: state.ageHours });
    return fail(`纯 API 会话不可用：${state.reason}`, 'session');
  }
  const rows = (cfg.friendRows || [])
    .map((row) => ({
      ...row,
      apiCapable: !!row.userid || apiSession.canSendToUid(session, row.userid) || apiSession.canSendTo(session, row.name),
    }))
    .filter((row) => row.apiCapable);
  if (!rows.length) {
    repos.logEvent('api-fallback-friend', { account: cfg.accountLabel, friends: cfg.friends });
    return fail('没有可用于纯 API 的收件人（好友不在会话里且没有 userid）', 'friend');
  }
  const picked = chooseFriendToday(cfg, rows);
  if (!picked) return fail('没有可用好友', 'friend');
  cfg.friend = picked.name;
  cfg.friendUserId = picked.userid || '';
  const row = picked;
  const friend = row.name;
  const toUserId = row.userid || cfg.friendUserId || null;

  const enabledPools = apiOnly ? [] : cfg.pools.filter((p) => p.enabled);
  if (!apiOnly && !enabledPools.length) return null;
  let pool = enabledPools.length ? enabledPools[Math.floor(Math.random() * enabledPools.length)] : null;
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
      if (!chosen) throw noFreshCandidates('推荐 feed 没有新的候选');
      video = { ...chosen, source: 'recommend', bucket: '默认推荐' };
    } else {
      const candidates = shufflePools(enabledPools).slice(0, MAX_POOL_FALLBACKS);
      let lastPoolErr = null;
      for (let i = 0; i < candidates.length; i++) {
        const candidatePool = candidates[i];
        pool = candidatePool;
        try {
          video = await pickPoolVideo(cfg, session, candidatePool, history);
          if (i > 0) {
            repos.logEvent('pool-fallback-hit', { account: cfg.accountLabel, pool: candidatePool.name, attempts: i + 1 });
          }
          break;
        } catch (err) {
          lastPoolErr = err;
          if (!isPoolCandidateError(err) || i === candidates.length - 1) throw err;
        }
      }
      if (!video && lastPoolErr) throw lastPoolErr;
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
      return {
        ok: true, api: true, source, bucket, title: video.title, friend, toast: 'HTTP API',
        serverMessageId: res.serverMessageId,
        conversationId: res.conversationId || null,
        conversationShortId: res.conversationShortId || null,
        durationMs: Number(video.durationMs) || 0,
      };
    }
    repos.logEvent('api-send-rejected', { source, statusCode: res.statusCode, statusMessage: res.statusMessage, title: video.title, friend });
    return fail(res.statusMessage || `发送被拒绝（${res.statusCode || res.httpStatus || 'unknown'}）`, 'rejected');
  } catch (e) {
    const message = (e.message || '').split('\n')[0];
    repos.logEvent('api-send-error', { source, error: message, friend });
    if (e && e.code === 'no-fresh-candidate') {
      repos.logEvent('dedup-exhausted', {
        account: cfg.accountLabel, source, pool: pool && pool.name, friend, error: message,
      });
    }
    // The browser fallback can only verify likes; refuse it when comment/favorite/share
    // thresholds are set instead of silently sending an unchecked video.
    if (e && e.code === 'metric-filter') {
      const f = cfg.metricFilters || {};
      const sw = videoPicker.normalizeFilterSwitches(f, f);
      if ((sw.comments && f.minComments > 0) || (sw.favorites && f.minFavorites > 0) || (sw.shares && f.minShares > 0)) {
        return { ok: false, error: message, source, noFallback: true, code: 'metric-filter' };
      }
    }
    return fail(message, (e && e.code) || 'send-error');
  }
}

async function sendOne(cfg, { dryRun = false } = {}) {
  if (!Array.isArray(cfg.friends) || !cfg.friends.length) return { ok: false, error: 'no friend configured', code: 'no-friend' };
  const rows = (Array.isArray(cfg.friendRows) && cfg.friendRows.length)
    ? cfg.friendRows
    : cfg.friends.map((name) => ({ name, userid: '' }));
  const picked = chooseFriendToday(cfg, rows);
  if (picked) {
    cfg.friend = picked.name;
    cfg.friendUserId = picked.userid || '';
  }
  const api = await apiAttempt(cfg, { dryRun });
  return api || { ok: false, error: '纯 API 发送失败（已移除浏览器回退）', noFallback: true, code: 'api-only' };
}

async function sendOneBrowser(cfg, { dryRun = false } = {}) {
  if (cfg.videoSource === 'recommend') return { ok: false, error: '推荐源只支持纯 API' };
  const base = baseOf(cfg);
  const health = await serverUp(cfg);
  if (health && health.challenge) {
    repos.logEvent('captcha-blocked', { port: cfg.port, url: health.url });
    return { ok: false, error: 'captcha', code: 'captcha' };
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
        code: 'metric-filter',
        error: `没有达到互动指标（${desc}）的候选；浏览器回退只能校验点赞数，请改用纯 API`,
        metricFiltered: outcome.metricFiltered,
      };
    }
    return { ok: false, error: 'no candidate', code: 'no-candidate' };
  }
  const opened = await picker.open(base, target);
  if (!opened.ok) return { ok: false, error: opened.error, title: target.title, code: 'open-failed' };

  await fetch(base + '/openshare', { method: 'POST' }).then((r) => r.json()).catch(() => ({}));
  if (dryRun) {
    const check = await fetch(base + '/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: cfg.friend, userid: cfg.friendUserId || '', confirm: false }),
    }).then((r) => r.json());
    return { ok: !!check.ok, dryRun: true, title: target.title, check, durationMs: Number(target.durationMs) || 0 };
  }

  const res = await fetch(base + '/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: cfg.friend, userid: cfg.friendUserId || '', confirm: true }),
  }).then((r) => r.json());

  const sentFriend = (res && res.target && res.target.name) || cfg.friend;
  const ts = new Date().toISOString();
  repos.insertSend({
    accountId: cfg.accountId,
    ts,
    day: ymd(new Date()),
    bucket: target.pool,
    title: target.title,
    author: target.author,
    likes: target.likes,
    friend: sentFriend,
    ok: !!(res && res.ok),
    toast: (res && (res.toast || res.error)) || '',
    shot: res && res.shot ? path.basename(res.shot) : null,
    videoId: (opened.url.match(/modal_id=(\d+)/) || [])[1] || null,
    source: 'pool',
  });
  return { ...res, friend: sentFriend, durationMs: Number(target.durationMs) || 0 };
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

// Daily plan read receipts are best-effort and independent: one call after every successful
// pure-API send. The slow-mail lane owns its own periodic read loop.
async function markDailyRead(cfg, res) {
  if (cfg.dailyReadEnabled === false) return null;
  if (!res || !res.ok || !res.conversationId || !res.conversationShortId) return null;
  // mark_read is the 1:1 template; a group conversation (0:2:...) must not be touched.
  if (!/^0:1:/.test(String(res.conversationId))) return null;
  let out;
  try {
    out = await apiRead.markConversationRead(apiSession.load(cfg.accountLabel), {
      conversationId: res.conversationId,
      conversationShortId: res.conversationShortId,
      conversationType: 1,
      readIndex: apiRead.READ_INDEX,
    });
  } catch (e) {
    out = { ok: false, error: e.message || '已读请求失败' };
  }
  repos.logEvent(out.ok ? 'daily-read' : 'daily-read-fail', {
    account: cfg.accountLabel,
    friend: res.friend || '',
    conversationId: res.conversationId,
    ...(out.ok ? {} : { error: out.error }),
  });
  return out;
}

async function runSchedule(
  cfg,
  day,
  { now = () => new Date(), retryDelayMs = 15000, windowRetryMs = null, maxWindowRetries = 3 } = {}
) {
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
    if (slowMail.isLive(repos.getSlowMailState(cfg.accountId))) {
      return scheduleResult(state, { slowPending: true });
    }

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
    const inWindowBackoff = Number(point.windowRetries) > 0;
    if (point.sent === 0 && !inWindowBackoff && t > Number(point.startAt) + burstPlanner.FIRST_START_GRACE_MS) {
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
    if ((point.sent > 0 || inWindowBackoff) && t > Number(point.nextAt) + burstPlanner.RESUME_GRACE_MS) {
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
      // Poll every few seconds even far from the target: a slow-mail start must be picked up
      // within ~3s, and config edits are still cheap local reads.
      const chunk = Math.min(3000, Math.max(250, left));
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
      const retryCount = Number(point.windowRetries) || 0;
      const maxWinRetries = Number.isInteger(maxWindowRetries) ? maxWindowRetries : 3;
      const windowEndMs = point.mode === 'random' && point.to ? burstPlanner.startAt(day, point.to) : null;
      const retryTime = nowMs();
      const backoffMs = windowRetryMs != null
        ? Math.max(0, Number(windowRetryMs))
        : Math.min(5 * 60 * 1000, (retryCount + 1) * 2 * 60 * 1000);
      const retryableInWindow = res && res.error !== 'captcha' && !['session', 'friend', 'rejected'].includes(res.code)
        && isPoolCandidateError({ code: res.code, message: res.error || res.reason });
      if (
        point.mode === 'random'
        && retryableInWindow
        && retryCount < maxWinRetries
        && Number.isFinite(windowEndMs)
        && (windowEndMs - retryTime) > backoffMs + 15000
      ) {
        point.windowRetries = retryCount + 1;
        point.status = 'running';
        point.nextAt = retryTime + backoffMs;
        point.lastError = (res && (res.error || res.reason)) || 'send failed';
        state.lastError = point.lastError;
        state.updatedAt = new Date(retryTime).toISOString();
        persistSchedule(cfg, state);
        repos.logEvent('schedule-window-retry', {
          account: cfg.accountLabel,
          day,
          trigger,
          retry: point.windowRetries,
          nextAt: new Date(point.nextAt).toISOString(),
          error: point.lastError,
        });
        continue;
      }
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
    point.windowRetries = 0;
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
    await markDailyRead(cfg, res);
    if (state.status === 'done') {
      repos.logEvent('schedule-done', { account: cfg.accountLabel, day, sent: state.sent, total: burstPlanner.counts(state).total });
      return scheduleResult(state);
    }
  }
}

// ---------- 慢递 (ad-hoc slow-mail session) ----------
// One long-lived session that preempts the daily plan. It reuses sendOne (dedupe/AI/filters/
// friend checks) and only owns the clock: random gap, video-duration + buffer floor, deadline.

function slowSessionCfg(cfg, state) {
  const rows = cfg.friendRows || [];
  const uid = String(state.friendUid || '').trim();
  const row = (uid && rows.find((f) => String(f.userid || '') === uid))
    || rows.find((f) => f.name === state.friend);
  if (!row) {
    const err = new Error(`好友「${state.friend}」已被停用或删除`);
    err.code = 'friend';
    throw err;
  }
  return {
    ...cfg,
    friend: row.name,
    friendUserId: row.userid || uid || '',
    slowFriendName: row.name,
    slowFriendUid: row.userid || uid || '',
    friends: [row.name],
    friendRows: [row],
    naturalShare: false,
  };
}

// A dashboard stop is a newer revision. Never let a send result overwrite it back to running.
function persistSlow(cfg, state) {
  const prev = repos.getSlowMailState(cfg.accountId);
  if (prev && prev.updatedAt && state.updatedAt
    && prev.updatedAt > state.updatedAt && !slowMail.isLive(prev)) {
    return prev;
  }
  if (!prev || JSON.stringify(prev) !== JSON.stringify(state)) repos.saveSlowMailState(cfg.accountId, state);
  return state;
}

// Daily triggers that would fire inside the window step aside. Points after the window keep
// their schedule; already settled points are untouched. Idempotent across scheduler restarts.
function preemptDaily(cfg, endsAt, nowMs) {
  const day = ymd(new Date(nowMs));
  const state = repos.getBurstState(cfg.accountId);
  if (!state || state.day !== day || !Array.isArray(state.points)) return [];
  const deferred = [];
  for (const point of state.points) {
    if (!point || (point.status !== 'pending' && point.status !== 'running')) continue;
    const ref = Number(point.sent) > 0 ? Number(point.nextAt) : Number(point.startAt);
    if (!(ref > 0) || ref >= endsAt) continue;
    point.status = 'skipped';
    point.nextAt = null;
    point.lastError = 'slow-mail';
    deferred.push(burstPlanner.triggerLabel(point) + 'x' + point.count);
  }
  if (!deferred.length) return [];
  burstPlanner.settleState(state);
  state.updatedAt = new Date(nowMs).toISOString();
  repos.saveBurstState(cfg.accountId, state);
  repos.logEvent('slow-preempt', {
    account: cfg.accountLabel, day, endsAt: new Date(endsAt).toISOString(),
    points: deferred, count: deferred.length,
  });
  return deferred;
}

function pauseSlowIfNeeded(cfg) {
  const state = repos.getSlowMailState(cfg.accountId);
  if (!state || (state.status !== 'running' && state.status !== 'pending')) return false;
  const paused = slowMail.pause(state, Date.now());
  if (paused === state) return false;
  repos.saveSlowMailState(cfg.accountId, paused);
  repos.logEvent('slow-paused', {
    account: cfg.accountLabel, sessionId: paused.id, sent: paused.sent, reason: 'account-paused',
  });
  return true;
}

function classifyFailure(res) {
  const error = String((res && (res.error || res.reason)) || '');
  const code = String((res && res.code) || '');
  if (code === 'captcha' || error === 'captcha' || /验证码|人机验证|captcha/i.test(error)) return 'blocked';
  if (code === 'session' || (/会话/.test(error) && /(失效|不可用|过期|invalid|missing)/i.test(error))) return 'blocked';
  if (code === 'friend' || code === 'no-friend' || /好友.*(停用|删除|不可用)|收件人|no friend/i.test(error)) return 'blocked';
  if (code === 'config' || /只支持纯 API|推荐源只支持/i.test(error)) return 'blocked';
  if (code === 'no-fresh-candidate' || code === 'no-candidate'
    || /候选都已发送过|没有新的候选|no candidate|没有可用候选|dedup-exhausted/i.test(error)) return 'exhausted';
  return 'retry';
}

function blockedSlow(cfg, state, nowMs, message) {
  const blocked = slowMail.block(state, nowMs, message);
  const saved = persistSlow(cfg, blocked);
  repos.logEvent('slow-blocked', {
    account: cfg.accountLabel, sessionId: blocked.id, sent: blocked.sent, error: message,
  });
  return { ok: false, status: saved.status, error: message, sent: saved.sent };
}

function logSlowTerminal(cfg, state, extra = {}) {
  const event = state.status === 'blocked' ? 'slow-blocked'
    : state.status === 'exhausted' ? 'slow-exhausted'
      : state.status === 'expired' ? 'slow-expired'
        : state.status === 'stopped' ? 'slow-stop'
          : 'slow-done';
  repos.logEvent(event, {
    account: cfg.accountLabel, sessionId: state.id, sent: state.sent,
    reason: state.doneReason, error: state.lastError, ...extra,
  });
}

/**
 * Drive one slow-mail session. Injected `now`/`send`/`wait`/`random` keep the integration test
 * off the network and off real sleeps. Returns when the session reaches a terminal state,
 * pauses, or the dashboard stops it.
 */
const SLOW_READ_EVERY_MS = 45 * 1000;
const SLOW_READ_LOG_MS = 10 * 60 * 1000;

// Best-effort read receipt. It never blocks or aborts the session: a failed read only updates
// the session's readError and emits a throttled event. `readFn` is injectable for tests.
async function markSlowRead(cfg, state, nowMs, readFn = apiRead.markConversationRead) {
  if (!state || state.readEnabled === false) return state;
  if (!state.conversationId || !state.conversationShortId) return state;
  if (!/^0:1:/.test(String(state.conversationId))) return state;
  const at = Number(nowMs) || Date.now();
  const session = apiSession.load(cfg.accountLabel);
  let res;
  try {
    res = await readFn(session, {
      conversationId: state.conversationId,
      conversationShortId: state.conversationShortId,
      conversationType: 1,
      readIndex: apiRead.READ_INDEX,
    });
  } catch (e) {
    res = { ok: false, error: e.message || '已读请求失败' };
  }
  const previous = { ...state };
  const next = {
    ...state,
    lastReadAt: at,
    lastReadOk: !!res.ok,
    readError: res.ok ? '' : (res.error || '已读失败'),
    updatedAt: new Date(at).toISOString(),
  };
  let saved = persistSlow(cfg, next);
  const changed = previous.lastReadOk !== !!res.ok;
  const dueLog = !previous.lastReadEventAt || at - Number(previous.lastReadEventAt) >= SLOW_READ_LOG_MS;
  if (res.ok && (changed || dueLog)) {
    repos.logEvent('slow-read', {
      account: cfg.accountLabel, sessionId: saved.id,
      conversationId: saved.conversationId, readIndex: apiRead.READ_INDEX,
    });
    saved = persistSlow(cfg, { ...saved, lastReadEventAt: at });
  } else if (!res.ok && (changed || dueLog)) {
    repos.logEvent('slow-read-fail', {
      account: cfg.accountLabel, sessionId: saved.id, error: saved.readError,
    });
    saved = persistSlow(cfg, { ...saved, lastReadEventAt: at });
  }
  return saved;
}

async function runSlowMail(cfg, initial, opts = {}) {
  const now = opts.now || (() => new Date());
  const send = opts.send || sendOne;
  const wait = opts.wait || interruptibleWait;
  const random = opts.random || Math.random;
  const read = opts.read || apiRead.markConversationRead;
  const readEveryMs = opts.readEveryMs == null
    ? SLOW_READ_EVERY_MS
    : Math.max(5000, Number(opts.readEveryMs) || SLOW_READ_EVERY_MS);
  const retryDelayMs = opts.retryDelayMs == null ? 15000 : Math.max(0, Number(opts.retryDelayMs) || 0);
  const nowMs = () => Number(now().getTime());
  let state = initial;
  let browserOwned = false;
  let startLogged = false;

  if (!state || !slowMail.isLive(state)) return { ok: true, status: state && state.status, sent: state && state.sent };
  preemptDaily(cfg, state.endsAt, nowMs());

  try {
    for (;;) {
      const t = nowMs();

      if (!accountEnabled(cfg)) {
        const paused = slowMail.pause(state, t);
        if (paused !== state) {
          state = persistSlow(cfg, paused);
          repos.logEvent('slow-paused', {
            account: cfg.accountLabel, sessionId: state.id, sent: state.sent, reason: 'account-paused',
          });
        }
        return { ok: true, status: state.status, sent: state.sent };
      }

      // A panel stop (or a defensive newer state) wins over our local progress.
      const stored = repos.getSlowMailState(cfg.accountId);
      if (stored && stored.updatedAt !== state.updatedAt) {
        const next = slowMail.reconcile(stored, { nowMs: t });
        if (!slowMail.isLive(next)) {
          state = next;
          if (state.status === 'stopped') logSlowTerminal(cfg, state, { by: 'panel' });
          else logSlowTerminal(cfg, state);
          return { ok: true, status: state.status, sent: state.sent };
        }
        state = next;
      }

      let latest;
      try {
        latest = runtimeConfig(cfg.accountLabel);
      } catch (e) {
        return blockedSlow(cfg, state, t, `账户配置不可用：${e.message.split('\n')[0]}`);
      }
      let sessionCfg;
      try {
        sessionCfg = slowSessionCfg(latest, state);
      } catch (e) {
        return blockedSlow(cfg, state, t, e.message);
      }
      cfg = latest;

      // A rename is harmless: the UID found the row, now refresh the display name on the state.
      if (sessionCfg.slowFriendName && sessionCfg.slowFriendName !== state.friend) {
        state = persistSlow(cfg, {
          ...state,
          friend: sessionCfg.slowFriendName,
          friendUid: sessionCfg.slowFriendUid || state.friendUid || '',
          updatedAt: new Date(t).toISOString(),
        });
        if (!slowMail.isLive(state)) {
          logSlowTerminal(cfg, state);
          return { ok: true, status: state.status, sent: state.sent };
        }
      }

      // pending -> running, or close the window if it already passed while we were down.
      const reconciled = slowMail.reconcile(state, { nowMs: t });
      if (reconciled !== state) {
        state = persistSlow(cfg, reconciled);
        if (!slowMail.isLive(state)) {
          logSlowTerminal(cfg, state);
          return { ok: true, status: state.status, sent: state.sent };
        }
      }
      if (!startLogged && state.status === 'running' && !Number(state.sent) && !Number(state.failed)) {
        startLogged = true;
        repos.logEvent('slow-start', {
          account: cfg.accountLabel, sessionId: state.id, friend: state.friend,
          friendUid: state.friendUid || sessionCfg.friendUserId || '',
          endsAt: new Date(state.endsAt).toISOString(),
          durationMin: Math.round((Number(state.endsAt) - Number(state.startedAt)) / 60000),
          minGapSec: state.minGapSec, maxGapSec: state.maxGapSec,
          bufferSec: state.bufferSec, maxSends: state.maxSends,
          readEnabled: state.readEnabled !== false,
        });
      }

      if (state.status === 'paused') {
        const resumed = slowMail.resume(state, t);
        state = persistSlow(cfg, resumed);
        if (!slowMail.isLive(state)) {
          logSlowTerminal(cfg, state);
          return { ok: true, status: state.status, sent: state.sent };
        }
        repos.logEvent('slow-resumed', {
          account: cfg.accountLabel, sessionId: state.id, sent: state.sent, pausedMs: state.pausedMs,
        });
        // The paused duration shifted endsAt; daily points that now fall inside the extended
        // window also need to step aside, not fire right after the session.
        preemptDaily(cfg, state.endsAt, t);
        continue;
      }

      if (slowMail.isLate(state, t)) {
        const lateMin = Math.round((t - Number(state.nextAt)) / 60000);
        const redrawn = slowMail.redrawNext(state, { nowMs: t, random });
        state = persistSlow(cfg, redrawn.state);
        repos.logEvent('slow-skip', {
          account: cfg.accountLabel, sessionId: state.id, reason: 'late-resume', lateMin,
          gapMs: redrawn.gap ? redrawn.gap.gapMs : null, sent: state.sent,
        });
        if (!slowMail.isLive(state)) {
          logSlowTerminal(cfg, state);
          return { ok: true, status: state.status, sent: state.sent };
        }
        continue;
      }

      // A read receipt is independent of the next video. Wake at most every 45s so a message
      // that arrives between two sends is marked read long before the next gap finishes.
      if (state.readEnabled !== false && state.conversationId && state.conversationShortId
        && (!state.lastReadAt || t - Number(state.lastReadAt) >= readEveryMs)) {
        state = await markSlowRead(cfg, state, t, read);
        if (!slowMail.isLive(state)) {
          logSlowTerminal(cfg, state);
          return { ok: true, status: state.status, sent: state.sent };
        }
        continue;
      }

      if (t < Number(state.nextAt)) {
        const left = Math.min(2000, Number(state.nextAt) - t);
        if (!(await wait(left, cfg))) continue;
        continue;
      }

      const startedAt = nowMs();
      let res = await send(sessionCfg, { keepBrowser: true }).catch((e) => ({ ok: false, error: e.message, code: e.code }));
      browserOwned = browserOwned || !!(res && res.browserOwned);
      let kind = res && res.ok ? '' : classifyFailure(res);

      if (!res || !res.ok) {
        if (kind !== 'blocked') {
          repos.logEvent('slow-retry', {
            account: cfg.accountLabel, sessionId: state.id, sent: state.sent,
            n: Number(state.sent) + 1,
            error: (res && (res.error || res.reason)) || 'send failed', kind,
          });
          if (!(await wait(retryDelayMs, cfg))) continue;
          const check = repos.getSlowMailState(cfg.accountId);
          if (check && check.updatedAt !== state.updatedAt && !slowMail.isLive(check)) {
            state = check;
            logSlowTerminal(cfg, state, { by: 'panel' });
            return { ok: true, status: state.status, sent: state.sent };
          }
          let retryCfg = null;
          try {
            retryCfg = slowSessionCfg(runtimeConfig(cfg.accountLabel), state);
          } catch (e) {
            kind = 'blocked';
            res = { ok: false, error: e.message, code: 'friend' };
          }
          if (retryCfg) {
            res = await send(retryCfg, { keepBrowser: true }).catch((e) => ({ ok: false, error: e.message, code: e.code }));
            browserOwned = browserOwned || !!(res && res.browserOwned);
            kind = res && res.ok ? '' : classifyFailure(res);
            sessionCfg = retryCfg;
          }
        }
      }

      if (!res || !res.ok) {
        const at = nowMs();
        const failed = slowMail.afterFailure(state, {
          nowMs: at, kind, error: (res && (res.error || res.reason)) || 'send failed',
        });
        state = persistSlow(cfg, failed);
        repos.logEvent('slow-fail', {
          account: cfg.accountLabel, sessionId: state.id, kind, error: state.lastError,
          n: Number(state.sent) + 1,
          failed: state.failed,
          consecutive: kind === 'exhausted' ? state.consecutiveNoCandidate : state.consecutiveFailures,
        });
        if (!slowMail.isLive(state)) {
          logSlowTerminal(cfg, state);
          return { ok: false, status: state.status, error: state.lastError, sent: state.sent };
        }
        continue;
      }

      const finished = nowMs();
      const after = slowMail.afterSend(state, {
        atMs: startedAt, durationMs: res.durationMs, title: res.title, nowMs: finished, random,
      });
      repos.logEvent('slow-send', {
        account: cfg.accountLabel, sessionId: after.state.id, friend: after.state.friend,
        friendUid: after.state.friendUid || sessionCfg.friendUserId || '',
        n: after.state.sent, maxSends: after.state.maxSends,
        title: res.title || '', durationMs: Math.max(0, Number(res.durationMs) || 0),
        gapMs: after.gap.gapMs, baseMs: after.gap.baseMs,
        floorMs: after.gap.referenceMs, floored: after.gap.floored,
        nextAt: after.nextAt ? new Date(after.nextAt).toISOString() : null,
      });

      // The panel may have stopped us while the send was in flight. Log the send above, then
      // honor the newer terminal state instead of resurrecting it.
      const latestStored = repos.getSlowMailState(cfg.accountId);
      if (latestStored && latestStored.updatedAt > after.state.updatedAt && !slowMail.isLive(latestStored)) {
        state = latestStored;
        logSlowTerminal(cfg, state, { by: 'panel' });
        return { ok: true, status: state.status, sent: state.sent };
      }
      const saved = persistSlow(cfg, {
        ...after.state,
        conversationId: res.conversationId || after.state.conversationId || '',
        conversationShortId: res.conversationShortId || after.state.conversationShortId || '',
      });
      state = saved;
      // Mark read immediately after the send; periodic reads continue while the window runs.
      if (state.readEnabled !== false && state.conversationId && state.conversationShortId) {
        state = await markSlowRead(cfg, state, nowMs(), read);
      }
      if (!slowMail.isLive(state)) {
        logSlowTerminal(cfg, state);
        return { ok: true, status: state.status, sent: state.sent };
      }
    }
  } finally {
    if (browserOwned) await stopServer(cfg).catch(() => false);
  }
}

// The daily loop sleeps 60s when the plan is done; sample the slow state so a click is picked
// up within a few seconds instead of a minute.
async function waitForIdle(ms, cfg) {
  const deadline = Date.now() + Math.max(0, Number(ms) || 0);
  while (Date.now() < deadline) {
    if (!accountEnabled(cfg)) return false;
    if (slowMail.isLive(repos.getSlowMailState(cfg.accountId))) return true;
    await sleep(Math.min(3000, Math.max(250, deadline - Date.now())));
  }
  return accountEnabled(cfg);
}

// Standalone read receipts run in the per-account scheduler child, independently from the daily
// plan and slow-mail. A 5s poll only performs the read when the persisted nextAt is due; the next
// time is a random 10-60 min interval (or a fixed frequency inside the configured window).
let autoReadTimer = null;
let autoReadBusy = false;

function startAutoReadLoop() {
  if (autoReadTimer) return;
  const tick = async () => {
    if (!autoReadBusy) {
      autoReadBusy = true;
      try {
        const label = process.env.ACCOUNT || repos.getSetting('activeAccount', null);
        const acc = label ? repos.getAccount(label) : null;
        if (acc) await autoRead.tick(acc);
      } catch (e) {
        // autoRead.tick records its own state; never let the watcher kill the scheduler.
      } finally {
        autoReadBusy = false;
      }
    }
    autoReadTimer = setTimeout(tick, autoRead.POLL_MS);
  };
  autoReadTimer = setTimeout(tick, 3000);
}

async function runLoop({ once = false } = {}) {
  for (;;) {
    const cfg = runtimeConfig();
    if (!cfg.enabled) {
      pauseSlowIfNeeded(cfg);
      if (once) return { ok: false, reason: 'disabled' };
      // Wake quickly on resume so a paused slow-mail does not wait the old five minutes.
      for (let i = 0; i < 150 && !accountEnabled(cfg); i += 1) await sleep(2000);
      continue;
    }
    if (!Array.isArray(cfg.friends) || !cfg.friends.length) {
      if (once) return { ok: false, reason: 'no friends configured' };
      repos.logEvent('no-friends', { account: cfg.accountLabel });
      await sleep(5 * 60 * 1000);
      continue;
    }
    const slow = repos.getSlowMailState(cfg.accountId);
    if (slowMail.isLive(slow)) {
      const r = await runSlowMail(cfg, slow);
      if (once) return r;
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
    if (r && r.slowPending) continue;
    // done / all triggers settled: re-check once a minute so a config edit (or the next day)
    // is picked up without restarting the scheduler child. Slow-mail state is sampled every 3s.
    await waitForIdle(60 * 1000, cfg);
  }
}

module.exports = {
  runLoop, runSchedule, runBurst: runSchedule, runSlowMail, startAutoReadLoop,
  sendOne, sendOneBrowser, apiAttempt, runtimeConfig, startServer, stopServer,
};
