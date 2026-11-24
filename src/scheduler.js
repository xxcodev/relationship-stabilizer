/**
 * @file Scheduler loop: reads config from SQLite, plans the day, drives browser-server, writes results back.
 */
// Scheduler: reads its whole configuration from SQLite, drives the browser server,
// and records plans/sends back into SQLite.
const { spawn } = require('child_process');
const path = require('path');
const env = require('./env');
const repos = require('./repos');
const planner = require('./planner');
const picker = require('./picker');
const apiSender = require('./api-sender');
const apiSession = require('./api-session');

const hm = planner.hm;
const sleep = picker.sleep;
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function runtimeConfig(accountLabel = process.env.ACCOUNT || null) {
  const acc = repos.getAccount(accountLabel || repos.getSetting('activeAccount', null));
  if (!acc) throw new Error('no account configured');
  const bands = repos.listBands(acc.id).map((b) => ({
    name: b.name,
    from: b.start_min,
    to: b.end_min,
    min: b.min_count,
    max: b.max_count,
  }));
  const cfg = planner.normalize({
    enabled: !!acc.enabled,
    bands,
    minGapMinutes: repos.getSetting('minGapMinutes', 5),
    totalMin: repos.getSetting('totalMin', 0),
    totalMax: repos.getSetting('totalMax', 0),
  });
  cfg.friend = acc.friend;
  cfg.accountId = acc.id;
  cfg.profileDir = env.browserProfileDir(acc.profile_dir);
  cfg.port = acc.port;
  cfg.pools = repos.listPools().map((p) => ({ name: p.name, keyword: p.keyword, enabled: !!p.enabled }));
  cfg.banWords = repos.getSetting('banWords', []);
  cfg.poolDelayMs = repos.getSetting('poolDelayMs', 2500);
  // 'auto' = try the pure-HTTP path first, fall back to the browser; 'browser' = old behavior
  cfg.sendMode = repos.getSetting('sendMode', 'auto');
  cfg.accountLabel = acc.label;
  cfg.accountName = acc.display_name || acc.label;
  cfg.friends = repos.listEnabledFriendNames(acc.id);
  if (!cfg.friends.length && acc.friend) cfg.friends = [acc.friend];
  cfg.friend = cfg.friends[0] || acc.friend || '';
  return cfg;
}

const baseOf = (cfg) => `http://127.0.0.1:${cfg.port}`;

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

/**
 * Pure-HTTP attempt. Returns a result object when the API path handled the send, or null to let
 * the caller fall back to the browser path (no/invalid session, template rejected, network error).
 */
async function apiAttempt(cfg, { dryRun = false } = {}) {
  if (cfg.sendMode === 'browser') return null;
  const session = apiSession.load(cfg.accountLabel);
  const state = apiSession.status(session, null);
  if (!state.valid) {
    if (session) repos.logEvent('api-session-invalid', { account: cfg.accountLabel, reason: state.reason, ageHours: state.ageHours });
    return null;
  }
  const friends = (cfg.friends || []).filter((f) => apiSession.canSendTo(session, f));
  if (!friends.length) {
    repos.logEvent('api-fallback-friend', { account: cfg.accountLabel, friends: cfg.friends });
    return null;
  }
  const friend = friends[Math.floor(Math.random() * friends.length)];
  cfg.friend = friend;
  const pools = cfg.pools.filter((p) => p.enabled);
  if (!pools.length) return null;
  const pool = pools[Math.floor(Math.random() * pools.length)];
  try {
    const video = await apiSender.pick(session, { keyword: pool.keyword, banWords: cfg.banWords });
    if (dryRun) {
      repos.logEvent('api-dry-run', { account: cfg.accountLabel, friend, title: video.title, pool: pool.name });
      return { ok: true, dryRun: true, api: true, title: video.title, friend, video };
    }
    const res = await apiSender.sendVideo(session, video, { friend });
    if (res.ok) {
      repos.insertSend({
        accountId: cfg.accountId,
        ts: new Date().toISOString(),
        day: ymd(new Date()),
        bucket: pool.name,
        title: video.title,
        author: video.author,
        likes: video.likes,
        friend: cfg.friend,
        ok: true,
        toast: 'HTTP API',
        shot: null,
        videoId: video.awemeId,
      });
      repos.logEvent('sent-api', { account: cfg.accountLabel, pool: pool.name, friend, title: video.title, serverMessageId: res.serverMessageId });
      return { ok: true, api: true, title: video.title, friend, toast: 'HTTP API', serverMessageId: res.serverMessageId };
    }
    repos.logEvent('api-send-rejected', { statusCode: res.statusCode, statusMessage: res.statusMessage, title: video.title, friend });
    return null;
  } catch (e) {
    repos.logEvent('api-send-error', { error: (e.message || '').split('\n')[0], friend });
    return null;
  }
}

