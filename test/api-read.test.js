const http = require('http');
const test = require('node:test');
const assert = require('node:assert');
const apiRead = require('../src/api-read');
const apiProto = require('../src/api-proto');

function big(parts) {
  let n = 0n;
  let shift = 0n;
  for (const byte of parts) {
    n += BigInt(byte & 0x7f) << shift;
    shift += 7n;
  }
  return n.toString();
}

test('markConversationRead posts the 1:1 template with cookies and patches the target', async () => {
  let captured = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      captured = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
      res.writeHead(200, { 'content-type': 'application/x-protobuf' });
      res.end(Buffer.from('22024f4b', 'hex')); // field 4 = "OK"
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/mark`;
  try {
    const session = { cookies: [{ name: 'sessionid', value: 's1' }, { name: 'ttwid', value: 't1' }] };
    const out = await apiRead.markConversationRead(session, {
      conversationId: '0:1:1001:2002',
      conversationShortId: '1234567890123456789',
      url,
    });
    assert.equal(out.ok, true);
    assert.equal(out.status, 200);
    assert.equal(captured.method, 'POST');
    assert.match(String(captured.headers.cookie), /sessionid=s1/);
    assert.match(String(captured.headers.cookie), /ttwid=t1/);
    assert.equal(captured.headers['content-type'], 'application/x-protobuf');

    const top = apiProto.parseRaw(captured.body);
    const body = top.find((f) => f.f === 8 && f.w === 2);
    const info = apiProto.parseRaw(body.v).find((f) => f.f === 604 && f.w === 2);
    const fields = apiProto.parseRaw(info.v);
    const getStr = (n) => fields.find((f) => f.f === n && f.w === 2).v.toString('utf8');
    const getVar = (n) => big(fields.find((f) => f.f === n && f.w === 0).rawVarint);
    assert.equal(getStr(1), '0:1:1001:2002');
    assert.equal(getVar(2), '1234567890123456789');
    assert.equal(getVar(3), '1');
    assert.equal(getVar(7), String(apiRead.READ_INDEX));
    assert.equal(getVar(8), '1');
    const cmd = top.find((f) => f.f === 2 && f.w === 0);
    assert.equal(big(cmd.rawVarint), '10008');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('markConversationRead refuses missing sessions or conversation IDs', async () => {
  assert.equal((await apiRead.markConversationRead(null, {})).ok, false);
  assert.equal((await apiRead.markConversationRead({ cookies: [] }, {})).ok, false);
  const out = await apiRead.markConversationRead(
    { cookies: [{ name: 'a', value: 'b' }] },
    { conversationId: '0:1:1:2' },
  );
  assert.equal(out.ok, false);
  assert.match(out.error, /会话 ID/);
});
