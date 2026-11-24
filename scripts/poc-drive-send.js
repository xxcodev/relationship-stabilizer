#!/usr/bin/env node
/**
 * @file POC helper: drive one "share video to friend" flow through a running browser-server.
 *
 * With POC_ABORT_SEND=1 on the browser-server, the outgoing send POST is captured and aborted,
 * so this produces a request template without delivering a message.
 *
 * Usage: node scripts/poc-drive-send.js --port 9337 --friend Hime [--keyword 搞笑]
 */
const fs = require('fs');
const { EXTRACT, OPEN_STEP } = require('../src/picker');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const PORT = Number(flag('port', '9337'));
const FRIEND = flag('friend', 'Hime');
const KEYWORD = flag('keyword', '搞笑');
const BUNDLE = flag('bundle', '');
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(p, body) {
  const res = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

async function main() {
  console.log(`goto search "${KEYWORD}"`);
  await post('/goto', { url: `https://www.douyin.com/search/${encodeURIComponent(KEYWORD)}` });
  let cards = [];
  for (let i = 0; i < 9; i++) {
    await sleep(1600);
    cards = (await post('/eval', { js: EXTRACT })).out || [];
    if (cards.length >= 3) break;
  }
  if (!cards.length) throw new Error('no cards found');
  console.log(`cards: ${cards.length}`);
  const title = (cards[0].txt || '').replace(/\s+/g, ' ').trim();

  let opened = false;
  for (let tick = 0; tick < 20; tick++) {
    await sleep(1500);
    const hit = (await post('/eval', { js: OPEN_STEP(title) })).out;
    if (hit) {
      await sleep(400);
      await post('/click', { x: hit.x, y: hit.y });
      await sleep(3000);
      const state = await (await fetch(BASE + '/state')).json();
      if (/modal_id=\d+/.test(state.url)) {
        opened = true;
        break;
      }
    } else if (tick === 5) {
      await post('/eval', { js: 'window.scrollBy(0, 600); true' });
    }
  }
  if (!opened) throw new Error('video modal did not open');
  console.log('video opened');

  for (let i = 0; i < 5; i++) {
    const share = await post('/openshare');
    if (share.ok) break;
    await sleep(2000);
  }
  console.log(`sending to "${FRIEND}" (the send POST is aborted by the capture server)`);
  const result = await post('/send', { name: FRIEND, confirm: true });
  console.log(JSON.stringify(result).slice(0, 200));
  await sleep(1500);
  if (BUNDLE) {
    try {
      const res = await fetch(BASE + '/poc/bundle');
      const bundle = await res.json();
      fs.writeFileSync(BUNDLE, JSON.stringify(bundle, null, 2));
      console.log(`bundle saved: ${BUNDLE} (cookies ${bundle.cookies.length}, lastSend ${bundle.lastSend ? 'yes' : 'no'})`);
    } catch (e) {
      console.error('bundle save failed:', e.message);
    }
  }
  await fetch(BASE + '/quit', { method: 'POST' }).catch(() => {});
}

main().catch((e) => {
  console.error('drive failed:', e.message.split('\n')[0]);
  process.exit(1);
});
