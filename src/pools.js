/**
 * @file Seed catalogue of video source pools (name → search keyword) used on first `init`.
 */
// Seed catalogue of video sources. Stored in the DB on `init`; the DB is the source of truth afterwards.
// keyword: douyin search term. '@acg' = the 二次元 category page.
const POOLS = [
  { name: '日番', keyword: '日漫' },
  { name: '韩剧', keyword: '韩剧' },
  { name: '沙雕', keyword: '沙雕' },
  { name: '发癫', keyword: '发癫' },
  { name: '鬼畜', keyword: '鬼畜' },
  { name: '整活', keyword: '整活' },
  { name: '搞笑', keyword: '搞笑' },
  { name: '二次元', keyword: '@acg' },
  { name: '萌宠', keyword: '萌宠' },
  { name: '美食', keyword: '美食' },
  { name: '影视混剪', keyword: '影视混剪' },
  { name: '名场面', keyword: '名场面' },
  { name: '冷知识', keyword: '冷知识' },
  { name: '游戏', keyword: '游戏' },
  { name: '音乐现场', keyword: '音乐现场' },
  { name: '舞蹈', keyword: '舞蹈' },
  { name: '旅行', keyword: '旅行' },
  { name: '数码', keyword: '数码' },
  { name: '剧情反转', keyword: '剧情反转' },
  { name: '童年回忆', keyword: '童年回忆' },
];

const BASE = 'https://www.douyin.com';
const CATEGORY_ACG = BASE + '/jingxuan/acg';

function urlFor(keyword) {
  if (keyword === '@acg') return CATEGORY_ACG;
  return BASE + '/search/' + encodeURIComponent(keyword);
}

module.exports = { POOLS, urlFor, CATEGORY_ACG };
