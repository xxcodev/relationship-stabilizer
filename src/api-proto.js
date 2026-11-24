/**
 * @file Protobuf helpers for the pure-HTTP send path (imapi /v1/message/send).
 *
 * The envelope is taken from one real captured request and reused as a template. Editing is
 * byte-preserving for untouched fields: conversation_short_id is an int64 that exceeds JS number
 * precision, and decoding it into a Number (then re-encoding) corrupts the last digits.
 */
const POC_ERR = 'template';

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
  const fields = [];
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
      fields.push({ f: field, w: 0, keyRaw: buf.subarray(keyStart, valueStart), rawVarint: buf.subarray(valueStart, i) });
    } else if (wire === 2) {
      let len;
      [len, i] = readVarintIndex(buf, i);
      const valueStart = i;
      fields.push({ f: field, w: 2, v: buf.subarray(valueStart, valueStart + len) });
      i += len;
    } else {
      throw new Error(`${POC_ERR}: unsupported wire type ${wire}`);
    }
  }
  return fields;
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
function varintBig(parts) {
  let result = 0n;
  let shift = 0n;
  for (const byte of parts) {
    result += BigInt(byte & 0x7f) << shift;
    shift += 7n;
  }
  return result.toString();
}

function contentJson(template) {
  const top = parseRaw(Buffer.from(template, 'base64'));
  const body = findRaw(top, 8);
  if (!body) throw new Error(`${POC_ERR}: missing send_message_body`);
  const content = findRaw(parseRaw(body.v), 100);
  if (!content) throw new Error(`${POC_ERR}: missing send_message_content`);
  const field = findRaw(parseRaw(content.v), 4);
  if (!field) throw new Error(`${POC_ERR}: missing content json`);
  return field.v.toString('utf8');
}

function buildSendBody(templateB64, { content, clientMessageId, stime }) {
  const top = parseRaw(Buffer.from(templateB64, 'base64'));
  const bodyField = findRaw(top, 8);
  if (!bodyField) throw new Error(`${POC_ERR}: missing send_message_body`);
  const body = parseRaw(bodyField.v);
  const contentField = findRaw(body, 100);
  if (!contentField) throw new Error(`${POC_ERR}: missing send_message_content`);
  const message = parseRaw(contentField.v);
  for (const item of message) {
    if (item.f === 4 && item.w === 2) item.replace = Buffer.from(content);
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
  contentField.replace = encodeRaw(message);
  bodyField.replace = encodeRaw(body);
  return encodeRaw(top);
}

/** Parse the protobuf response: envelope status + nested message status JSON. */
function parseSendResponse(buf) {
  const out = { envelopeStatus: '', statusCode: null, statusMessage: '', serverMessageId: null, clientMessageId: null };
  const top = parseRaw(buf);
  const envelope = findRaw(top, 4);
  if (envelope) out.envelopeStatus = envelope.v.toString('utf8');
  const messageData = findRaw(top, 6);
  if (!messageData) return out;
  const inner = findRaw(parseRaw(messageData.v), 100);
  if (!inner) return out;
  const message = parseRaw(inner.v);
  const idField = message.find((x) => x.f === 1 && x.w === 0);
  if (idField) out.serverMessageId = varintBig(idField.rawVarint);
  const clientField = findRaw(message, 4);
  if (clientField) out.clientMessageId = clientField.v.toString('utf8');
  const statusJson = findRaw(message, 6);
  if (statusJson) {
    try {
      const parsed = JSON.parse(statusJson.v.toString('utf8'));
      out.statusCode = parsed.status_code;
      const msg = parsed.status_msg;
      out.statusMessage =
        (msg && msg.msg_content && msg.msg_content.tips) || parsed.tips || (typeof msg === 'string' ? msg : '') || '';
    } catch (e) {}
  }
  return out;
}

module.exports = { parseRaw, encodeRaw, buildSendBody, contentJson, parseSendResponse };
