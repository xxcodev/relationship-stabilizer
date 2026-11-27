/**
 * @file Pure-HTTP read receipts for Douyin 1:1 conversations.
 *
 * The signed web client sends `POST /v3/conversation/mark_read` with a protobuf body. The
 * captured 1:1 template is account-agnostic: only the cookie identifies the sender, so the
 * same request can be replayed by every account that exports a session. Tests on two real
 * accounts showed that the endpoint accepts a large read index and clears the unread badge.
 */
const apiProto = require('./api-proto');
const TEMPLATE = require('./mark-read-template.json');

const TEMPLATE_URL = TEMPLATE.url;
// The web client sends its latest local read index. A large value means "mark everything
// currently in this conversation read"; newer messages need another call, which the slow-mail
// loop makes every ~45s.
const READ_INDEX = 999999999;

function cookieHeader(session) {
  const cookies = Array.isArray(session && session.cookies) ? session.cookies : [];
  return cookies
    .filter((c) => c && c.name)
    .map((c) => `${c.name}=${c.value == null ? '' : c.value}`)
    .join('; ');
}

/**
 * Mark one conversation read through the pure HTTP endpoint.
 * @param {object} session exported API session (cookies required)
 * @param {object} opts {conversationId, conversationShortId, conversationType, readIndex, url, timeout}
 * @returns {Promise<{ok:boolean,status:number,error?:string,userId?:string}>}
 */
async function markConversationRead(session, opts = {}) {
  const conversationId = String(opts.conversationId || '').trim();
  const shortId = String(opts.conversationShortId || '').trim();
  if (!session || !Array.isArray(session.cookies) || !session.cookies.length) {
    return { ok: false, status: 0, error: '没有可用的纯 API 会话' };
  }
  if (!conversationId || !shortId) {
    return { ok: false, status: 0, error: '会话 ID 不完整，无法标记已读' };
  }
  const template = session.markReadTemplate && session.markReadTemplate.bodyB64
    ? session.markReadTemplate
    : TEMPLATE;
  let body;
  try {
    body = apiProto.buildMarkReadBody(template.bodyB64, {
      conversationId,
      conversationShortId: shortId,
      conversationType: Number(opts.conversationType) === 2 ? 2 : 1,
      readIndex: opts.readIndex == null ? READ_INDEX : opts.readIndex,
      unreadCount: 1,
    });
  } catch (e) {
    return { ok: false, status: 0, error: `已读模板不可用：${e.message}` };
  }
  const headers = {
    ...(template.headers || TEMPLATE.headers),
    origin: 'https://www.douyin.com',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    cookie: cookieHeader(session),
  };
  delete headers['content-length'];
  delete headers.host;
  try {
    const res = await fetch(opts.url || template.url || TEMPLATE_URL, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(Number(opts.timeout) || 12000),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    let parsed = {};
    try {
      parsed = apiProto.parseMarkReadResponse(buf);
    } catch (e) {
      return { ok: false, status: res.status, error: `已读响应解析失败：${e.message}` };
    }
    const ok = res.status === 200 && parsed.ok;
    return {
      ok,
      status: res.status,
      statusText: parsed.status,
      userId: parsed.userId || undefined,
      error: ok ? undefined : `已读被拒绝（HTTP ${res.status}${parsed.status ? ` · ${parsed.status}` : ''}）`,
    };
  } catch (e) {
    return { ok: false, status: 0, error: e.message || '已读请求失败' };
  }
}

module.exports = { markConversationRead, READ_INDEX, TEMPLATE_URL };
