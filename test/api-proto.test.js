/**
 * @file Unit tests for the byte-preserving protobuf helpers used by the pure-HTTP sender.
 */
const test = require('node:test');
const assert = require('node:assert');
const apiProto = require('../src/api-proto');

function varint(value) {
  let n = typeof value === 'bigint' ? value : BigInt(value);
  const out = [];
  while (n >= 0x80n) {
    out.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  out.push(Number(n));
  return Buffer.from(out);
}
const key = (field, wire = 2) => varint(BigInt(field * 8 + wire));
const lenField = (field, buf) => Buffer.concat([key(field), varint(Buffer.from(buf).length), Buffer.from(buf)]);
const varintField = (field, value) => Buffer.concat([key(field, 0), varint(value)]);

function buildTemplate() {
  const convId = '0:1:102092647640:2892143345565097';
  const contentJson = JSON.stringify({ aweType: 800, itemId: '111' });
  const ext = Buffer.concat([lenField(1, 's:client_message_id'), lenField(2, 'old-client-id')]);
  const message = Buffer.concat([
    lenField(1, convId),
    varintField(2, 1),
    varintField(3, 7370934033628414501n), // exceeds 2^53: must be copied byte-for-byte
    lenField(4, contentJson),
    lenField(5, ext),
    lenField(8, 'old-client-id'),
  ]);
  const body = lenField(100, message);
  const top = Buffer.concat([varintField(1, 100), varintField(2, 42), lenField(3, '0.1.8'), lenField(8, body)]);
  return { templateB64: top.toString('base64'), message };
}

function messageFields(templateB64) {
  const top = apiProto.parseRaw(Buffer.from(templateB64, 'base64'));
  const bodyField = top.find((f) => f.f === 8 && f.w === 2);
  const body = apiProto.parseRaw(bodyField.v);
  const messageField = body.find((f) => f.f === 100 && f.w === 2);
  return { top, body, message: apiProto.parseRaw(messageField.v) };
}

test('buildSendBody keeps the int64 conversation_short_id bytes', () => {
  const { templateB64, message } = buildTemplate();
  const original = apiProto.parseRaw(message).find((f) => f.f === 3 && f.w === 0);
  const rebuilt = apiProto.buildSendBody(templateB64, {
    content: JSON.stringify({ aweType: 800, itemId: '222' }),
    clientMessageId: 'new-client-id',
    stime: '123.456',
  });
  const after = messageFields(rebuilt.toString('base64')).message.find((f) => f.f === 3 && f.w === 0);
  assert.ok(after, 'short id field must survive');
  assert.strictEqual(after.rawVarint.toString('hex'), original.rawVarint.toString('hex'));
});

test('buildSendBody replaces content, client message id and stime only', () => {
  const { templateB64 } = buildTemplate();
  const rebuilt = apiProto.buildSendBody(templateB64, {
    content: JSON.stringify({ aweType: 800, itemId: '222' }),
    clientMessageId: 'new-client-id',
    stime: '123.456',
  });
  const { message } = messageFields(rebuilt.toString('base64'));
  const content = message.find((f) => f.f === 4).v.toString('utf8');
  assert.match(content, /"itemId":"222"/);
  assert.strictEqual(message.find((f) => f.f === 8).v.toString('utf8'), 'new-client-id');
  const ext = apiProto.parseRaw(message.find((f) => f.f === 5).v);
  assert.strictEqual(ext.find((f) => f.f === 2).v.toString('utf8'), 'new-client-id');
});

test('parseSendResponse reads the short "OK" success envelope', () => {
  const status = JSON.stringify({ status_code: 0, status_msg: { msg_type: 2, msg_content: { tips: '' } } });
  const inner = Buffer.concat([
    varintField(1, 7711666349354109000n),
    varintField(3, 0),
    lenField(4, 'client-1'),
    varintField(5, 0),
    lenField(6, status),
  ]);
  const top = Buffer.concat([varintField(1, 100), lenField(4, 'OK'), lenField(6, lenField(100, inner))]);
  const parsed = apiProto.parseSendResponse(top);
  assert.strictEqual(parsed.statusCode, 0);
  assert.strictEqual(parsed.clientMessageId, 'client-1');
  assert.strictEqual(parsed.serverMessageId, '7711666349354109000');
});

test('parseSendResponse reads a rejection (no server message id)', () => {
  const status = JSON.stringify({ status_code: 7905, status_msg: { msg_content: { tips: '你已不在群聊内' } } });
  const inner = Buffer.concat([
    varintField(3, 3),
    lenField(4, 'client-2'),
    varintField(5, 2),
    lenField(6, status),
  ]);
  const top = Buffer.concat([varintField(1, 100), lenField(4, 'OK'), lenField(6, lenField(100, inner))]);
  const parsed = apiProto.parseSendResponse(top);
  assert.strictEqual(parsed.statusCode, 7905);
  assert.strictEqual(parsed.serverMessageId, null);
  assert.match(parsed.statusMessage, /群聊/);
});
