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
const videoPicker = require('./video-picker');

const UA =
  process.env.API_UA ||
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36';

function cookieHeader(session) {
  return (session.cookies || [])
    .filter((c) => /(^|\.)douyin\.com$/.test(c.domain))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

function buildSearchUrl(session, keyword, { maxAgeDays = 0 } = {}) {
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
  // The captured URL can be on page 3+; always start from the top of this keyword.
  if (url.searchParams.has('offset')) url.searchParams.set('offset', '0');
  const window = videoPicker.publishWindow(maxAgeDays);
  if (window) {
    // sort_type=2 (latest) + publish_time limits results; exact age filtering happens below.
    url.searchParams.set('is_filter_search', '1');
    url.searchParams.set('filter_selected', JSON.stringify({ sort_type: '2', publish_time: String(window) }));
  }
  return url.toString();
}

async function readJson(url, session, timeout = 20000, extraHeaders = {}, { method = 'GET', body = null } = {}) {
  const headers = {
    'user-agent': UA,
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    referer: 'https://www.douyin.com/',
    ...(extraHeaders || {}),
    cookie: cookieHeader(session),
  };
  const init = {
    method,
    headers,
    signal: AbortSignal.timeout(timeout),
  };
  if (body) init.body = body;
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!String(text || '').trim()) {
    throw new Error(`HTTP ${res.status} 但返回空响应（可能需要登录，或签名/会话已过期）`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('接口返回不是 JSON（可能需要登录，或签名/会话已过期）');
  }
}

/**
 * Video length from the read API, in milliseconds (Douyin returns `video.duration` in ms).
 * Unknown stays 0 so the burst scheduler can use its configured fallback instead of
 * inventing a length from a differently-scaled field.
 */
function durationMsOf(aweme) {
  const video = (aweme && aweme.video) || {};
  const raw = Number(video.duration || (aweme && aweme.duration) || 0);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0;
}

/** Interaction stats shared by search and feed candidates (0 when the field is absent). */
function statsOf(aweme) {
  const stats = (aweme && aweme.statistics) || {};
  return {
    likes: Number(stats.digg_count || 0),
    comments: Number(stats.comment_count || 0),
    collects: Number(stats.collect_count || 0),
    shares: Number(stats.share_count || 0),
    plays: Number(stats.play_count || 0),
  };
}

function metricFilterError(message) {
  const err = new Error(message);
  err.code = 'metric-filter';
  return err;
}

function noFreshCandidates(message) {
  const err = new Error(message);
  err.code = 'no-fresh-candidate';
  return err;
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

/** Collect candidates via the search API (no random choice yet). */
async function collectSearchCandidates(session, { keyword, banWords = [], maxAgeDays = 7, filters = null } = {}) {
  if (!keyword) throw new Error('missing pool keyword');
  const json = await readJson(buildSearchUrl(session, keyword, { maxAgeDays }), session);
  if (json.status_code != null && json.status_code !== 0) {
    throw new Error(json.status_msg || `search status_code ${json.status_code}`);
  }
  const ban = banWords.length
    ? new RegExp('(' + banWords.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')')
    : /$^/;
  const candidates = new Map();
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
    const awemeId = String(aweme.aweme_id);
    if (candidates.has(awemeId)) continue;
    candidates.set(awemeId, {
      awemeId,
      title: title.slice(0, 120),
      author: (aweme.author && aweme.author.nickname) || '',
      ...statsOf(aweme),
      createTime: Number(aweme.create_time || item.create_time || 0),
      durationMs: durationMsOf(aweme),
      width: cover.width || 1080,
      height: cover.height || 1920,
      coverUrlList: cover.url_list,
      coverUri: cover.uri || '',
      thumbUrlList: thumb ? thumb.url_list : cover.url_list,
      thumbUri: thumb ? thumb.uri || '' : cover.uri || '',
      uid: (aweme.author && aweme.author.uid) || '',
    });
  }
  if (!candidates.size) throw new Error('no candidate from search API');
  const recent = videoPicker.filterRecent([...candidates.values()], maxAgeDays);
  if (!recent.length) throw new Error(`最近 ${maxAgeDays} 天没有候选视频`);
  const matched = videoPicker.filterMetrics(recent, filters);
  if (!matched.length) {
    const desc = videoPicker.describeMetricFilters(filters);
    throw metricFilterError(desc ? `没有达到互动指标（${desc}）的候选` : 'no candidate from search API');
  }
  return { candidates: matched, rawCount: candidates.size, metricFiltered: recent.length - matched.length };
}

/** Pick one candidate via the search API. Throws when the session/API is unusable. */
async function pick(session, { keyword, banWords = [], excludeVideoIds = [], excludeTitles = [], maxAgeDays = 7, filters = null } = {}) {
  const collected = await collectSearchCandidates(session, { keyword, banWords, maxAgeDays, filters });
  const chosen = videoPicker.chooseVideo(collected.candidates, {
    ids: excludeVideoIds,
    titles: excludeTitles,
  });
  if (!chosen) throw noFreshCandidates('池搜索的候选都已发送过，暂无新视频');
  return chosen;
}

function feedUrlFor(session) {
  if (!session || !session.feedUrl) {
    throw new Error('会话没有捕获到首页推荐 feed 请求，请重新导出纯 API 会话');
  }
  // Keep the captured URL byte-for-byte: a_bogus / secsdk signatures are bound to it.
  return String(session.feedUrl);
}

function normalizeFeedCandidate(item) {
  const aweme = item && item.aweme_info ? item.aweme_info : item;
  if (!aweme || !aweme.aweme_id) return null;
  if (aweme.live_info || aweme.cell_room || aweme.is_live) return null;
  const type = Number(aweme.aweme_type);
  // 68 = image post; live and ads are filtered above/by fields.
  if (type === 68) return null;
  if (aweme.is_ads === 1 || aweme.is_ads === true || aweme.ad_info) return null;
  const video = aweme.video || {};
  const cover = video.cover || video.origin_cover || video.dynamic_cover;
  if (!cover || !Array.isArray(cover.url_list) || !cover.url_list.length) return null;
  const title = String(aweme.desc || '').trim();
  if (!title) return null;
  const thumb = (aweme.author && aweme.author.avatar_thumb) || null;
  return {
    awemeId: String(aweme.aweme_id),
    title: title.slice(0, 120),
    author: (aweme.author && aweme.author.nickname) || '',
    ...statsOf(aweme),
    createTime: Number(aweme.create_time || item.create_time || 0),
    durationMs: durationMsOf(aweme),
    width: cover.width || video.width || 1080,
    height: cover.height || video.height || 1920,
    coverUrlList: cover.url_list,
    coverUri: cover.uri || '',
    thumbUrlList: thumb ? thumb.url_list : cover.url_list,
    thumbUri: thumb ? thumb.uri || '' : cover.uri || '',
    uid: (aweme.author && aweme.author.uid) || '',
    source: 'recommend',
    bucket: '默认推荐',
  };
}

/**
 * Read the recommendation feed through the captured feed URL. This is intentionally a
 * separate read path from search: the feed URL carries platform signature parameters and
 * must not be mutated (changing count/refresh_index can invalidate the signature).
 */
async function collectFeedCandidates(session, {
  banWords = [],
  excludeVideoIds = [],
  excludeTitles = [],
  maxAgeDays = 7,
  filters = null,
} = {}) {
  const url = feedUrlFor(session);
  let json;
  try {
    const method = session.feedMethod === 'POST' ? 'POST' : 'GET';
    const body = method === 'POST' && session.feedBodyB64
      ? Buffer.from(session.feedBodyB64, 'base64')
      : null;
    json = await readJson(url, session, 20000, session.feedHeaders || {}, { method, body });
  } catch (e) {
    throw new Error(`推荐 feed 请求失败：${e.message}（签名/会话可能已过期，请重新导出会话）`);
  }
  if (json && json.status_code != null && json.status_code !== 0) {
    throw new Error(json.status_msg || `feed status_code ${json.status_code}`);
  }
  const raw = Array.isArray(json && json.aweme_list)
    ? json.aweme_list
    : Array.isArray(json && json.data && json.data.aweme_list)
      ? json.data.aweme_list
      : Array.isArray(json && json.data)
        ? json.data
        : [];
  const ban = banWords.length
    ? new RegExp('(' + banWords.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')')
    : /$^/;
  const candidates = new Map();
  for (const item of raw) {
    const video = normalizeFeedCandidate(item);
    if (!video) continue;
    if (ban.test(video.title + ' ' + video.author)) continue;
    if (candidates.has(video.awemeId)) continue;
    candidates.set(video.awemeId, video);
  }
  const all = [...candidates.values()];
  const recent = videoPicker.filterRecent(all, maxAgeDays);
  if (!recent.length) {
    throw new Error(all.length ? `最近 ${maxAgeDays} 天没有推荐候选` : '推荐 feed 没有可用视频候选');
  }
  const matched = videoPicker.filterMetrics(recent, filters);
  if (!matched.length) {
    const desc = videoPicker.describeMetricFilters(filters);
    throw metricFilterError(desc ? `没有达到互动指标（${desc}）的推荐候选` : '推荐 feed 没有可用视频候选');
  }
  const fresh = videoPicker.filterHistory(matched, { ids: excludeVideoIds, titles: excludeTitles });
  if (!fresh.length) throw noFreshCandidates('推荐 feed 的候选都已发送过，暂无新视频');
  return { candidates: fresh, all, rawCount: raw.length, metricFiltered: recent.length - matched.length, json };
}

/** Pick one recommendation-feed candidate. Returns a candidate with source/bucket set. */
async function pickFromFeed(session, opts = {}) {
  const { candidates } = await collectFeedCandidates(session, opts);
  const chosen = videoPicker.chooseVideo(candidates, {
    ids: opts.excludeVideoIds,
    titles: opts.excludeTitles,
  });
  if (!chosen) throw noFreshCandidates('推荐 feed 的候选都已发送过，暂无新视频');
  return { ...chosen, source: 'recommend', bucket: '默认推荐' };
}

/** Recent friends captured from the share panel: [{name, userid}]. */
function friends(session) {
  return Array.isArray(session.friends) ? session.friends : [];
}

function resolveFriend(session, name) {
  const wanted = String(name || '').trim();
  return friends(session).find((f) => f.name === wanted) || null;
}

/**
 * Create (or fetch) the conversation with another friend via the captured
 * POST /v2/conversation/create template. Returns {ok, conversationId, conversationShortId}.
 */
async function createConversation(session, toUserId) {
  if (!session.createTemplate || !session.createTemplate.bodyB64) {
    return { ok: false, error: 'session has no conversation-create template' };
  }
  const users = apiProto.createTemplateUsers(session.createTemplate.bodyB64);
  const fromUserId = users[1];
  const body = apiProto.buildCreateBody(session.createTemplate.bodyB64, { toUserId, fromUserId });
  const res = await fetch(session.createTemplate.url, {
    method: 'POST',
    headers: {
      accept: 'application/x-protobuf',
      'content-type': 'application/x-protobuf',
      'cache-control': 'no-cache',
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
  if (res.status !== 200) return { ok: false, error: `create HTTP ${res.status}` };
  const parsed = apiProto.parseCreateResponse(buf);
  if (!parsed.conversationId || !parsed.conversationShortId) {
    return { ok: false, error: parsed.error || 'conversation id missing in response', parsed };
  }
  return { ok: true, conversationId: parsed.conversationId, conversationShortId: parsed.conversationShortId };
}

/** Send arbitrary message content over HTTP. Returns {ok, statusCode, statusMessage, ...}. */
async function sendContent(session, content, { friend, toUserId, video = null, conversationId: givenConversationId, conversationShortId: givenConversationShortId, messageType = null } = {}) {
  const target = String(friend || session.friend || '').trim();
  let conversationId = givenConversationId || null;
  let conversationShortId = givenConversationShortId || null;
  if (!conversationId && target && session.friend && target !== session.friend) {
    const uid = String(toUserId || '').trim();
    const row = uid ? { userid: uid } : resolveFriend(session, target);
    if (!row) {
      return {
        ok: false,
        error: `好友「${target}」不在会话好友列表里，也没有 userid；先导出会话或从互关好友导入`,
        video,
        friend: target,
      };
    }
    if (!session.createTemplate || !session.createTemplate.bodyB64) {
      return { ok: false, error: '会话缺少 conversation/create 模板，无法给新好友建会话', video, friend: target };
    }
    const conv = await createConversation(session, row.userid);
    if (!conv.ok) return { ok: false, error: conv.error, video, friend: target };
    conversationId = conv.conversationId;
    conversationShortId = conv.conversationShortId;
  }
  const clientMessageId = crypto.randomUUID();
  const stime = `${Date.now()}.${Math.floor(Math.random() * 9000 + 1000)}`;
  const body = apiProto.buildSendBody(session.template.bodyB64, {
    content,
    clientMessageId,
    stime,
    conversationId,
    conversationShortId,
    messageType,
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
    conversationId,
    conversationShortId,
    error: ok ? null : parsed.statusMessage || `status_code ${parsed.statusCode}`,
    responseB64: ok ? undefined : buf.toString('base64'),
    video,
    friend: target || undefined,
  };
}

/** Send a video card using the captured send template. */
async function sendVideo(session, video, opts = {}) {
  return sendContent(session, cardContent(video), { ...opts, video });
}

/** Send a plain text message using the same captured IM template. */
async function sendText(session, text, opts = {}) {
  // Legacy 1:1 text bubbles observed from the web client: outer message_type=7 plus
  // this content JSON. Sending text through the captured video template without
  // overriding message_type produces black, unplayable video cards on the receiver.
  const content = JSON.stringify({
    aweType: 700,
    type: 0,
    instruction_type: 0,
    item_type_local: -1,
    text: String(text == null ? '' : text).slice(0, 1000),
    createdAt: 0,
    is_card: false,
    msgHint: '',
    richTextInfos: [],
  });
  return sendContent(session, content, { ...opts, messageType: 7 });
}

/** Convenience: validity of the stored session for this account friend. */
function usable(session, friend, opts) {
  return apiSession.status(session, friend, opts);
}

module.exports = {
  pick,
  pickFromFeed,
  collectSearchCandidates,
  collectFeedCandidates,
  feedUrlFor,
  normalizeFeedCandidate,
  durationMsOf,
  statsOf,
  noFreshCandidates,
  buildSearchUrl,
  sendVideo,
  sendText,
  sendContent,
  createConversation,
  friends,
  resolveFriend,
  cardContent,
  readJson,
  cookieHeader,
  usable,
};
