// Browser-layer tests against a local fixture page — never touches douyin.com.
const http = require('http');
const test = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright-core');
const { EXTRACT, OPEN_STEP, parse } = require('../src/picker');

const FIXTURE = `<!doctype html><html><body style="margin:0;font:14px sans-serif">
  <div style="display:flex;gap:20px;padding:20px">
    <div style="width:300px;height:220px;background:#eee">
      <div style="height:140px;background:#ccc;position:relative">
        <span style="position:absolute;right:6px;bottom:6px">01:23</span>
      </div>
      <div>标题一 #测试 #标签</div>
      <div><span>@作者甲</span> · 3天前</div>
      <div>♥ 1.2万</div>
    </div>
    <div style="width:300px;height:220px;background:#eee">
      <div style="height:140px;background:#ccc;position:relative">
        <span style="position:absolute;right:6px;bottom:6px">02:34</span>
      </div>
      <div>标题二 另一条内容</div>
      <div><span>@作者乙</span> · 昨天</div>
      <div>♥ 3456</div>
    </div>
  </div>
</body></html>`;

let server, browser, page, base;

test.before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(FIXTURE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.goto(base);
});

test.after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
});

test('EXTRACT finds card-shaped blocks with a duration badge', async () => {
  const cards = await page.evaluate(EXTRACT);
  assert.equal(cards.length, 2, 'both fixture cards should be detected');
  assert.ok(cards[0].dur.match(/^\d{2}:\d{2}$/));
});

test('parse turns raw card text into title / author / likes', () => {
  const card = parse({ dur: '01:23', txt: '01:23 1.2万 标题一 #测试 #标签 @作者甲 · 3天前' }, '测试池');
  assert.equal(card.pool, '测试池');
  assert.equal(card.likes, 12000);
  assert.ok(card.title.startsWith('标题一'), `unexpected title: ${card.title}`);
  assert.equal(card.author, '@作者甲');
  assert.equal(card.ageDays, 3);
});

test('parse handles cards without a like count', () => {
  const card = parse({ dur: '00:10', txt: '00:10 没有点赞的卡片 @某人' }, '池');
  assert.equal(card.likes, 0);
  assert.equal(card.title, '没有点赞的卡片');
});

test('OPEN_STEP locates a card by its title prefix', async () => {
  const hit = await page.evaluate(OPEN_STEP('标题二 另一条内容'));
  assert.ok(hit && typeof hit.x === 'number' && typeof hit.y === 'number', 'should return coordinates');
  assert.ok(hit.x > 0 && hit.y > 0);
});

test('OPEN_STEP gives up on a title that is not on the page', async () => {
  const miss = await page.evaluate(OPEN_STEP('根本不存在的标题'));
  assert.equal(miss, null);
});
