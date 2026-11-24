/**
 * @file Picks candidate videos through the browser-server HTTP API and opens the chosen card.
 */
// Picks videos through the browser-server HTTP API. No CLI parsing here.
const { urlFor, chooseKeyword } = require('./pools');
const videoPicker = require('./video-picker');

const EXTRACT = `(() => {
  const out = [];
  const seen = new Set();
  for (const e of document.querySelectorAll('div,span')) {
    const t = (e.textContent || '').trim();
    if (!/^\\d{1,2}:\\d{2}$/.test(t)) continue;
    const r = e.getBoundingClientRect();
    if (r.width < 10 || r.width > 90 || r.height < 8 || r.height > 40) continue;
    let p = e, best = null;
    for (let i = 0; i < 10; i++) {
      if (!p.parentElement) break;
      p = p.parentElement;
      const pr = p.getBoundingClientRect();
      if (pr.width > 440 || pr.height > 460) break;
      if ((p.innerText || '').includes('@') && pr.width > 180) best = { txt: p.innerText };
    }
    if (!best) continue;
    const key = t + '|' + best.txt.slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ dur: t, txt: best.txt.replace(/\\s+/g, ' ').trim() });
  }
  return out;
})()`;

const OPEN_STEP = (title) => `(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, '');
  const t = norm(${JSON.stringify(title)}).slice(0, 12);
  const cands = [...document.querySelectorAll('div')].filter((e) => {
    const r = e.getBoundingClientRect();
    if (r.width < 180 || r.width > 460 || r.height < 120) return false;
    return norm(e.innerText).includes(t);
  });
  if (!cands.length) return null;
  cands.sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width);
  const el = cands[0];
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + Math.min(r.height * 0.3, 120)) };
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parse(card, pool, source) {
  const m = card.txt.match(/^(\d{1,2}:\d{2})\s+([\d.]+万?)?\s*([\s\S]*)$/);
  const likesRaw = (m && m[2]) || '';
  const likes = likesRaw.endsWith('万') ? parseFloat(likesRaw) * 10000 : parseFloat(likesRaw) || 0;
  const body = (m ? m[3] : card.txt).trim();
  const at = body.lastIndexOf('@');
  return {
    pool,
    dur: card.dur,
    likes,
    title: (at > 0 ? body.slice(0, at) : body).trim().slice(0, 120),
    author: at > 0 ? body.slice(at).split('·')[0].trim() : '',
    source: source || urlFor(pool),
  };
}

async function post(base, p, body) {
  const r = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return r.json();
}

/** Pick n candidates. `pools` = [{name, keyword, enabled}], banWords = string[]. */
async function pick({ base, pools, banWords = [], excludeTitles = [], count = 1, scanLimit = 4, poolDelayMs = 2500, random = Math.random }) {
  const enabled = pools.filter((p) => p.enabled && (p.keyword || p.name));
  for (let i = enabled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [enabled[i], enabled[j]] = [enabled[j], enabled[i]];
  }
  const chosen = enabled.slice(0, Math.min(scanLimit, enabled.length));
  const ban = banWords.length ? new RegExp('(' + banWords.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')') : /$^/;

  const byPool = {};
  for (const pool of chosen) {
    const name = pool.name;
    const keyword = chooseKeyword(pool, random);
    const source = urlFor(keyword);
    try {
      await post(base, '/goto', { url: source });
      // results are client-rendered and can take 15-40s; poll instead of a fixed sleep
      let cards = [];
      for (let tick = 0; tick < 9; tick++) {
        await sleep(1600);
        const res = await post(base, '/eval', { js: EXTRACT });
        cards = (res.out || []).map((c) => parse(c, name, source)).filter((c) => c.title && !ban.test(c.title + ' ' + c.author));
        if (cards.length >= 3) break;
      }
      if (cards.length) byPool[name] = cards;
    } catch (e) {
      /* skip pool */
    }
    // pace the navigation: back-to-back page loads are what triggered the anti-bot challenge
    await sleep(poolDelayMs + Math.floor(random() * 2000));
  }

  const poolsLeft = Object.keys(byPool);
  const out = [];
  for (let i = 0; i < count && poolsLeft.length; i++) {
    const p = poolsLeft[Math.floor(random() * poolsLeft.length)];
    // Every scraped card is a candidate; recent titles are skipped while possible.
    const c = videoPicker.chooseVideo(byPool[p], { titles: excludeTitles }, random);
    if (!c) { poolsLeft.splice(poolsLeft.indexOf(p), 1); i--; continue; }
    out.push(c);
    byPool[p] = byPool[p].filter((x) => x !== c);
    if (!byPool[p].length) poolsLeft.splice(poolsLeft.indexOf(p), 1);
  }
  return { picked: out, scanned: chosen.map((p) => p.name), found: Object.fromEntries(Object.entries(byPool).map(([k, v]) => [k, v.length])) };
}

/** Open a picked card and return the modal URL (contains modal_id). */
async function open(base, pick, { attempts = 3 } = {}) {
  for (let i = 0; i < attempts; i++) {
    await post(base, '/goto', { url: pick.source });
    for (let tick = 0; tick < 26; tick++) {
      await sleep(1500);
      const body = await post(base, '/eval', { js: "document.body.innerText.replace(/\\s+/g,' ').slice(0,120)" });
      if (/Bad Gateway|kngx|访问过多|系统繁忙/.test((body && body.out) || '')) break;
      const hit = await post(base, '/eval', { js: OPEN_STEP(pick.title) });
      if (hit.out) {
        await sleep(500);
        await post(base, '/click', { x: hit.out.x, y: hit.out.y });
        await sleep(3000);
        const st = await (await fetch(base + '/state')).json();
        if (/modal_id=\d+/.test(st.url)) return { ok: true, url: st.url };
      } else if (tick === 5) {
        await post(base, '/eval', { js: 'window.scrollBy(0, 600); true' });
      }
    }
  }
  return { ok: false, error: 'card not found' };
}

module.exports = { pick, open, sleep, EXTRACT, OPEN_STEP, parse };
