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
const sessionRefresh = require('./session-refresh');
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

const RECOMMEND_TAB_JS = `(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, '');
  const nodes = [...document.querySelectorAll('a,div,span')].filter((e) => {
    if (norm(e.textContent) !== '推荐') return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.y < 200 && r.y >= 0;
  });
  if (!nodes.length) return null;
  const link = nodes.find((e) => e.tagName === 'A');
  const el = link || nodes.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + Math.min(r.height / 2, 20)), text: norm(el.textContent) };
})()`;

async function driveShare({ port, friend, keyword, logger }) {
  const base = `http://127.0.0.1:${port}`;
  // Give the recommendation feed time to fire before navigating to search. The feed request
  // is captured into POC_CAPTURE_DIR and replayed later by the pure-HTTP recommendation source.
  log(logger, '预热推荐标签（等待 feed 请求）…');
  // Opening "/?recommend=1" directly is redirected to /jingxuan (the 精选 module feed).
  // Click the actual 推荐 tab from the home page so /aweme/v1/web/tab/feed/ is captured.
  await postJson(base, '/goto', { url: 'https://www.douyin.com/' }).catch(() => ({}));
  await sleep(5000);
  const tab = await postJson(base, '/eval', { js: RECOMMEND_TAB_JS }).catch(() => null);
  if (tab && tab.out) {
    log(logger, `点击推荐 tab (${tab.out.x},${tab.out.y})`);
    await postJson(base, '/click', { x: tab.out.x, y: tab.out.y }).catch(() => ({}));
    await sleep(5000);
  } else {
    // Fallback for a different layout; if it redirects to 精选 we still keep the v2 feed.
    await postJson(base, '/goto', { url: 'https://www.douyin.com/?recommend=1' }).catch(() => ({}));
    await sleep(4000);
  }
  for (let i = 0; i < 3; i++) {
    await sleep(3000);
    await postJson(base, '/eval', { js: 'window.scrollBy(0, 600); true' }).catch(() => ({}));
  }
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

function captureLines(captureDir) {
  const file = path.join(captureDir, 'all.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
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
}

function findSearchUrl(captureDir) {
  const searches = captureLines(captureDir).filter((l) => l.kind === 'request' && /general\/search\/single/.test(l.url));
  return searches.length ? searches[searches.length - 1].url : null;
}

// The home page loads the recommendation feed before export drives the search page.
// Capture its URL (including the site's own signature parameters) for later pure-HTTP replay.
function isFeedRequestUrl(raw) {
  try {
    const u = new URL(String(raw));
    if (!/(^|\.)douyin\.com$/i.test(u.hostname)) return false;
    if (!/^\/aweme\/v[12]\/web\//.test(u.pathname)) return false;
    // The recommend tab uses /aweme/v1/web/tab/feed/; the selected page uses
    // /aweme/v2/web/module/feed/. Match the generic .../feed path and recommendation endpoints.
    return /\/feed\/?$/.test(u.pathname) || /recommend/i.test(u.pathname);
  } catch (e) {
    return false;
  }
}

function feedPathHints(captureDir) {
  const paths = captureLines(captureDir)
    .filter((l) => l.kind === 'request')
    .map((l) => {
      try {
        const u = new URL(String(l.url));
        return u.pathname;
      } catch (e) {
        return null;
      }
    })
    .filter((p) => p && /\/aweme\/v[12]\/web\//.test(p) && /(feed|recommend)/i.test(p));
  return [...new Set(paths)].slice(-12);
}

function findFeedRequest(captureDir) {
  const feeds = captureLines(captureDir).filter((l) => l.kind === 'request' && isFeedRequestUrl(l.url));
  if (!feeds.length) return null;
  // Prefer the 推荐 tab's GET endpoint; it is simpler to replay than the v2 module feed.
  const preferred = feeds.filter((l) => /\/aweme\/v1\/web\/tab\/feed\/?/.test(l.url));
  return preferred.length ? preferred[preferred.length - 1] : feeds[feeds.length - 1];
}

function findFeedUrl(captureDir) {
  const request = findFeedRequest(captureDir);
  return request ? request.url : null;
}

// Keep only the headers that help the replay and are safe to persist (never the cookie header;
// cookies are stored separately with restrictive file permissions).
function pickFeedHeaders(headers = {}) {
  const keep = new Set(['accept', 'accept-language', 'referer', 'user-agent', 'origin', 'uifid', 'content-type']);
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const key = String(name).toLowerCase();
    if (keep.has(key) || key.startsWith('bd-ticket-guard') || key.startsWith('x-secsdk')) {
      out[key] = String(value);
    }
  }
  return out;
}

function pickKeyword(acc, keyword) {
  if (keyword) return { keyword, pool: '' };
  const pool = repos.listPools().find((p) => p.enabled);
  if (!pool) throw new Error('没有启用的视频池');
  return { keyword: pool.keyword, pool: pool.name };
}

function chooseExportFriend({ requested = '', accountFriend = '', enabled = [], all = [] } = {}) {
  const wanted = String(requested || '').trim();
  if (wanted) return wanted;
  const names = new Set((all || []).map((f) => (typeof f === 'string' ? f : f && f.name)).filter(Boolean));
  const enabledNames = (enabled || []).filter(Boolean);
  if (accountFriend && names.has(accountFriend) && enabledNames.includes(accountFriend)) return accountFriend;
  if (enabledNames.length) return enabledNames[0];
  if (accountFriend && names.has(accountFriend)) return accountFriend;
  const first = (all || []).map((f) => (typeof f === 'string' ? f : f && f.name)).find(Boolean);
  return first || '';
}

/**
 * @param {{accountLabel?:string, keyword?:string, friend?:string, logger?:Function}} opts
 */
async function exportSession({ accountLabel = process.env.ACCOUNT || null, keyword, friend, logger } = {}) {
  const acc = repos.getAccount(accountLabel || repos.getSetting('activeAccount', null));
  if (!acc) throw new Error('没有账号，请先 init 或导入数据');
  const enabledFriends = repos.listEnabledFriendNames(acc.id);
  const allFriends = repos.listFriends(acc.id);
  const targetFriend = chooseExportFriend({
    requested: friend,
    accountFriend: acc.friend,
    enabled: enabledFriends,
    all: allFriends,
  });
  if (!targetFriend) throw new Error('账号还没有配置好友，先在面板里填写好友昵称');

  const base = `http://127.0.0.1:${acc.port}`;
  if (await stateOf(base)) {
    log(logger, '浏览器正在运行，先关闭它再导出会话…');
    const closed = await sessionRefresh.closeBrowser(acc.port);
    if (!closed || (await stateOf(base))) {
      throw new Error('浏览器仍在运行，无法导出会话；请关闭抖音画面后重试');
    }
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

    const drive = await driveShare({ port: acc.port, friend: targetFriend, keyword: chosen.keyword, logger });

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
    const feedRequest = findFeedRequest(captureDir);
    const feedUrl = feedRequest ? feedRequest.url : null;
    const feedHeaders = feedRequest ? pickFeedHeaders(feedRequest.headers) : {};
    const feedPaths = feedPathHints(captureDir);
    if (!feedUrl) {
      log(logger, '提示：没有捕获到首页推荐 feed 请求；推荐视频源将不可用（重新导出或确认首页能加载推荐流）');
      if (feedPaths.length) log(logger, `捕获到的相关请求路径：${feedPaths.join(', ')}`);
      else log(logger, '捕获到的相关请求路径：无（首页可能停留在登录/验证页，或推荐流由其他方式加载）');
      repos.logEvent('feed-capture-missing', { account: acc.label, paths: feedPaths });
    } else {
      repos.logEvent('feed-captured', { account: acc.label, path: (() => { try { return new URL(feedUrl).pathname; } catch (e) { return ''; } })() });
    }

    const friends = (drive.friends || [])
      .filter((row) => row && row.name && row.userid)
      .map((row) => ({ name: row.name, userid: String(row.userid) }));
    const session = {
      version: 4,
      createdAt: new Date().toISOString(),
      account: acc.label,
      accountName: '',
      friend: targetFriend,
      keyword: chosen.keyword,
      pool: chosen.pool,
      searchUrl,
      feedUrl,
      feedHeaders,
      feedMethod: feedRequest ? (feedRequest.method || 'GET') : 'GET',
      feedBodyB64: feedRequest && feedRequest.bodyB64 ? feedRequest.bodyB64 : null,
      feedPaths,
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

    // derive the account nickname from the captured self user id (the second user in the
    // conversation/create template also appears in the recent-friends list under its nickname)
    let accountName = '';
    try {
      if (session.createTemplate && session.createTemplate.bodyB64) {
        const { createTemplateUsers } = require('./api-proto');
        const users = createTemplateUsers(session.createTemplate.bodyB64);
        const self = friends.find((f) => f.userid === users[1]);
        if (self) accountName = self.name;
      }
    } catch (e) {}
    session.accountName = accountName || acc.display_name || acc.label;
    const file = apiSession.save(session, acc.label);
    if (!acc.display_name && accountName) {
      repos.updateAccountDisplayName(acc.id, accountName);
      log(logger, `账户显示名已更新为「${accountName}」`);
    }
    log(logger, `会话已保存：${file}`);
    log(logger, `账号 ${acc.label} → 好友 ${targetFriend}，模板 ${bundle.lastSend.bodyB64.length} base64 字符，cookies ${bundle.cookies.length} 条`);
    return {
      ok: true,
      file,
      account: acc.label,
      accountName: accountName || acc.display_name || acc.label,
      friend: targetFriend,
      keyword: chosen.keyword,
      friends: friends.length,
      hasCreateTemplate: !!session.createTemplate,
      hasFeedUrl: !!feedUrl,
      feedPaths,
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

module.exports = { exportSession, chooseExportFriend, driveShare, findSearchUrl, findFeedRequest, findFeedUrl, feedPathHints, isFeedRequestUrl, pickFeedHeaders, captureLines };