async function sendOne(cfg, { dryRun = false } = {}) {
  if (!Array.isArray(cfg.friends) || !cfg.friends.length) return { ok: false, error: 'no friend configured' };
  if (Array.isArray(cfg.friends) && cfg.friends.length) {
    cfg.friend = cfg.friends[Math.floor(Math.random() * cfg.friends.length)];
  }
  const api = await apiAttempt(cfg, { dryRun });
  if (api) return api;
  const startedHere = !(await serverUp(cfg));
  if (startedHere && !(await startServer(cfg))) return { ok: false, error: 'server failed' };
  try {
    return await sendOneBrowser(cfg, { dryRun });
  } finally {
    if (startedHere) await stopServer(cfg);
  }
}

async function sendOneBrowser(cfg, { dryRun = false } = {}) {
  const base = baseOf(cfg);
  const health = await serverUp(cfg);
  if (health && health.challenge) {
    repos.logEvent('captcha-blocked', { port: cfg.port, url: health.url });
    return { ok: false, error: 'captcha' };
  }
  const { picked } = await picker.pick({
    base,
    pools: cfg.pools,
    banWords: cfg.banWords,
    count: 1,
    poolDelayMs: cfg.poolDelayMs,
  });
  const target = picked[0];
  if (!target) return { ok: false, error: 'no candidate' };
  const opened = await picker.open(base, target);
  if (!opened.ok) return { ok: false, error: opened.error, title: target.title };

  await fetch(base + '/openshare', { method: 'POST' }).then((r) => r.json()).catch(() => ({}));
  if (dryRun) {
    const check = await fetch(base + '/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: cfg.friend, confirm: false }),
    }).then((r) => r.json());
    return { ok: !!check.ok, dryRun: true, title: target.title, check };
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
  });
  return res;
}

