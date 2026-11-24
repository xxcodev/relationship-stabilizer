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
const planner = require('./planner');
const service = require('./service');
const apiSession = require('./api-session');

function settingOn(key, dflt = '1') {
  const value = repos.getSetting(key, dflt);
  return !(value === 0 || value === '0' || value === false);
}

const SHOTS_DIR = path.resolve(env.ROOT, process.env.SHOTS_DIR || path.join('data', 'shots'));

const hm = planner.hm;
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

const ACCOUNT_LABEL = process.env.ACCOUNT || null;
const activeLabel = () => repos.getSetting('activeAccount', ACCOUNT_LABEL);

function currentAccount() {
  const acc = repos.getAccount(activeLabel());
  if (!acc) throw new Error('no account configured — run `npm run migrate -- <legacyDir>` or `npm run init`');
  return acc;
}

function configFromDb() {
  const acc = currentAccount();
  const bands = repos.listBands(acc.id).map((b) => ({
    name: b.name,
    from: hm(b.start_min),
    to: hm(b.end_min),
    min: b.min_count,
    max: b.max_count,
  }));
  const pools = {};
  for (const p of repos.listPools()) pools[p.name] = !!p.enabled;
  return {
    enabled: !!acc.enabled,
    friend: repos.listEnabledFriendNames(acc.id)[0] || acc.friend,
    minGapMinutes: repos.getSetting('minGapMinutes', 5),
    poolDelayMs: repos.getSetting('poolDelayMs', 2500),
    totalMin: repos.getSetting('totalMin', 0),
    totalMax: repos.getSetting('totalMax', 0),
    bands,
    pools,
    banWords: repos.getSetting('banWords', []),
  };
}

