/**
 * @file Export a pure-HTTP send session: cookies + one aborted (captured) send template.
 *
 * Runs a short-lived, minimized browser through one "share to friend" flow while browser-server's
 * POC capture hooks record the outgoing /v1/message/send request and ABORT it. Nothing is
 * delivered during export; the captured request becomes the template used by api-sender.js.
 *
 * The exported file contains login cookies and a session ticket: it is written with mode 0600
 * under DATA_DIR and should be refreshed periodically (default max age 12h, see api-session.js).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const env = require('./env');
const repos = require('./repos');
const apiSession = require('./api-session');
const { EXTRACT, OPEN_STEP } = require('./picker');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(logger, message) {
  if (logger) logger(message);
  else console.log(message);
}

async function postJson(base, endpoint, body, timeout = 15000) {
  const res = await fetch(base + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(timeout),
  });
  return res.json();
}

async function stateOf(base) {
  try {
    const res = await fetch(base + '/state', { signal: AbortSignal.timeout(3000) });
    return res.ok ? await res.json() : null;
  } catch (e) {
    return null;
  }
}

async function driveShare({ port, friend, keyword, logger }) {
  const base = `http://127.0.0.1:${port}`;
  log(logger, `打开搜索页（关键词：${keyword}）`);
  await postJson(base, '/goto', { url: `https://www.douyin.com/search/${encodeURIComponent(keyword)}` });

  let cards = [];
  for (let i = 0; i < 10; i++) {
    await sleep(1600);
    const out = await postJson(base, '/eval', { js: EXTRACT });
    cards = out.out || [];
    if (cards.length >= 3) break;
  }
  if (!cards.length) throw new Error('搜索页没有加载出视频卡片（可能需要登录或触发了验证码）');
  log(logger, `找到 ${cards.length} 个视频，打开第一个`);
  const title = (cards[0].txt || '').replace(/\s+/g, ' ').trim();

  let opened = false;
  for (let tick = 0; tick < 22; tick++) {
    await sleep(1500);
    const hit = await postJson(base, '/eval', { js: OPEN_STEP(title) });
    if (hit.out) {
      await sleep(400);
      await postJson(base, '/click', { x: hit.out.x, y: hit.out.y });
      await sleep(3000);
      const state = await stateOf(base);
      if (state && /modal_id=\d+/.test(state.url)) {
        opened = true;
        break;
      }
    } else if (tick === 5) {
      await postJson(base, '/eval', { js: 'window.scrollBy(0, 600); true' });
    }
  }
  if (!opened) throw new Error('视频详情没有打开');

  let share = null;
  for (let i = 0; i < 5; i++) {
    share = await postJson(base, '/openshare');
    if (share.ok) break;
    await sleep(2000);
  }
  log(logger, `点击好友「${friend}」（发送请求会被捕获并中断）`);
  const sent = await postJson(base, '/send', { name: friend, confirm: true });
  await sleep(1500);
  return { sent, friends: (share && share.rows) || [] };
}

function findSearchUrl(captureDir) {
  const file = path.join(captureDir, 'all.jsonl');
  if (!fs.existsSync(file)) return null;
  const lines = fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);
  const searches = lines.filter((l) => l.kind === 'request' && /general\/search\/single/.test(l.url));
  return searches.length ? searches[searches.length - 1].url : null;
}

function pickKeyword(acc, keyword) {
  if (keyword) return { keyword, pool: '' };
  const pool = repos.listPools().find((p) => p.enabled);
  if (!pool) throw new Error('没有启用的视频池');
  return { keyword: pool.keyword, pool: pool.name };
}

/**
 * @param {{accountLabel?:string, keyword?:string, logger?:Function}} opts
 */