async function runDay(cfg, day) {
  let plan = repos.getPlan(cfg.accountId, day);
  if (!plan || !plan.times.length) {
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    const remaining = cfg.windowEnd - nowMin;
    // a machine that slept through the morning wakes up mid-window: plan the rest of the day
    // instead of throwing the whole day away (only give up when the window is nearly over)
    if (remaining < 45) {
      repos.savePlan(cfg.accountId, day, { times: [], skipped: true });
      repos.logEvent('day-skipped-late-start', { day, at: hm(nowMin), remaining });
      return { skipped: true };
    }
    const start = Math.max(cfg.windowStart, nowMin + 3);
    const p = planner.planDay(cfg, start);
    plan = repos.savePlan(cfg.accountId, day, { times: p.times });
    repos.logEvent('day-plan', {
      day, count: p.count, allocation: p.allocation, start: hm(start), lateStart: start > cfg.windowStart,
      times: p.times.map(hm),
    });
  }

  const settled = new Set([...(plan.done || []), ...(plan.failed || [])]);
  const pending = plan.times.filter((t) => !settled.has(t));
  let sent = 0;
  let started = false;
  for (const t of pending) {
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    if (nowMin > cfg.windowEnd) break;
    if (t < nowMin - 25) {
      const cur = repos.getPlan(cfg.accountId, day);
      repos.savePlan(cfg.accountId, day, { times: cur.times, done: cur.done, failed: [...cur.failed, t], skipped: false });
      repos.logEvent('slot-missed', { day, at: hm(t), now: hm(nowMin) });
      continue;
    }
    const target = new Date(now);
    target.setHours(Math.floor(t / 60), t % 60, Math.floor(Math.random() * 60), 0);
    const lead = target.getTime() - 3 * 60 * 1000;
    if (lead > Date.now()) await sleep(lead - Date.now());
    const session = apiSession.load(cfg.accountLabel);
    const apiReady =
      cfg.sendMode !== 'browser' &&
      apiSession.status(session, null).valid &&
      (cfg.friends || []).some((f) => apiSession.canSendTo(session, f));
    if (!started && !apiReady) {
      started = await startServer(cfg);
      if (!started) return { ok: false, reason: 'server failed' };
    }
    if (target.getTime() > Date.now()) await sleep(target.getTime() - Date.now());
    let res = await sendOne(cfg).catch((e) => ({ ok: false, error: e.message }));
    await stopServer(cfg);
    started = false;

    // one retry per slot; a second failure skips the slot instead of hammering the site
    if (!res || !res.ok) {
      repos.logEvent('send-retry', { day, at: hm(t), res: res && (res.error || res.reason) });
      await sleep(90 * 1000);
      started = await startServer(cfg);
      if (started) {
        res = await sendOne(cfg).catch((e) => ({ ok: false, error: e.message }));
        await stopServer(cfg);
        started = false;
      }
    }

    if (res && res.ok) {
      const cur = repos.getPlan(cfg.accountId, day);
      repos.savePlan(cfg.accountId, day, { times: cur.times, done: [...cur.done, t], failed: cur.failed, skipped: false });
      sent++;
      repos.logEvent('sent', { day, at: hm(t) });
    } else if (res && res.error === 'captcha') {
      // human must solve it in the visible window; leave the slot unattempted
      repos.logEvent('captcha-blocked', { day, at: hm(t) });
      break;
    } else {
      const cur = repos.getPlan(cfg.accountId, day);
      repos.savePlan(cfg.accountId, day, { times: cur.times, done: cur.done, failed: [...cur.failed, t], skipped: false });
      repos.logEvent('send-failed', { day, at: hm(t), res });
      break;
    }
  }
  if (started) await stopServer(cfg);
  return { ok: true, sent };
}

async function runLoop({ once = false } = {}) {
  for (;;) {
    const cfg = runtimeConfig();
    const now = new Date();
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
    const day = ymd(now);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    if (nowMin >= cfg.windowStart && nowMin < cfg.windowEnd) {
      const r = await runDay(cfg, day);
      if (once) return r;
      const plan = repos.getPlan(cfg.accountId, day);
      if (plan && plan.skipped) {
        const next = new Date(now);
        next.setDate(next.getDate() + 1);
        next.setHours(Math.floor(cfg.windowStart / 60), cfg.windowStart % 60, 0, 0);
        await sleep(Math.max(1000, next - now));
        continue;
      }
      await sleep(60 * 1000);
      continue;
    }
    if (once) return { ok: false, reason: 'outside window', window: `${hm(cfg.windowStart)}-${hm(cfg.windowEnd)}` };
    const next = new Date(now);
    if (nowMin >= cfg.windowEnd) next.setDate(next.getDate() + 1);
    next.setHours(Math.floor(cfg.windowStart / 60), cfg.windowStart % 60, 0, 0);
    await sleep(Math.max(1000, next - now));
  }
}

module.exports = { runLoop, runDay, sendOne, sendOneBrowser, apiAttempt, runtimeConfig, startServer, stopServer };