function dataFromDb() {
  const acc = currentAccount();
  const day = today();
  const plan = repos.getPlan(acc.id, day);
  const sends = repos.listSends({ accountId: acc.id, limit: 200 });
  return {
    account: acc.label,
    accountName: acc.display_name || acc.label,
    enabled: !!acc.enabled,
    friend: repos.listEnabledFriendNames(acc.id)[0] || acc.friend,
    friends: repos.listEnabledFriendNames(acc.id),
    todayPlan: plan ? plan.times.length : 0,
    todayDone: repos.countSendsByDay(day, acc.id),
    todayTimeline: (plan ? plan.times : []).map((t) => ({
      time: hm(t),
      status: (plan.done || []).includes(t) ? 'done' : (plan.failed || []).includes(t) ? 'failed' : 'pending',
    })),
    nextTime: (() => {
      const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
      const row = (plan ? plan.times : []).find((t) => !(plan.done || []).includes(t) && !(plan.failed || []).includes(t) && t > nowMin);
      return row === undefined ? null : hm(row);
    })(),
    totalSends: sends.length,
    bucketStats: Object.fromEntries(repos.bucketStats(acc.id).map((r) => [r.bucket || '-', r.n])),
    sends: sends.map((s) => ({
      ts: s.ts,
      local: new Date(s.ts).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }),
      bucket: s.bucket,
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
const sendJob = { id: null, startedAt: null, status: 'idle', result: null, dry: false };

async function runSendJob({ dry = false } = {}) {
  const scheduler = require('./scheduler');
  const cfg = scheduler.runtimeConfig();
  sendJob.id = `job-${Date.now()}`;
  sendJob.startedAt = new Date().toISOString();
  sendJob.status = 'running';
  sendJob.result = null;
  sendJob.dry = dry;
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
      let maxTime = 0;
      let offset = 0;
      let page = 0;
      let scanned = 0;
      let error = null;
      while (page < 30) {
        const url = '/aweme/v1/web/user/following/list/?' + common + '&sec_user_id=' + sec + '&max_time=' + maxTime + '&offset=' + offset;
        const j = await fetch(url, { credentials: 'include', headers: { referer: location.href } })
          .then((r) => r.json()).catch((e) => ({ error: e.message }));
        if (!j || j.status_code !== 0) { error = String((j && (j.status_msg || j.error)) || '接口失败'); break; }
        const list = j.followings || [];
        let added = 0;
        for (const u of list) {
          const id = String(u.uid || u.sec_uid || '');
          if (!id || seen.has(id)) continue;
          seen.add(id);
          scanned++;
          added++;
          // follow_status 2 / relation_label 好友 = 互相关注
          if (u.follow_status === 2 || (u.relation_label && String(u.relation_label).includes('好友'))) {
            if (seenMutual.has(id)) continue;
            seenMutual.add(id);
            mutual.push({ name: u.nickname || '', uid: String(u.uid || ''), sec_uid: u.sec_uid || '', unique_id: u.unique_id || '' });
          }
        }
        if (!j.has_more || !added) break;
        maxTime = j.max_time || maxTime;
        offset = 0;
        page++;
      }
      return {
        ok: true,
        self: { nickname: prof.user.nickname, uid: String(prof.user.uid || ''), sec_uid: prof.user.sec_uid },
        mutual,
        following: scanned,
        followingTotal: Number(prof.user.following_count) || scanned,
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
  const bands = (Array.isArray(src.bands) ? src.bands : [])
    .map((b) => ({
      name: String(b.name || '时段').slice(0, 12),
      from: planner.toMin(b.from),
      to: planner.toMin(b.to),
      min: Math.max(0, Math.min(200, Math.round(Number(b.min) || 0))),
      max: Math.max(0, Math.min(200, Math.round(Number(b.max) || 0))),
    }))
    .filter((b) => b.from !== null && b.to !== null && b.to > b.from && b.max >= b.min);
  if (!bands.length) throw new Error('至少需要一个有效时段(结束时间要晚于开始时间)');
  const totalMin = Math.max(0, Math.min(200, Math.round(Number(src.totalMin) || 0)));
  const totalMax = Math.max(totalMin, Math.min(200, Math.round(Number(src.totalMax) || 0)));
  return {
    enabled: src.enabled !== false,
    friend: String(src.friend || '').trim(),
    minGapMinutes: Math.min(120, Math.max(1, Number(src.minGapMinutes) || 5)),
    poolDelayMs: Math.min(30000, Math.max(0, Math.round(Number(src.poolDelayMs ?? 2500)))),
    totalMin,
    totalMax,
    bands,
    pools: src.pools && typeof src.pools === 'object' ? src.pools : {},
    banWords: (Array.isArray(src.banWords) ? src.banWords : [])
      .map((w) => String(w).trim())
      .filter(Boolean)
      .slice(0, 200),
  };
}

function persist(cfg) {
  const acc = currentAccount();
  const conn = require('./db').open();
  conn.exec('BEGIN');
  try {
    conn.prepare('UPDATE accounts SET enabled = ? WHERE id = ?').run(cfg.enabled ? 1 : 0, acc.id);
    repos.syncAccountFriend(acc.id);
    repos.setSetting('minGapMinutes', cfg.minGapMinutes);
    repos.setSetting('poolDelayMs', cfg.poolDelayMs);
    repos.setSetting('totalMin', cfg.totalMin);
    repos.setSetting('totalMax', cfg.totalMax);
    repos.setSetting('banWords', cfg.banWords);
    repos.replaceBands(
      acc.id,
      cfg.bands.map((b) => ({
        name: b.name,
        startMin: b.from,
        endMin: b.to,
        minCount: b.min,
        maxCount: b.max,
      }))
    );
    for (const p of repos.listPools()) {
      if (Object.prototype.hasOwnProperty.call(cfg.pools, p.name)) {
        repos.setPoolEnabled(p.name, cfg.pools[p.name] !== false);
      }
    }
    conn.exec('COMMIT');
  } catch (e) {
    conn.exec('ROLLBACK');
    throw e;
  }
  return configFromDb();
}

const PAGE = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8');

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
      if (u.pathname === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        const pools = repos.listPools().map((p) => p.name);
        return res.end(PAGE.replace('__POOL_NAMES__', JSON.stringify(pools)));
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
        if (sendJob.status === 'running') return send(res, 409, { ok: false, error: '已经有一条在发送中' });
        const acc = currentAccount();
        const browser = await service.browserStatus(acc.port);
        if (browser.up) return send(res, 409, { ok: false, error: '浏览器窗口已被占用(可能调度正在发送),稍后再试' });
        let dry = false;
        try {
          const body = await new Promise((resolve) => {
            let b = '';
            req.on('data', (c) => (b += c));
            req.on('end', () => resolve(b));
          });
          dry = !!(JSON.parse(body || '{}').dry);
        } catch (e) {}
        runSendJob({ dry }).catch(() => {});
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
          sendMode: repos.getSetting('sendMode', 'auto'),
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
        const apiSender = require('./api-sender');
        const session = apiSession.load(acc.label);
        const state = apiSession.status(session, null);
        if (!state.valid) return send(res, 400, { ok: false, error: `api session 不可用：${state.reason}` });
        const pools = repos.listPools().filter((p) => p.enabled);
        if (!pools.length) return send(res, 400, { ok: false, error: '没有启用的视频池' });
        const pool = pools[Math.floor(Math.random() * pools.length)];
        try {
          const video = await apiSender.pick(session, { keyword: pool.keyword, banWords: repos.getSetting('banWords', []) });
          if (dry) {
            return send(res, 200, { ok: true, dry: true, friends: list, picked: video });
          }
          const results = [];
          for (const friend of list) {
            const row = repos.getFriendByName(acc.id, friend);
            const toUserId = row && row.userid;
            if (!apiSession.canSendTo(session, friend) && !toUserId) {
              results.push({ friend, ok: false, error: '好友不在会话好友列表里，也没有 userid（从互关导入或重新导出会话）' });
              continue;
            }
            const out = await apiSender.sendVideo(session, video, { friend, toUserId }).catch((e) => ({ ok: false, error: e.message }));
            if (out.ok) {
              repos.insertSend({
                accountId: acc.id,
                ts: new Date().toISOString(),
                day: today(),
                bucket: pool.name,
                title: video.title,
                author: video.author,
                likes: video.likes,
                friend,
                ok: true,
                toast: 'HTTP API (panel)',
                shot: null,
                videoId: video.awemeId,
              });
              repos.logEvent('sent-api', { pool: pool.name, title: video.title, friend, serverMessageId: out.serverMessageId, via: 'panel' });
            } else {
              repos.logEvent('api-send-rejected', { statusCode: out.statusCode, statusMessage: out.statusMessage, title: video.title, friend });
            }
            results.push({ ...out, friend });
          }
          const ok = results.some((r) => r.ok);
          return send(res, ok ? 200 : 502, { ok, friends: list, results, video });
        } catch (e) {
          repos.logEvent('api-send-error', { error: (e.message || '').split('\n')[0], friends: list });
          return send(res, 500, { ok: false, error: e.message.split('\n')[0] });
        }
      }
      if (u.pathname === '/api/api-session/mode' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const mode = (JSON.parse(body || '{}') || {}).mode;
        if (!['auto', 'browser'].includes(mode)) return send(res, 400, { ok: false, error: 'mode must be auto|browser' });
        repos.setSetting('sendMode', mode);
        const restarted = service.restartScheduler();
        return send(res, 200, { ok: true, mode, restarted });
      }
      if (u.pathname === '/api/api-session/auto-refresh' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const enabled = !!(JSON.parse(body || '{}') || {}).enabled;
        repos.setSetting('apiAutoRefresh', enabled ? '1' : '0');
        return send(res, 200, { ok: true, enabled });
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
      if (u.pathname === '/api/accounts/mutual-friends' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const input = JSON.parse(body || '{}');
        const acc = input.label ? repos.getAccount(String(input.label)) : currentAccount();
        if (!acc) return send(res, 404, { ok: false, error: '账户不存在' });
        try {
          const out = await fetchMutualFriends(acc);
          repos.logEvent('mutual-friends', { account: acc.label, mutual: out.mutual.length, following: out.following, followers: out.followers });
          return send(res, 200, { ok: true, label: acc.label, ...out, errors: out.errors || [] });
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
          bands: repos.listBands(a.id).length,
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
        const restarted = action === 'restart' ? service.restartScheduler() : { ok: true, kind: 'next-loop' };
        return send(res, 200, { ok: true, action, restarted });
      }
      if (u.pathname === '/api/config' && req.method === 'GET') return send(res, 200, configFromDb());
      if (u.pathname === '/api/config' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        return send(res, 200, { ok: true, config: persist(sanitize(JSON.parse(body))) });
      }
      if (u.pathname === '/api/preview' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const cfg = planner.normalize(sanitize(JSON.parse(body)));
        const p = planner.planDay(cfg, cfg.windowStart);
        const bands = cfg.bands.map((b, i) => ({
          name: b.name,
          from: hm(b.from),
          to: hm(b.to),
          n: p.allocation[i].n,
          times: p.times.filter((t) => t >= b.from && t < b.to).map(hm),
        }));
        return send(res, 200, {
          ok: true,
          requested: p.requested,
          count: p.count,
          notes: cfg.adjustNotes || [],
          allocation: p.allocation,
          bands,
          times: p.times.map(hm),
          window: `${hm(cfg.windowStart)}-${hm(cfg.windowEnd)}`,
        });
      }
      if (u.pathname === '/api/apply' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const input = JSON.parse(body);
        persist(sanitize(input.config || {}));
        const acc = currentAccount();
        const day = today();
        const now = new Date();
        const nowMin = now.getHours() * 60 + now.getMinutes();
        const prev = repos.getPlan(acc.id, day);
        const prevDone = prev ? prev.done : [];
        const prevTimes = prev ? prev.times : [];
        const history = prevTimes.filter((t) => prevDone.includes(t));
        const future = (input.times || [])
          .map(planner.toMin)
          .filter((m) => m !== null && m > nowMin)
          .sort((a, b) => a - b);
        const merged = [...new Set([...history, ...future])].sort((a, b) => a - b);
        repos.savePlan(acc.id, day, { times: merged, done: prevDone });
        repos.logEvent('apply', { day, applied: future.length, skipped: (input.times || []).length - future.length });
        return send(res, 200, {
          ok: true,
          applied: future.length,
          skippedPast: (input.times || []).length - future.length,
          nextTimes: future.slice(0, 5).map(hm),
        });
      }
      if (u.pathname === '/api/today/regenerate' && req.method === 'POST') {
        const acc = currentAccount();
        const cfg = planner.normalize(configFromDb());
        const day = today();
        const now = new Date();
        const nowMin = now.getHours() * 60 + now.getMinutes();
        const start = nowMin >= cfg.windowStart ? nowMin + 3 : cfg.windowStart;
        const p = planner.planDay(cfg, start);
        const prev = repos.getPlan(acc.id, day);
        const done = prev ? prev.done : [];
        const history = (prev ? prev.times : []).filter((t) => done.includes(t));
        const merged = [...new Set([...history, ...p.times])].sort((a, b) => a - b);
        repos.savePlan(acc.id, day, { times: merged, done });
        repos.logEvent('replan', { day, count: merged.length });
        return send(res, 200, { ok: true, count: merged.length, times: merged.map(hm) });
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
      return send(res, 500, { ok: false, error: e.message.split('\n')[0] });
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
