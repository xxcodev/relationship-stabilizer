/**
 * @file HTTP control panel: renders the UI and exposes the /api endpoints backed by SQLite.
 */
// Dashboard backed by SQLite. Same UI as the prototype, but every value comes from the DB.
const http = require('http');
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
    friend: acc.friend,
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
    enabled: !!acc.enabled,
    friend: acc.friend,
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

async function statusFromDb() {
  const acc = currentAccount();
  const sched = service.schedulerStatus();
  const browser = await service.browserStatus(acc.port);
  return { scheduler: sched, browser, account: acc.label, enabled: !!acc.enabled };
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
    conn
      .prepare('UPDATE accounts SET friend = ?, enabled = ? WHERE id = ?')
      .run(cfg.friend, cfg.enabled ? 1 : 0, acc.id);
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
        const session = apiSession.load();
        const state = apiSession.status(session, acc.friend);
        return send(res, 200, {
          present: !!session,
          valid: state.valid,
          reason: state.reason || null,
          ageHours: state.ageHours,
          createdAt: (session && session.createdAt) || null,
          account: (session && session.account) || null,
          friend: (session && session.friend) || null,
          defaultFriend: acc.friend,
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
          const child = spawn(process.execPath, [path.join(env.ROOT, 'src', 'index.js'), 'api:export'], {
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
        const friend = String(input.friend || acc.friend || '').trim();
        const dry = !!input.dry;
        const apiSender = require('./api-sender');
        const session = apiSession.load();
        const state = apiSession.status(session, acc.friend);
        if (!state.valid) return send(res, 400, { ok: false, error: `api session 不可用：${state.reason}` });
        const pools = repos.listPools().filter((p) => p.enabled);
        if (!pools.length) return send(res, 400, { ok: false, error: '没有启用的视频池' });
        const pool = pools[Math.floor(Math.random() * pools.length)];
        try {
          const video = await apiSender.pick(session, { keyword: pool.keyword, banWords: repos.getSetting('banWords', []) });
          if (dry) {
            return send(res, 200, { ok: true, dry: true, friend, picked: video });
          }
          const out = await apiSender.sendVideo(session, video, { friend });
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
          return send(res, out.ok ? 200 : 502, out);
        } catch (e) {
          repos.logEvent('api-send-error', { error: (e.message || '').split('\n')[0], friend });
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
      if (u.pathname === '/api/accounts/switch' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const { label } = JSON.parse(body || '{}');
        const target = repos.getAccount(String(label || ''));
        if (!target) return send(res, 404, { ok: false, error: `没有账户 ${label}` });
        const from = currentAccount().label;
        repos.setSetting('activeAccount', target.label);
        repos.logEvent('account-switch', { from, to: target.label });
        const restarted = service.restartScheduler();
        return send(res, 200, { ok: true, active: target.label, restarted });
      }
      if (u.pathname === '/api/accounts') {
        const rows = require('./db').open().prepare('SELECT * FROM accounts ORDER BY id').all();
        const accounts = rows.map((a) => ({
          id: a.id,
          label: a.label,
          port: a.port,
          friend: a.friend,
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
        const restarted = service.restartScheduler();
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
