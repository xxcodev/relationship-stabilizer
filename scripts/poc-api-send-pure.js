#!/usr/bin/env node
/**
 * @file POC: send a Douyin video card to a friend with plain Node + HTTP (no browser).
 *
 * Mirrors the Java web SDK's approach: take a captured /v1/message/send protobuf body as the
 * envelope template, keep its ticket/headers/ids, replace only the conversation content,
 * client message id and stime, then POST with the captured session cookies.
 *
 * The protobuf editing is byte-preserving: int64 fields (conversation_short_id) exceed JS number
 * precision and must not be decoded into Number and re-encoded.
 *
 * ⚠ This really sends a message. Only run against an account/friend you own.
 *
 * Usage:
 *   node scripts/poc-api-send-pure.js --in /tmp/api-poc-all2 [--aweme-id <id>]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const DIR = path.resolve(flag('in', '/tmp/api-poc-all2'));
const FORCE_AWEME = flag('aweme-id', '');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36';

// ---------- protobuf wire codec (byte-preserving) ----------
function encodeVarint(value) {
  const out = [];
  let n = Number(value);
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n & 0x7f);
  return Buffer.from(out);
}
const tag = (field) => encodeVarint(field * 8 + 2);
function readVarintIndex(buf, i) {
  let result = 0;
  let shift = 0;
  for (;;) {
    const byte = buf[i++];
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (!(byte & 0x80)) return [result, i];
  }
}
function parseRaw(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const keyStart = i;
    let key;
    [key, i] = readVarintIndex(buf, i);
    const field = key >>> 3;
    const wire = key & 7;
    if (wire === 0) {
      const valueStart = i;
      let value;
      [value, i] = readVarintIndex(buf, i);
      out.push({ f: field, w: 0, keyRaw: buf.subarray(keyStart, valueStart), rawVarint: buf.subarray(valueStart, i) });
    } else if (wire === 2) {
      let len;
      [len, i] = readVarintIndex(buf, i);
      const valueStart = i;
      out.push({ f: field, w: 2, v: buf.subarray(valueStart, valueStart + len) });
      i += len;
    } else {
      throw new Error(`unexpected wire type ${wire}`);
    }
  }
  return out;
}
function encodeRaw(fields) {
  const parts = [];
  for (const item of fields) {
    if (item.replace !== undefined) parts.push(tag(item.f), encodeVarint(item.replace.length), item.replace);
    else if (item.w === 0) parts.push(item.keyRaw, item.rawVarint);
    else parts.push(tag(item.f), encodeVarint(item.v.length), item.v);
  }
  return Buffer.concat(parts);
}
const findRaw = (fields, f) => fields.find((x) => x.f === f && x.w === 2);

// ---------- captured template + session ----------
function loadBundle() {
  const sendFile = path.join(DIR, 'send.json');
  const cookieFile = path.join(DIR, 'cookies.json');
  if (fs.existsSync(sendFile) && fs.existsSync(cookieFile)) {
    return {
      lastSend: JSON.parse(fs.readFileSync(sendFile, 'utf8')).lastSend,
      cookies: JSON.parse(fs.readFileSync(cookieFile, 'utf8')).cookies || [],
    };
  }
  const bundleFile = path.join(DIR, 'bundle.json');
  if (fs.existsSync(bundleFile)) {
    const bundle = JSON.parse(fs.readFileSync(bundleFile, 'utf8'));
    return { lastSend: bundle.lastSend, cookies: bundle.cookies || [] };
  }
  return { lastSend: null, cookies: [] };
}
const capturedBundle = loadBundle();
const send = capturedBundle.lastSend;
const cookies = capturedBundle.cookies;
if (!send || !send.bodyB64) {
  console.error('missing captured send request; run the capture flow first (see docs/api-poc.md)');
  process.exit(1);
}
const cookieHeader = cookies
  .filter((c) => /(^|\.)douyin\.com$/.test(c.domain))
  .map((c) => `${c.name}=${c.value}`)
  .join('; ');

function capturedLines() {
  const file = path.join(DIR, 'all.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);
}

// ---------- pick a fresh video through the (already verified) read API ----------
async function pickAweme() {
  const lines = capturedLines();
  const searches = lines.filter((l) => l.kind === 'request' && /general\/search\/single/.test(l.url));
  const target = searches[searches.length - 1];
  if (!target) throw new Error('no captured search request to reuse for picking');
  const res = await fetch(target.url, {
    headers: {
      cookie: cookieHeader,
      'user-agent': UA,
      accept: 'application/json, text/plain, */*',
      referer: 'https://www.douyin.com/',
    },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`search replay failed: HTTP ${res.status}, ${text.slice(0, 120)}`);
  }
  for (const item of json.data || []) {
    const a = item.aweme_info;
    if (!a || !a.aweme_id) continue;
    const video = a.video || {};
    const cover = video.cover || video.origin_cover || video.dynamic_cover;
    const thumb = a.author && a.author.avatar_thumb;
    if (!cover || !cover.url_list) continue;
    return {
      awemeId: a.aweme_id,
      desc: a.desc || '',
      width: cover.width || 1080,
      height: cover.height || 1920,
      coverUrlList: cover.url_list,
      coverUri: cover.uri || '',
      thumbUrlList: thumb ? thumb.url_list : cover.url_list,
      thumbUri: thumb ? thumb.uri || '' : cover.uri || '',
      uid: (a.author && a.author.uid) || '',
    };
  }
  throw new Error('no usable aweme_info in search results');
}

