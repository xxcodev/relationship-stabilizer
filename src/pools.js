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
// Alternative search terms per pool. The base keyword is always included, so a pool keeps
// its original meaning while each send can explore a different slice of the same topic.
const VARIANTS = {
  日番: ['日漫推荐', '日漫混剪', '日漫解说'],
  韩剧: ['韩剧推荐', '韩剧解说', '韩剧混剪'],
  沙雕: ['沙雕视频', '沙雕合集', '沙雕日常'],
  发癫: ['发癫视频', '发癫日常', '抽象发癫'],
  鬼畜: ['鬼畜调教', '鬼畜合集', '鬼畜名场面'],
  整活: ['整活视频', '搞笑整活', '整活合集'],
  搞笑: ['搞笑视频', '搞笑合集', '搞笑段子'],
  萌宠: ['萌宠日常', '猫咪日常', '狗狗日常'],
  美食: ['美食推荐', '美食教程', '探店'],
  影视混剪: ['影视混剪', '电影混剪', '影视解说'],
  名场面: ['影视名场面', '动漫名场面', '名场面合集'],
  冷知识: ['冷知识科普', '涨知识', '科普'],
  游戏: ['游戏实况', '游戏解说', '游戏高光'],
  音乐现场: ['演唱会', '音乐节', 'live现场'],
  舞蹈: ['舞蹈翻跳', '舞蹈教学', '街舞'],
  旅行: ['旅行vlog', '风景', '自驾游'],
  数码: ['数码测评', '手机测评', '数码好物'],
  剧情反转: ['反转', '短剧', '剧情'],
  童年回忆: ['童年动画', '怀旧', '回忆杀'],
};

function keywordsFor(name, keyword) {
  const base = String(keyword || '').trim();
  if (!base || base.startsWith('@')) return base ? [base] : [];
  return [...new Set([base, ...(VARIANTS[name] || [])].map((w) => String(w || '').trim()).filter(Boolean))];
}

function chooseKeyword(pool, random = Math.random) {
  const list = Array.isArray(pool && pool.variants) && pool.variants.length
    ? pool.variants
    : keywordsFor(pool && pool.name, pool && pool.keyword);
  if (!list.length) return String((pool && pool.name) || '');
  const r = Number(random());
  const index = Number.isFinite(r) ? Math.min(list.length - 1, Math.max(0, Math.floor(r * list.length))) : 0;
  return list[index];
}


function urlFor(keyword) {
  if (keyword === '@acg') return CATEGORY_ACG;
  return BASE + '/search/' + encodeURIComponent(keyword);
}

module.exports = { POOLS, VARIANTS, urlFor, keywordsFor, chooseKeyword, CATEGORY_ACG };
