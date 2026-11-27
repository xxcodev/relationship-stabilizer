/**
 * @file Playwright control service: owns the Chrome window, exposes /state /goto /click /screen /window /openshare /send /quit.
 */
// Multi-account Douyin control server.
// Usage: node serve.js <profileDir> <port>
const http = require('http');
const path = require('path');
const { chromium } = require('playwright-core');

const env = require('./env');
const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const PROFILE = argOf('--profile', 'profile-b');
const PORT = Number(argOf('--port', '9334'));
const POS = argOf('--pos', env.browser.windowPosition);
const fs = require('fs');
const TAG = path.basename(PROFILE);
const SHOT_DIR = path.resolve(env.ROOT, process.env.SHOTS_DIR || path.join('data', 'shots'));
fs.mkdirSync(SHOT_DIR, { recursive: true });

let ctx, page;

// Optional capture for the pure-API experiment (docs/api-poc.md). Off unless POC_CAPTURE_DIR is set.
const POC_CAPTURE_DIR = process.env.POC_CAPTURE_DIR || null;
const POC_ABORT_SEND = process.env.POC_ABORT_SEND === '1';
const POC_FILE = POC_CAPTURE_DIR ? path.join(POC_CAPTURE_DIR, 'all.jsonl') : null;
let pocLastSend = null;
let pocLastCreate = null;
function pocCap(kind, data) {
  if (!POC_FILE) return;
  try {
    fs.appendFileSync(POC_FILE, JSON.stringify({ kind, ts: Date.now(), ...data }) + '\n');
  } catch (e) {}
}
function pocWire(ctx, page) {
  fs.mkdirSync(POC_CAPTURE_DIR, { recursive: true });
  ctx.on('request', (req) => {
    if (!['xhr', 'fetch'].includes(req.resourceType())) return;
    let bodyB64 = null;
    try {
      if (typeof req.postDataBuffer === 'function') {
        const buffer = req.postDataBuffer();
        if (buffer) bodyB64 = Buffer.from(buffer).toString('base64');
      }
    } catch (e) {}
    const item = {
      method: req.method(),
      url: req.url(),
      resourceType: req.resourceType(),
      headers: req.headers(),
      postData: (() => { try { return (req.postData() || '').slice(0, 2000); } catch (e) { return null; } })(),
      bodyB64,
    };
    pocCap('request', item);
    if (/imapi\.douyin\.com\/v1\/message\/send/.test(req.url())) pocLastSend = item;
    if (/imapi\.douyin\.com\/v2\/conversation\/create/.test(req.url())) pocLastCreate = item;
  });
  ctx.on('response', async (res) => {
    const req = res.request();
    if (!['xhr', 'fetch'].includes(req.resourceType())) return;
    try {
      const body = await res.text();
      pocCap('response', { method: req.method(), url: req.url(), status: res.status(), body: body.slice(0, 24000) });
    } catch (e) {}
  });
  page.on('websocket', (ws) => {
    pocCap('ws-open', { url: ws.url() });
  });
}

async function cur() {
  const pages = ctx.pages().filter((p) => !p.isClosed());
  page = pages.find((p) => /douyin/.test(p.url())) || pages[0];
  if (!page) page = await ctx.newPage();
  return page;
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });
}

