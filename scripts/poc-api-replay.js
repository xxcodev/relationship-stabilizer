#!/usr/bin/env node
/**
 * @file POC: replay captured Douyin web API requests from plain Node (no browser).
 *
 * Reads /tmp/api-poc/captured.json from `scripts/poc-api-probe.js` and replays a few requests:
 *   1. exact replay (captured cookie + a_bogus/msToken signature)
 *   2. replay with the signature params removed      (control: should fail)
 *   3. replay without cookies                        (control: should fail)
 *
 * It never sends messages: only read APIs and side-effect-free telemetry POSTs are replayed.
 *
 * Usage: node scripts/poc-api-replay.js --in /tmp/api-poc
 */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const IN = path.resolve(flag('in', '/tmp/api-poc'));
const file = path.join(IN, 'captured.json');
if (!fs.existsSync(file)) {
  console.error(`missing ${file}; run scripts/poc-api-probe.js first`);
  process.exit(1);
}

const captured = JSON.parse(fs.readFileSync(file, 'utf8'));
const responses = captured.responses || [];
const requests = captured.requests || [];
const cookies = captured.cookies || [];

function responseFor(request) {
  for (let i = responses.length - 1; i >= 0; i--) {
    const r = responses[i];
    if (r.method === request.method && r.url === request.url) return r;
  }
  return null;
}

function cookieHeader() {
  return cookies
    .filter((c) => /(^|\.)douyin\.com$/.test(c.domain))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

function keepHeaders(request) {
  const h = request.headers || {};
  const out = {};
  for (const name of ['user-agent', 'accept', 'accept-language', 'content-type', 'origin', 'referer', 'cookie', 'sec-ch-ua', 'sec-ch-ua-platform']) {
    if (h[name]) out[name] = h[name];
  }
  if (!out.cookie) out.cookie = cookieHeader();
  if (!out['user-agent']) {
    out['user-agent'] =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36';
  }
  return out;
}

function stripSignature(rawUrl) {
  const url = new URL(rawUrl);
  for (const p of ['a_bogus', 'X-Bogus', 'msToken']) url.searchParams.delete(p);
  return url.toString();
}

async function replay(request, { mutateUrl, dropCookie, dropSignature } = {}) {
  const url = new URL(mutateUrl || request.url);
  const headers = keepHeaders(request);
  if (dropCookie) delete headers.cookie;
  if (dropSignature) {
    for (const p of ['a_bogus', 'X-Bogus', 'msToken']) url.searchParams.delete(p);
  }
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.postData || undefined,
      signal: AbortSignal.timeout(20000),
      redirect: 'follow',
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (e) {}
    return {
      status: res.status,
      ms: Date.now() - started,
      bytes: Buffer.byteLength(text),
      json: !!json,
      topKeys: json && typeof json === 'object' ? Object.keys(json).slice(0, 10) : [],
      statusCode: json && typeof json === 'object' ? json.status_code : undefined,
      preview: text.slice(0, 120).replace(/\s+/g, ' '),
    };
  } catch (e) {
    return { error: e.message.split('\n')[0], ms: Date.now() - started };
  }
}

function pickCandidates() {
  const wanted = [
    '/aweme/v1/web/user/profile/self/',
    '/aweme/v1/web/hot/search/list/',
    '/aweme/v1/web/general/search/single/',
    '/aweme/v1/web/multicast/query/',
    '/aweme/v1/web/social/count',
    '/aweme/v1/web/page/turn/offline',
    '/aweme/v1/web/im/get/online_feedback/entrance/',
  ];
  const out = [];
  const seen = new Set();
  for (const request of requests) {
    const endpoint = new URL(request.url).pathname;
    if (!wanted.includes(endpoint)) continue;
    if (seen.has(endpoint)) continue;
    const response = responseFor(request);
    if (!response || response.status !== 200) continue;
    seen.add(endpoint);
    out.push({ request, response });
  }
  // fall back to the first few JSON-returning GETs if the wanted list is empty
  if (!out.length) {
    for (const request of requests) {
      if (request.method !== 'GET') continue;
      const response = responseFor(request);
      if (!response || response.status !== 200 || !response.body || response.body.length < 300) continue;
      out.push({ request, response });
      if (out.length >= 5) break;
    }
  }
  return out;
}

async function main() {
  console.log(`captured: ${requests.length} requests, ${responses.length} responses, loggedIn=${captured.meta.loggedIn}`);
  const candidates = pickCandidates();
  if (!candidates.length) {
    console.error('no replay candidates');
    process.exit(1);
  }

  const report = [];
  for (const { request, response } of candidates) {
    const endpoint = new URL(request.url).pathname;
    let originalKeys = [];
    try {
      originalKeys = Object.keys(JSON.parse(response.body)).slice(0, 10);
    } catch (e) {}
    console.log(`\n=== ${request.method} ${endpoint} (original ${response.status}, ${response.body.length}B) ===`);

    const exact = await replay(request);
    const noSig = request.method === 'GET' ? await replay(request, { dropSignature: true }) : null;
    const noCookie = await replay(request, { dropCookie: true });
    console.log(`  exact      : ${JSON.stringify(exact)}`);
    if (noSig) console.log(`  no-signature: ${JSON.stringify(noSig)}`);
    console.log(`  no-cookie  : ${JSON.stringify(noCookie)}`);
    report.push({ endpoint, method: request.method, originalKeys, originalBytes: response.body.length, exact, noSig, noCookie });
  }

  const outFile = path.join(IN, 'replay-report.json');
  fs.writeFileSync(outFile, JSON.stringify({ meta: captured.meta, report }, null, 2));
  console.log(`\nsaved ${outFile}`);
}

main().catch((e) => {
  console.error('replay failed:', e.message);
  process.exit(1);
});
