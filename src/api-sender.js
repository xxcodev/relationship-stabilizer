/**
 * @file Pure-HTTP send path: pick a video from the read API and send it as an IM video card.
 *
 * No browser process is involved. Inputs come from api-session.js (cookies + one captured
 * protobuf send template). Callers must keep a browser fallback: template/cookies expire, the
 * template is bound to one friend, and platform risk control may reject plain HTTP requests.
 */
const crypto = require('crypto');
const apiProto = require('./api-proto');
const apiSession = require('./api-session');

const UA =
  process.env.API_UA ||
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36';

function cookieHeader(session) {
  return (session.cookies || [])
    .filter((c) => /(^|\.)douyin\.com$/.test(c.domain))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

function buildSearchUrl(session, keyword) {
  const url = new URL(session.searchUrl);
  // read endpoints worked without the recorded signature; drop stale signed params
  for (const name of ['a_bogus', 'X-Bogus', 'msToken']) url.searchParams.delete(name);
  let replaced = false;
  for (const name of ['keyword', 'query', 'search_keyword', 'q']) {
    if (url.searchParams.has(name)) {
      url.searchParams.set(name, keyword);
      replaced = true;
    }
  }
  if (!replaced) url.searchParams.set('keyword', keyword);
  return url.toString();
}

async function readJson(url, session, timeout = 20000) {
  const res = await fetch(url, {
    headers: {
      cookie: cookieHeader(session),
      'user-agent': UA,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      referer: 'https://www.douyin.com/',
    },
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return JSON.parse(text);
}

function cardContent(video) {
  return JSON.stringify({
    aweType: 800,
    content_title: video.title,
    cover_height: video.height,
    cover_width: video.width,
    itemId: video.awemeId,
    cover_url: { url_list: video.coverUrlList, uri: video.coverUri },
    content_thumb: { url_list: video.thumbUrlList, uri: video.thumbUri },
    uid: video.uid,
  });
}

/** Pick one candidate via the search API. Throws when the session/API is unusable. */
async function pick(session, { keyword, banWords = [] } = {}) {
  if (!keyword) throw new Error('missing pool keyword');
  const json = await readJson(buildSearchUrl(session, keyword), session);
  const ban = banWords.length
    ? new RegExp('(' + banWords.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')')
    : /$^/;
  const candidates = [];
  for (const item of json.data || []) {
    const aweme = item && item.aweme_info;
    if (!aweme || !aweme.aweme_id) continue;
    const video = aweme.video || {};
    const cover = video.cover || video.origin_cover || video.dynamic_cover;
    const thumb = (aweme.author && aweme.author.avatar_thumb) || null;
    if (!cover || !Array.isArray(cover.url_list) || !cover.url_list.length) continue;
    const title = String(aweme.desc || '').trim();
    if (!title) continue;
    if (ban.test(title)) continue;
    candidates.push({
      awemeId: String(aweme.aweme_id),
      title: title.slice(0, 120),
      author: (aweme.author && aweme.author.nickname) || '',
      likes: Number((aweme.statistics && aweme.statistics.digg_count) || 0),
      width: cover.width || 1080,
      height: cover.height || 1920,
      coverUrlList: cover.url_list,
      coverUri: cover.uri || '',
      thumbUrlList: thumb ? thumb.url_list : cover.url_list,
      thumbUri: thumb ? thumb.uri || '' : cover.uri || '',
      uid: (aweme.author && aweme.author.uid) || '',
    });
  }
  if (!candidates.length) throw new Error('no candidate from search API');
  candidates.sort((a, b) => b.likes - a.likes);
  const pool = candidates.slice(0, 8);
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Send the video card over HTTP. Returns {ok, statusCode, statusMessage, ...}. */
async function sendVideo(session, video) {
  const clientMessageId = crypto.randomUUID();
  const stime = `${Date.now()}.${Math.floor(Math.random() * 9000 + 1000)}`;
  const body = apiProto.buildSendBody(session.template.bodyB64, {
    content: cardContent(video),
    clientMessageId,
    stime,
  });

  const res = await fetch(session.template.url, {
    method: 'POST',
    headers: {
      accept: 'application/x-protobuf',
      'accept-language': 'zh-CN,zh;q=0.9',
      'cache-control': 'no-cache',
      'content-type': 'application/x-protobuf',
      origin: 'https://www.douyin.com',
      pragma: 'no-cache',
      referer: 'https://www.douyin.com/',
      'user-agent': UA,
      cookie: cookieHeader(session),
    },
    body,
    signal: AbortSignal.timeout(20000),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  if (res.status !== 200) {
    return { ok: false, httpStatus: res.status, error: `HTTP ${res.status}`, video };
  }
  let parsed = {};
  try {
    parsed = apiProto.parseSendResponse(buf);
  } catch (e) {
    return { ok: false, error: `bad response: ${e.message}`, responseB64: buf.toString('base64'), video };
  }
  // Success comes in two shapes: with a `status_code:0` detail, or a short "OK" envelope that
  // only carries the assigned server message id (no status detail). A rejection has no server id.
  const accepted =
    res.status === 200 &&
    parsed.envelopeStatus === 'OK' &&
    (parsed.statusCode === 0 || (parsed.statusCode == null && !!parsed.serverMessageId));
  const ok = accepted;
  return {
    ok,
    httpStatus: res.status,
    statusCode: parsed.statusCode,
    statusMessage: parsed.statusMessage || (accepted ? 'OK' : ''),
    serverMessageId: parsed.serverMessageId,
    clientMessageId,
    error: ok ? null : parsed.statusMessage || `status_code ${parsed.statusCode}`,
    responseB64: ok ? undefined : buf.toString('base64'),
    video,
  };
}

/** Convenience: validity of the stored session for this account friend. */
function usable(session, friend, opts) {
  return apiSession.status(session, friend, opts);
}

module.exports = { pick, sendVideo, buildSearchUrl, cardContent, cookieHeader, usable };