// Injected helpers: locate share panel / friend rows by structure, not by hash classes.
const HELPERS = `
window.__dy = window.__dy || {
  panel() {
    const cands = [...document.querySelectorAll('div')];
    return cands.find((e) => {
      const t = e.textContent || '';
      const r = e.getBoundingClientRect();
      return t.includes('分享给朋友') && t.includes('复制链接') && r.width > 200 && r.width < 420;
    }) || null;
  },
  rows() {
    const p = this.panel();
    if (!p) return [];
    return [...p.querySelectorAll('[data-userid]')].map((btn) => {
      const row = btn.parentElement;
      const sp = row ? row.querySelector('span') : null;
      const b = btn.getBoundingClientRect();
      return {
        name: sp ? (sp.textContent || '').trim() : '',
        userid: btn.getAttribute('data-userid'),
        x: Math.round(b.x + b.width / 2),
        y: Math.round(b.y + b.height / 2),
      };
    });
  },
  find(name) {
    const r = this.rows();
    const exact = r.filter((x) => x.name === name);
    if (exact.length === 1) return { match: 'exact', item: exact[0], count: r.length };
    if (exact.length > 1) return { match: 'ambiguous', items: exact, count: r.length };
    const partial = r.filter((x) => x.name.includes(name));
    if (partial.length === 1) return { match: 'partial', item: partial[0], count: r.length };
    return { match: partial.length ? 'ambiguous' : 'none', items: partial, count: r.length, names: r.map((x) => x.name) };
  },
};
true;
`;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    if (u.pathname === '/state') {
      const p = await cur();
      const text = (await p.innerText('body').catch(() => '')).replace(/\s+/g, ' ');
      return res.end(JSON.stringify({
        profile: PROFILE,
        url: p.url(),
        title: await p.title(),
        loggedIn: !text.includes('登录后免费畅享'),
        challenge: /点击两个形状相同的物体|请完成下列验证|完成验证后继续|滑块/.test(text),
        pages: ctx.pages().length,
        text: text.slice(0, 200),
      }));
    }
    if (u.pathname === '/shot') {
      const p = await cur();
      const file = path.join(SHOT_DIR, `shot-${TAG}-${Date.now()}.png`);
      await p.screenshot({ path: file });
      return res.end(JSON.stringify({ file }));
    }
    if (u.pathname === '/goto' && req.method === 'POST') {
      const { url } = JSON.parse(await readBody(req));
      const p = await cur();
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await p.waitForTimeout(2500);
      return res.end(JSON.stringify({ ok: true, url: p.url() }));
    }
    if (u.pathname === '/click' && req.method === 'POST') {
      const { x, y } = JSON.parse(await readBody(req));
      const p = await cur();
      await p.mouse.click(x, y);
      return res.end(JSON.stringify({ ok: true, clicked: [x, y] }));
    }
    if (u.pathname === '/move' && req.method === 'POST') {
      const { x, y } = JSON.parse(await readBody(req));
      const p = await cur();
      await p.mouse.move(x, y, { steps: 12 });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (u.pathname === '/press' && req.method === 'POST') {
      const { key } = JSON.parse(await readBody(req));
      const p = await cur();
      await p.keyboard.press(key);
      return res.end(JSON.stringify({ ok: true, key }));
    }
    if (u.pathname === '/eval' && req.method === 'POST') {
      const { js } = JSON.parse(await readBody(req));
      const p = await cur();
      return res.end(JSON.stringify({ ok: true, out: await p.evaluate(js) }));
    }
    if (u.pathname === '/openshare' && req.method === 'POST') {
      const p = await cur();
      const tut = p.getByText('我知道了', { exact: true });
      if (await tut.count()) {
        await tut.first().click({ timeout: 3000 }).catch(() => {});
        await p.waitForTimeout(900);
      }
      const already = await p.evaluate(() => document.body.innerText.includes('分享给朋友'));
      if (!already) {
        const pt = await p.evaluate(() => {
          const vis = [...document.querySelectorAll('[data-e2e="video-player-share"]')]
            .map((e) => e.getBoundingClientRect())
            .filter((r) => r.width > 0 && r.height > 0 && r.top >= 0 && r.top < window.innerHeight);
          if (vis.length) {
            const r = vis[0];
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
          }
          return null;
        });
        if (pt) {
          await p.mouse.move(pt.x - 4, pt.y, { steps: 8 });
          await p.waitForTimeout(300);
          await p.mouse.click(pt.x, pt.y);
        }
        await p.waitForTimeout(1600);
      }
      const rows = await p.evaluate(() => [...document.querySelectorAll('[data-userid]')].map((b) => {
        const row = b.parentElement;
        const sp = row ? row.querySelector('span') : null;
        const r = b.getBoundingClientRect();
        return {
          name: sp ? (sp.textContent || '').trim() : '',
          userid: b.getAttribute('data-userid'),
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
        };
      }));
      const open = await p.evaluate(() => document.body.innerText.includes('分享给朋友'));
      if (!open) {
        const file = path.join(SHOT_DIR, `sharefail-${TAG}-${Date.now()}.png`);
        await p.screenshot({ path: file });
        return res.end(JSON.stringify({ ok: false, error: 'share panel did not open', shot: file }));
      }
      return res.end(JSON.stringify({ ok: true, panelOpen: true, count: rows.length, rows }));
    }
    if (u.pathname === '/friends') {
      const p = await cur();
      await p.evaluate(HELPERS);
      const rows = await p.evaluate(() => window.__dy.rows());
      return res.end(JSON.stringify({ ok: true, rows }));
    }
    if (u.pathname === '/send' && req.method === 'POST') {
      const { name, userid, confirm } = JSON.parse(await readBody(req));
      const wantedUid = String(userid || '').trim();
      const wantedName = String(name || '').trim();
      const p = await cur();
      let rows = [];
      for (let attempt = 0; attempt < 12; attempt++) {
        rows = await p.evaluate(() => [...document.querySelectorAll('[data-userid]')].map((b) => {
        const row = b.parentElement;
        const sp = row ? row.querySelector('span') : null;
        const r = b.getBoundingClientRect();
        return {
          name: sp ? (sp.textContent || '').trim() : '',
          userid: b.getAttribute('data-userid'),
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
        };
      }));
        if (rows.length) break;
        await p.waitForTimeout(900);
      }
      let target = null;
      let match = '';
      if (wantedUid) {
        // UID is authoritative: never fall back to a nickname match, which could hit a
        // different person after a rename or a recycled nickname.
        const byUid = rows.filter((r) => String(r.userid || '').trim() === wantedUid);
        if (!byUid.length) {
          return res.end(JSON.stringify({
            ok: false, error: 'friend uid not found', userid: wantedUid,
            visible: rows.slice(0, 40).map((r) => ({ name: r.name, userid: r.userid })),
          }));
        }
        if (byUid.length > 1) {
          return res.end(JSON.stringify({ ok: false, error: 'ambiguous uid', candidates: byUid }));
        }
        target = byUid[0];
        match = 'uid';
      } else {
        if (!wantedName) return res.end(JSON.stringify({ ok: false, error: 'friend name required' }));
        const exact = rows.filter((r) => r.name === wantedName);
        const partial = rows.filter((r) => r.name.includes(wantedName));
        const pool = exact.length ? exact : partial;
        if (!pool.length) {
          return res.end(JSON.stringify({ ok: false, error: 'friend not found', visible: rows.map((r) => r.name) }));
        }
        if (pool.length > 1) {
          return res.end(JSON.stringify({ ok: false, error: 'ambiguous name', candidates: pool }));
        }
        target = pool[0];
        match = exact.length ? 'exact' : 'partial';
      }
      if (!confirm) {
        return res.end(JSON.stringify({ ok: true, dryRun: true, target, match }));
      }
      await p.mouse.click(target.x, target.y);
      await p.waitForTimeout(2500);
      const text = (await p.innerText('body').catch(() => '')).replace(/\s+/g, ' ');
      const toast = text.match(/(分享成功|已分享|发送成功|已发送)/);
      const file = path.join(SHOT_DIR, `sent-${TAG}-${Date.now()}.png`);
      await p.screenshot({ path: file });
      return res.end(JSON.stringify({ ok: true, sent: true, target, match, toast: toast ? toast[1] : null, shot: file }));
    }
    if (u.pathname === '/screen') {
      const p = await cur();
      const buf = await p.screenshot({ type: 'png' });
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(buf);
    }
    if (u.pathname === '/window' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const p = await cur();
      const cdp = await ctx.newCDPSession(p);
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      let out;
      if (body.minimized === true || body.show === false) {
        // A window moved to (-20000,-20000) is clamped by macOS/AppKit to the nearest display
        // edge and can leave a ~40px sliver visible on multi-monitor setups. Minimizing keeps
        // it invisible while Playwright still renders frames (backgrounding is disabled).
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
        out = { ok: true, visible: false, state: 'minimized' };
      } else {
        const pos = env.browser.visiblePosition;
        const [left, top] = pos.split(',').map(Number);
        // restore from minimized first; a single call that also sets bounds is ignored on macOS,
        // and the window needs a moment to leave the minimized state before bounds apply
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
        await new Promise((resolve) => setTimeout(resolve, 350));
        await cdp.send('Browser.setWindowBounds', {
          windowId,
          bounds: { left, top, width: env.browser.viewportWidth, height: env.browser.viewportHeight, windowState: 'normal' },
        });
        out = { ok: true, visible: true, position: pos };
      }
      await cdp.detach().catch(() => {});
      return res.end(JSON.stringify(out));
    }
    if (POC_CAPTURE_DIR && u.pathname === '/poc/bundle') {
      return res.end(JSON.stringify({ cookies: await ctx.cookies(), lastSend: pocLastSend, lastCreate: pocLastCreate }));
    }
    if (u.pathname === '/quit') {
      res.end(JSON.stringify({ ok: true, closing: true }));
      setTimeout(async () => {
        try { await ctx.close(); } catch (e) {}
        process.exit(0);
      }, 150);
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message.split('\n')[0] }));
  }
});