async function exportSession({ accountLabel = process.env.ACCOUNT || null, keyword, logger } = {}) {
  const acc = repos.getAccount(accountLabel);
  if (!acc) throw new Error('没有账号，请先 init 或导入数据');
  if (!acc.friend) throw new Error('账号还没有配置好友，先在面板里填写好友昵称');

  const base = `http://127.0.0.1:${acc.port}`;
  if (await stateOf(base)) {
    throw new Error('浏览器正在运行（抖音画面/发送中），请先关闭后再导出会话');
  }

  const chosen = pickKeyword(acc, keyword);
  const captureDir = path.join(env.DATA_DIR, 'api-capture-tmp');
  fs.rmSync(captureDir, { recursive: true, force: true });
  fs.mkdirSync(captureDir, { recursive: true });
  const profile = env.browserProfileDir(acc.profile_dir);

  log(logger, `启动临时浏览器（最小化）… profile=${profile}`);
  const child = spawn(
    process.execPath,
    [path.join(__dirname, 'browser-server.js'), '--profile', profile, '--port', String(acc.port)],
    {
      cwd: env.ROOT,
      env: { ...process.env, POC_CAPTURE_DIR: captureDir, POC_ABORT_SEND: '1' },
      stdio: 'ignore',
    }
  );

  try {
    let state = null;
    for (let i = 0; i < 120; i++) {
      await sleep(1000);
      state = await stateOf(base);
      if (state) break;
      if (child.exitCode !== null) break;
    }
    if (!state) throw new Error('浏览器启动失败（profile 可能被占用，或需要先扫码登录）');
    if (!state.loggedIn) log(logger, '提示：当前浏览器看起来未登录，如果流程失败请先在应用里扫码登录');

    const drive = await driveShare({ port: acc.port, friend: acc.friend, keyword: chosen.keyword, logger });

    const bundleRes = await fetch(base + '/poc/bundle', { signal: AbortSignal.timeout(10000) });
    const bundle = await bundleRes.json();
    if (!bundle || !bundle.lastSend || !bundle.lastSend.bodyB64) {
      throw new Error('没有捕获到发送请求（分享面板可能没有打开，或好友昵称不匹配）');
    }
    if (!Array.isArray(bundle.cookies) || !bundle.cookies.length) {
      throw new Error('没有捕获到 cookies');
    }
    const searchUrl = findSearchUrl(captureDir);
    if (!searchUrl) throw new Error('没有捕获到搜索请求（只读 API 将不可用）');

    const friends = (drive.friends || [])
      .filter((row) => row && row.name && row.userid)
      .map((row) => ({ name: row.name, userid: String(row.userid) }));
    const session = {
      version: 2,
      createdAt: new Date().toISOString(),
      account: acc.label,
      friend: acc.friend,
      keyword: chosen.keyword,
      pool: chosen.pool,
      searchUrl,
      template: {
        url: bundle.lastSend.url,
        headers: bundle.lastSend.headers,
        bodyB64: bundle.lastSend.bodyB64,
      },
      createTemplate: bundle.lastCreate
        ? { url: bundle.lastCreate.url, headers: bundle.lastCreate.headers, bodyB64: bundle.lastCreate.bodyB64 }
        : null,
      friends,
      cookies: bundle.cookies,
    };
    const file = apiSession.save(session);
    log(logger, `会话已保存：${file}`);
    log(logger, `账号 ${acc.label} → 好友 ${acc.friend}，模板 ${bundle.lastSend.bodyB64.length} base64 字符，cookies ${bundle.cookies.length} 条`);
    return {
      ok: true,
      file,
      account: acc.label,
      friend: acc.friend,
      keyword: chosen.keyword,
      friends: friends.length,
      hasCreateTemplate: !!session.createTemplate,
      session,
    };
  } finally {
    await fetch(base + '/quit', { method: 'POST', signal: AbortSignal.timeout(3000) }).catch(() => {});
    await sleep(500);
    try {
      if (child.exitCode === null) child.kill('SIGTERM');
    } catch (e) {}
    fs.rmSync(captureDir, { recursive: true, force: true });
  }
}

module.exports = { exportSession, driveShare, findSearchUrl };
