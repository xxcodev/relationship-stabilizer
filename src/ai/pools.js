/**
 * @file AI expansion of a video category into concrete child categories.
 * Returns names/keywords only; the dashboard validates and persists them.
 */
const client = require('./client');

const SYSTEM =
  '你是抖音内容分类助手。给一个父分类，生成 4–8 个具体、可搜索、互不重复的子分类。' +
  '分类名要短（2–12 个汉字或常见英文），搜索词可以更具体一点。' +
  '不要重复父分类或已有分类，不要写泛泛的“视频”“合集”“推荐”。' +
  '只返回 JSON：{"categories":[{"name":"洛丽塔","keyword":"洛丽塔穿搭"}]}。';

function clean(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[|<>{}[\]`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function validName(name, existing, parentName) {
  const n = clean(name, 20);
  if (n.length < 2) return null;
  if (n === parentName) return null;
  if (existing.some((x) => x.toLowerCase() === n.toLowerCase())) return null;
  return n;
}

/**
 * @param {{parent:{name:string,keyword:string}, existing:string[], cfg?:object, fetchImpl?:Function}} opts
 */
async function expand({ parent, existing = [], hint = '', cfg = null, fetchImpl = null } = {}) {
  const conf = cfg || client.load();
  if (!client.configured(conf)) throw new Error('AI 未启用或缺少 API Key');
  const parentName = clean(parent && parent.name, 20);
  if (!parentName) throw new Error('缺少父分类');
  const out = await client.chatJson({
    cfg: conf,
    fetchImpl: fetchImpl || global.fetch,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `父分类：${parentName}\n父分类搜索词：${clean(parent.keyword, 60)}\n已有分类：${JSON.stringify(existing.slice(0, 80))}${hint ? `\n用户希望优先覆盖的方向：${clean(hint, 80)}` : ''}` },
    ],
  });
  const data = out.data || {};
  const list = Array.isArray(data.categories) ? data.categories : (Array.isArray(data.items) ? data.items : []);
  const categories = [];
  const names = new Set();
  for (const item of list) {
    const name = validName(item && item.name, [...existing, ...names], parentName);
    if (!name || names.has(name.toLowerCase())) continue;
    const keyword = clean(item && (item.keyword || item.search || name), 40) || name;
    categories.push({ name, keyword });
    names.add(name.toLowerCase());
    if (categories.length >= 8) break;
  }
  if (!categories.length) throw new Error('AI 没有生成可用分类');
  return { categories, model: conf.model };
}

module.exports = { expand, SYSTEM };
