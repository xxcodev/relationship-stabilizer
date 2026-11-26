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
function encodeVarintBig(value) {
  let n = typeof value === 'bigint' ? value : BigInt(value);
  const out = [];
  while (n >= 0x80n) {
    out.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  out.push(Number(n));
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
    else if (item.w === 0) parts.push(item.keyRaw, item.rawVarintReplace !== undefined ? item.rawVarintReplace : item.rawVarint);
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

function buildSendBody(templateB64, { content, clientMessageId, stime, conversationId, conversationShortId, messageType } = {}) {
  const top = parseRaw(Buffer.from(templateB64, 'base64'));
  const bodyField = findRaw(top, 8);
  if (!bodyField) throw new Error(`${POC_ERR}: missing send_message_body`);
  const body = parseRaw(bodyField.v);
  const contentField = findRaw(body, 100);
  if (!contentField) throw new Error(`${POC_ERR}: missing send_message_content`);
  const message = parseRaw(contentField.v);
  for (const item of message) {
    if (item.f === 1 && item.w === 2 && conversationId) item.replace = Buffer.from(String(conversationId));
    if (item.f === 3 && item.w === 0 && conversationShortId !== undefined && conversationShortId !== null) {
      item.rawVarintReplace = encodeVarintBig(conversationShortId);
    }
    if (item.f === 4 && item.w === 2) item.replace = Buffer.from(content);
    // The captured template is a video message (type 8). Text must change the OUTER
    // protobuf message type too, otherwise the client renders the text JSON as a
    // coverless video. Legacy text bubbles use type 7 + content.aweType=700.
    if (item.f === 6 && item.w === 0 && messageType !== undefined && messageType !== null) {
      item.rawVarintReplace = encodeVarint(messageType);
    }
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
  if (messageType !== undefined && messageType !== null && !message.some((f) => f.f === 6 && f.w === 0)) {
    // Some captured templates omit the optional type field; add it as a varint.
    message.push({ f: 6, w: 0, keyRaw: encodeVarint(6 * 8), rawVarintReplace: encodeVarint(messageType) });
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

/** Users embedded in a captured conversation/create request: [toUserId, fromUserId]. */
function createTemplateUsers(templateB64) {
  const top = parseRaw(Buffer.from(templateB64, 'base64'));
  const body = findRaw(top, 8);
  if (!body) throw new Error(`${POC_ERR}: create template missing body`);
  const create = findRaw(parseRaw(body.v), 609);
  if (!create) throw new Error(`${POC_ERR}: create template missing create_session_request`);
  const users = parseRaw(create.v).filter((x) => x.f === 2 && x.w === 0);
  if (users.length < 2) throw new Error(`${POC_ERR}: create template users missing`);
  return users.map((x) => varintBig(x.rawVarint));
}

/** Rebuild a conversation/create request for another user pair. */
function buildCreateBody(templateB64, { toUserId, fromUserId } = {}) {
  const top = parseRaw(Buffer.from(templateB64, 'base64'));
  const body = findRaw(top, 8);
  if (!body) throw new Error(`${POC_ERR}: create template missing body`);
  const bodyFields = parseRaw(body.v);
  const create = findRaw(bodyFields, 609);
  if (!create) throw new Error(`${POC_ERR}: create template missing create_session_request`);
  const createFields = parseRaw(create.v);
  const users = createFields.filter((x) => x.f === 2 && x.w === 0);
  if (!users.length) throw new Error(`${POC_ERR}: create template users missing`);
  users[0].rawVarintReplace = encodeVarintBig(toUserId);
  if (users[1] && fromUserId !== undefined) users[1].rawVarintReplace = encodeVarintBig(fromUserId);
  create.replace = encodeRaw(createFields);
  body.replace = encodeRaw(bodyFields);
  return encodeRaw(top);
}

/** Walk every length-delimited message looking for {field1: "0:1:x:y", field2: <id>}. */
function parseCreateResponse(buf) {
  const out = { ok: false, conversationId: null, conversationShortId: null, statusCode: null, error: null };
  const top = parseRaw(buf);
  const envelope = findRaw(top, 4);
  if (envelope && envelope.v.toString('utf8') === 'OK') out.ok = true;
  const visit = (fields) => {
    const idField = fields.find((x) => (x.f === 1 || x.f === 2) && x.w === 2 && /^\d+:\d+:\d+:\d+$/.test(x.v.toString('utf8')));
    if (idField) {
      out.conversationId = idField.v.toString('utf8');
      const shortField = fields.find((x) => x.w === 0 && x.f === idField.f + 1);
      if (shortField) out.conversationShortId = varintBig(shortField.rawVarint);
    }
    for (const item of fields) {
      if (item.w === 2) {
        try {
          visit(parseRaw(item.v));
        } catch (e) {}
      }
    }
  };
  visit(top);
  const latin = buf.toString('latin1');
  const status = latin.match(/\{[^{}]{0,400}"status_code"[^{}]{0,400}\}/);
  if (status) {
    try {
      const parsed = JSON.parse(status[0]);
      out.statusCode = parsed.status_code;
      const msg = parsed.status_msg;
      out.error = (msg && msg.msg_content && msg.msg_content.tips) || parsed.tips || '';
      if (parsed.status_code !== 0) out.ok = false;
    } catch (e) {}
  }
  return out;
}

module.exports = {
  parseRaw,
  encodeRaw,
  buildSendBody,
  buildCreateBody,
  createTemplateUsers,
  parseCreateResponse,
  contentJson,
  parseSendResponse,
};
