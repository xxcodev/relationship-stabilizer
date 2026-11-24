/**
 * @file Pool keyword variants: every pool keeps its base keyword and gets relevant alternatives.
 */
const test = require('node:test');
const assert = require('node:assert');
const { keywordsFor, chooseKeyword, urlFor } = require('../src/pools');

test('keeps the base keyword and adds relevant variants', () => {
  assert.deepEqual(keywordsFor('韩剧', '韩剧'), ['韩剧', '韩剧推荐', '韩剧解说', '韩剧混剪']);
  assert.ok(keywordsFor('萌宠', '萌宠').includes('萌宠日常'));
});

test('category pools are not turned into keyword searches', () => {
  assert.deepEqual(keywordsFor('二次元', '@acg'), ['@acg']);
  assert.equal(urlFor('@acg'), 'https://www.douyin.com/jingxuan/acg');
});

test('chooseKeyword is deterministic with an injected random source', () => {
  const pool = { name: '美食', keyword: '美食' };
  assert.equal(chooseKeyword(pool, () => 0), '美食');
  assert.equal(chooseKeyword(pool, () => 0.999), '探店');
});
