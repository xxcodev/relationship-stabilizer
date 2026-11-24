/**
 * @file Unit tests for the pure-API session file validity checks.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const apiSession = require('../src/api-session');

function session(overrides = {}) {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    account: 'B',
    friend: 'Hime',
    template: { url: 'https://example', bodyB64: 'AAAA' },
    cookies: [{ name: 'sessionid', value: 'x', domain: '.douyin.com' }],
    ...overrides,
  };
}

test('missing session / template / cookies are invalid', () => {
  assert.strictEqual(apiSession.status(null).valid, false);
  assert.match(apiSession.status(session({ template: null })).reason, /template/);
  assert.match(apiSession.status(session({ cookies: [] })).reason, /cookies/);
});

test('friend mismatch is invalid', () => {
  const state = apiSession.status(session(), 'SomeoneElse');
  assert.strictEqual(state.valid, false);
  assert.match(state.reason, /friend/);
});

test('expired sessions are invalid', () => {
  const old = session({ createdAt: new Date(Date.now() - 13 * 3600 * 1000).toISOString() });
  const state = apiSession.status(old, 'Hime');
  assert.strictEqual(state.valid, false);
  assert.match(state.reason, /old/);
});

test('valid session returns age', () => {
  const state = apiSession.status(session(), 'Hime');
  assert.strictEqual(state.valid, true);
  assert.ok(state.ageHours >= 0);
});

test('save/load/clear round-trip with 0600 permissions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-session-'));
  const file = path.join(dir, 'api-session.json');
  try {
    apiSession.save(session(), file);
    const loaded = apiSession.load(file);
    assert.strictEqual(loaded.friend, 'Hime');
    const mode = fs.statSync(file).mode & 0o777;
    assert.strictEqual(mode, 0o600);
    apiSession.clear(file);
    assert.strictEqual(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
