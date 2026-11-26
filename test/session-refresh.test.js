// Session refresh policy and browser hand-off (no real ports or Chrome).
const test = require('node:test');
const assert = require('node:assert');
const refresh = require('../src/session-refresh');

test('needsRefresh covers missing, invalid and near-expiry sessions', () => {
  assert.equal(refresh.needsRefresh(null), true);
  assert.equal(refresh.needsRefresh({ valid: false, ageHours: 1 }), true);
  assert.equal(refresh.needsRefresh({ valid: true, ageHours: 5 }), false);
  assert.equal(refresh.needsRefresh({ valid: true, ageHours: 9.9 }), false);
  assert.equal(refresh.needsRefresh({ valid: true, ageHours: 10 }), true);
  assert.equal(refresh.needsRefresh({ valid: true, ageHours: 12 }), true);
  assert.equal(refresh.needsRefresh({ valid: true, ageHours: 10 }, { beforeHours: 1 }), false);
  assert.equal(refresh.needsRefresh({ valid: true }), false);
});

function browserFetch({ up = true, closes = false, ok = true } = {}) {
  let running = up;
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET' });
    if (url.endsWith('/quit')) {
      if (closes) running = false;
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return { ok: ok && running, json: async () => ({ url: 'about:blank' }) };
  };
  fetchImpl.calls = calls;
  fetchImpl.isUp = () => running;
  return fetchImpl;
}

test('isBrowserUp treats a running server as up and a closed port as down', async () => {
  const up = browserFetch({ up: true });
  assert.equal(await refresh.isBrowserUp(9334, { fetchImpl: up }), true);
  const down = browserFetch({ up: false });
  assert.equal(await refresh.isBrowserUp(9334, { fetchImpl: down }), false);
  const broken = async () => { throw new Error('ECONNREFUSED'); };
  assert.equal(await refresh.isBrowserUp(9334, { fetchImpl: broken }), false);
});

test('closeBrowser is a no-op when no browser is running', async () => {
  const fetchImpl = browserFetch({ up: false });
  assert.equal(await refresh.closeBrowser(9334, { fetchImpl, intervalMs: 1, attempts: 2 }), true);
  assert.equal(fetchImpl.calls.some((c) => c.method === 'POST'), false);
});

test('closeBrowser asks the server to quit and waits for the port to close', async () => {
  const fetchImpl = browserFetch({ up: true, closes: true });
  const before = Date.now();
  assert.equal(await refresh.closeBrowser(9334, { fetchImpl, intervalMs: 1, attempts: 3 }), true);
  assert.ok(fetchImpl.calls.some((c) => c.method === 'POST' && c.url.endsWith('/quit')));
  assert.ok(fetchImpl.calls.filter((c) => c.url.endsWith('/state')).length >= 2);
  assert.ok(Date.now() - before >= 300, 'should give Chrome a moment to release the profile lock');
});

test('closeBrowser reports failure when the port stays occupied', async () => {
  const fetchImpl = browserFetch({ up: true, closes: false });
  assert.equal(await refresh.closeBrowser(9334, { fetchImpl, intervalMs: 1, attempts: 2 }), false);
});
