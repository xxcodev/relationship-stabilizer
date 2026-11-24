#!/usr/bin/env node
/**
 * @file POC: capture Douyin web XHR/fetch traffic from a logged-in Chrome profile.
 *
 * Read-only investigation for "can we call the web APIs without driving a browser?".
 * It browses one search result page, opens the first video, opens the share panel, and captures
 * the request that would be triggered by clicking the friend — that last click is INTERCEPTED and
 * aborted, so nothing is ever sent.
 *
 * Usage:
 *   node scripts/poc-api-probe.js --profile <chrome-profile-dir> --out /tmp/api-poc [--friend Hime]
 *
 * The output directory holds cookies/signatures: keep it local, do not commit it.
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const { EXTRACT, OPEN_STEP } = require('../src/picker');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

const PROFILE = path.resolve(flag('profile', ''));
const OUT = path.resolve(flag('out', '/tmp/api-poc'));
const FRIEND = flag('friend', '');
const API_RE = /^https:\/\/www\.douyin\.com\/aweme\/v1\/web\//;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!PROFILE || !fs.existsSync(PROFILE)) {
  console.error('usage: node scripts/poc-api-probe.js --profile <profile-dir> --out /tmp/api-poc');
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

const captured = { meta: {}, requests: [], responses: [], abortedSends: [], cookies: [] };

function recordRequest(request) {
  if (!API_RE.test(request.url())) return;
  if (!['xhr', 'fetch'].includes(request.resourceType())) return;
  captured.requests.push({
    ts: Date.now(),
    method: request.method(),
    resourceType: request.resourceType(),
    url: request.url(),
    headers: request.headers(),
    postData: (() => {
      try {
        return request.postData();
      } catch (e) {
        return null;
      }
    })(),
  });
}

async function minimize(context) {
  try {
    const page = context.pages()[0] || (await context.newPage());
    const cdp = await context.newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await cdp.detach();
  } catch (e) {
    console.error('minimize failed:', e.message.split('\n')[0]);
  }
}

async function main() {
  console.log(`profile: ${PROFILE}`);
  const context = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless: false,
    locale: 'zh-CN',
    viewport: { width: 1280, height: 900 },
    args: ['--window-position=-20000,-20000'],
  });
  await minimize(context);

  context.on('request', recordRequest);
  context.on('response', async (response) => {
    const request = response.request();
    if (!API_RE.test(request.url())) return;
    if (!['xhr', 'fetch'].includes(request.resourceType())) return;
    try {
      const body = await response.text();
      captured.responses.push({
        ts: Date.now(),
        method: request.method(),
        url: request.url(),
        status: response.status(),
        headers: response.headers(),
        body: body.slice(0, 12000),
      });
    } catch (e) {}
  });

  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(20000);

  // 1) home page: establish session cookies and capture the first API calls
  await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(6000);

  const loggedIn = await page
    .evaluate(() => !document.body.innerText.includes('登录后免费畅享'))
    .catch(() => false);
  captured.meta.loggedIn = loggedIn;
  console.log(`loggedIn: ${loggedIn}`);

  // 2) one search page (same call the app's picker makes)
  await page.goto('https://www.douyin.com/search/%E6%90%9E%E7%AC%91', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  let cards = [];
  for (let tick = 0; tick < 8; tick++) {
    await sleep(1600);
    cards = (await page.evaluate(EXTRACT).catch(() => [])) || [];
    if (cards.length >= 3) break;
  }
  captured.meta.cards = cards.length;
  console.log(`cards found: ${cards.length}`);

  if (cards.length) {
    const title = (cards[0].txt || '').replace(/\s+/g, ' ').trim();
    const hit = await page.evaluate(OPEN_STEP(title)).catch(() => null);
    if (hit) {
      await page.mouse.click(hit.x, hit.y);
      await sleep(3000);
    }
  }
  const modalUrl = page.url();
  captured.meta.modalUrl = modalUrl;
  console.log(`modal: ${/modal_id=\d+/.test(modalUrl) ? 'open' : 'not-open'}`);

  // 3) open the share panel (no send yet)
  const tut = page.getByText('我知道了', { exact: true });
  if (await tut.count()) {
    await tut.first().click({ timeout: 3000 }).catch(() => {});
    await sleep(900);
  }
  const alreadyOpen = await page.evaluate(() => document.body.innerText.includes('分享给朋友'));
  if (!alreadyOpen) {
    const pt = await page.evaluate(() => {
      const visible = [...document.querySelectorAll('[data-e2e="video-player-share"]')]
        .map((e) => e.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0 && r.top >= 0 && r.top < window.innerHeight);
      if (!visible.length) return null;
      const r = visible[0];
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    if (pt) {
      await page.mouse.move(pt.x - 4, pt.y, { steps: 8 });
      await sleep(300);
      await page.mouse.click(pt.x, pt.y);
    }
    await sleep(1600);
  }

  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-userid]')].map((b) => {
      const row = b.parentElement;
      const sp = row ? row.querySelector('span') : null;
      const r = b.getBoundingClientRect();
      return {
        name: sp ? (sp.textContent || '').trim() : '',
        userid: b.getAttribute('data-userid'),
        x: Math.round(r.x + r.width / 2),
        y: Math.round(r.y + r.height / 2),
      };
    })
  );
  captured.meta.sharePanelOpen = await page.evaluate(() => document.body.innerText.includes('分享给朋友'));
  captured.meta.friends = rows;
  console.log(`share panel: ${captured.meta.sharePanelOpen ? 'open' : 'closed'}, friends: ${rows.map((r) => r.name).join(', ') || '(none)'}`);

  // 4) click the friend, but abort the outgoing POST so nothing is actually shared.
  //    A second consecutive share of the same video within the same session is not something
  //    this probe should do silently; we only need the request shape.
  const target = rows.find((r) => r.name === FRIEND) || (rows.length === 1 ? rows[0] : null);
  if (target) {
    await page.route('**/*', async (route) => {
      const request = route.request();
      const isApiPost = API_RE.test(request.url()) && request.method() === 'POST';
      if (isApiPost) {
        captured.abortedSends.push({
          ts: Date.now(),
          method: request.method(),
          url: request.url(),
          headers: request.headers(),
          postData: (() => {
            try {
              return request.postData();
            } catch (e) {
              return null;
            }
          })(),
        });
        await route.abort().catch(() => {});
        return;
      }
      await route.continue().catch(() => {});
    });
    console.log(`clicking friend "${target.name}" (send POST will be aborted)`);
    await page.mouse.click(target.x, target.y);
    await sleep(4000);
    await page.unroute('**/*').catch(() => {});
  } else {
    console.log('no unambiguous friend row; skipping the (aborted) send click');
  }

  captured.cookies = await context.cookies();
  captured.meta.finishedAt = new Date().toISOString();
  captured.meta.url = page.url();

  const file = path.join(OUT, 'captured.json');
  fs.writeFileSync(file, JSON.stringify(captured, null, 2));
  console.log(`saved ${file}`);
  console.log(`api requests: ${captured.requests.length}, responses: ${captured.responses.length}, aborted sends: ${captured.abortedSends.length}`);

  // 5) redacted summary so the console output is safe to paste
  const uniq = new Map();
  for (const request of captured.requests) {
    const key = `${request.method} ${request.url.split('?')[0]}`;
    if (!uniq.has(key)) uniq.set(key, 0);
    uniq.set(key, uniq.get(key) + 1);
  }
  console.log('--- endpoints ---');
  for (const [key, count] of [...uniq.entries()].slice(0, 20)) console.log(`${count}x ${key}`);
  const sig = captured.requests.map((r) => {
    const params = new URL(r.url).searchParams;
    return ['a_bogus', 'X-Bogus', 'msToken', 'verifyFp', 'fp'].filter((p) => params.has(p));
  });
  const sigCount = new Map();
  for (const list of sig) for (const p of list) sigCount.set(p, (sigCount.get(p) || 0) + 1);
  console.log('--- signature params ---', JSON.stringify(Object.fromEntries(sigCount)));

  await context.close().catch(() => {});
}

main().catch((e) => {
  console.error('probe failed:', e.message.split('\n')[0]);
  process.exit(1);
});