function buildContentJson(video) {
  if (!video) {
    const top = parseRaw(Buffer.from(send.bodyB64, 'base64'));
    const content = parseRaw(findRaw(parseRaw(findRaw(top, 8).v), 100).v);
    const json = JSON.parse(findRaw(content, 4).v.toString('utf8'));
    json.itemId = FORCE_AWEME;
    return JSON.stringify(json);
  }
  return JSON.stringify({
    aweType: 800,
    content_title: video.desc,
    cover_height: video.height,
    cover_width: video.width,
    itemId: video.awemeId,
    cover_url: { url_list: video.coverUrlList, uri: video.coverUri },
    content_thumb: { url_list: video.thumbUrlList, uri: video.thumbUri },
    uid: video.uid,
  });
}

function buildBody({ contentJson, clientMessageId, stime }) {
  const top = parseRaw(Buffer.from(send.bodyB64, 'base64'));
  const body = parseRaw(findRaw(top, 8).v);
  const content = parseRaw(findRaw(body, 100).v);
  for (const item of content) {
    if (item.f === 4 && item.w === 2) item.replace = Buffer.from(contentJson);
    if (item.f === 8 && item.w === 2) item.replace = Buffer.from(clientMessageId);
    if (item.f === 5 && item.w === 2) {
      const kv = parseRaw(item.v);
      const keyField = findRaw(kv, 1);
      const key = keyField ? keyField.v.toString('utf8') : '';
      if (key === 's:client_message_id') findRaw(kv, 2).replace = Buffer.from(clientMessageId);
      if (key === 's:stime') findRaw(kv, 2).replace = Buffer.from(stime);
      item.replace = encodeRaw(kv);
    }
  }
  findRaw(body, 100).replace = encodeRaw(content);
  findRaw(top, 8).replace = encodeRaw(body);
  return encodeRaw(top);
}

async function main() {
  console.log(`template: ${send.url.split('?')[0]} (${Buffer.from(send.bodyB64, 'base64').length}B)`);
  const video = FORCE_AWEME ? null : await pickAweme();
  const contentJson = buildContentJson(video);
  const clientMessageId = crypto.randomUUID();
  const stime = `${Date.now()}.${Math.floor(Math.random() * 9000 + 1000)}`;
  const body = buildBody({ contentJson, clientMessageId, stime });
  console.log(`video: ${video ? `${video.awemeId} ${video.desc.slice(0, 40)}` : `forced ${FORCE_AWEME}`}`);
  console.log(`messageId: ${clientMessageId}  body: ${body.length}B`);

  const res = await fetch(send.url, {
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
      cookie: cookieHeader,
    },
    body,
    signal: AbortSignal.timeout(20000),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const latin = buf.toString('latin1');
  const fragment = latin.match(/\{[^{}]{0,600}"status_code"[^{}]{0,600}\}/);
  console.log(`HTTP ${res.status}, ${buf.length}B, content-type=${res.headers.get('content-type')}`);
  console.log('status:', fragment ? fragment[0].slice(0, 260) : '(no json fragment)');
  const ok = res.status === 200 && /"status_code":\s*0/.test(latin);
  console.log(ok ? 'RESULT: ✅ 纯 Node/HTTP 发送被服务端接受' : 'RESULT: ❌ 发送失败');

  fs.writeFileSync(
    path.join(DIR, 'pure-send-result.json'),
    JSON.stringify({ video, contentJson, clientMessageId, status: res.status, bodyB64: buf.toString('base64') }, null, 2)
  );
}

main().catch((e) => {
  console.error('pure send failed:', e.message.split('\n')[0]);
  process.exit(1);
});