(async () => {
  const launch = {
    headless: env.browser.headless,
    viewport: { width: env.browser.viewportWidth, height: env.browser.viewportHeight },
    locale: env.browser.locale,
    args: [`--window-position=${POS}`],
  };
  if (env.browser.executablePath) launch.executablePath = env.browser.executablePath;
  else launch.channel = env.browser.channel;
  ctx = await chromium.launchPersistentContext(PROFILE, launch);
  page = ctx.pages()[0] || (await ctx.newPage());
  if (POC_CAPTURE_DIR) {
    pocWire(ctx, page);
    if (POC_ABORT_SEND) {
      await ctx.route('**/v1/message/send', async (route) => {
        await route.abort().catch(() => {});
      });
    }
  }
  // hidden mode: an off-screen x/y is clamped by macOS/AppKit to the nearest display edge and can
  // leave a sliver visible on multi-monitor setups, so minimize before navigating instead.
  if (!env.browser.headless) {
    try {
      const cdp = await ctx.newCDPSession(page);
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
      await cdp.detach();
    } catch (e) {
      console.error('minimize failed:', e.message.split('\n')[0]);
    }
  }
  await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  console.log(`READY profile=${PROFILE} port=${PORT} url=${page.url()}`);
  server.listen(PORT, '127.0.0.1', () => console.log(`control listening ${PORT}`));
})().catch((e) => {
  console.error('FAILED:', e.message.split('\n')[0]);
  process.exit(1);
});
