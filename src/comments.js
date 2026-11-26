/**
 * @file Read-only public comment fetch for natural sharing.
 * Uses the legacy public web endpoint; it needs cookies but no a_bogus signature.
 */
const apiSender = require('./api-sender');

const COMMENT_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function cleanText(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .replace(/https?:\/\/\S+/gi, '')
    .trim();
}

function useful(text) {
  if (!text || text.length < 2 || text.length > 160) return false;
  if (/^\d{1,2}:\d{2}$/.test(text)) return false; // timestamp-only comments
  if (/^@\S+$/.test(text)) return false;
  if (/^(.)\1{5,}$/.test(text)) return false;
  return true;
}

/** Top-level public comments, filtered, de-duplicated, best first. */
async function fetchComments(session, awemeId, { limit = 8, timeout = 12000 } = {}) {
  const id = String(awemeId || '').trim();
  if (!id) return { comments: [], error: 'missing aweme id' };
  const url = new URL('https://www.iesdouyin.com/web/api/v2/comment/list/');
  url.searchParams.set('aweme_id', id);
  url.searchParams.set('count', String(Math.min(20, Math.max(1, limit * 2))));
  url.searchParams.set('cursor', '0');
  const res = await fetch(url, {
    headers: {
      'user-agent': COMMENT_UA,
      accept: 'application/json, text/plain, */*',
      referer: 'https://www.douyin.com/',
      cookie: apiSender.cookieHeader(session),
    },
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`评论接口 HTTP ${res.status}`);
  if (!text.trim()) throw new Error('评论接口返回空响应');
  let json;
  try { json = JSON.parse(text); } catch (e) { throw new Error('评论接口返回不是 JSON'); }
  const code = json.status_code && typeof json.status_code === 'object'
    ? json.status_code.StatusCode
    : json.status_code;
  if (code != null && Number(code) !== 0) {
    throw new Error((json.status_code && json.status_code.StatusMsg) || `评论接口 status_code ${code}`);
  }
  const seen = new Set();
  const comments = [];
  for (const row of Array.isArray(json.comments) ? json.comments : []) {
    const value = cleanText(row && row.text);
    if (!useful(value) || seen.has(value)) continue;
    seen.add(value);
    comments.push({
      text: value.slice(0, 120),
      likes: Math.max(0, Number(row.digg_count) || 0),
      nickname: cleanText(row.user && row.user.nickname).slice(0, 30),
    });
  }
  comments.sort((a, b) => b.likes - a.likes);
  return { comments: comments.slice(0, limit), rawCount: Array.isArray(json.comments) ? json.comments.length : 0 };
}

module.exports = { fetchComments, cleanText, useful };
