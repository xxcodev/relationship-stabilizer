// AI action planner/validator and the confirmation-backed execute endpoint.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dyf-ai-actions-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'app.db');

const repos = require('../src/repos');
const { POOLS } = require('../src/pools');
const { startServer } = require('../src/dashboard');
const aiActions = require('../src/ai/actions');

const cfg = { enabled: true, baseUrl: 'https://ai.test/v1', model: 'm', apiKey: 'k', timeoutMs: 2000, assistantEnabled: true };

function completion(content) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 9 } }),
  };
}

test.after(() => {
  try { require('../src/db').close(); } catch (e) {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('AI action proposal validates whitelist and builds server summaries', async () => {
  repos.seedPools(POOLS);
  const acc = repos.upsertAccount({ label: 'A', profileDir: path.join(tmp, 'p'), port: 9334, friend: 'Hime', enabled: true });
  repos.replaceBands(acc.id, [{ name: '晚', startMin: 1200, endMin: 1410, minCount: 2, maxCount: 4 }]);
  repos.seedAccountDefaults(acc.id);
  repos.addFriend(acc.id, 'Hime');
  const original = global.fetch;
  global.fetch = async () => completion({
    reply: '可以，确认后我会把计划改成 09:00 发 3 条、12:00–14:00 随机发 2 条。',
    actions: [
      { type: 'set_schedule', args: { schedulePoints: [{ mode: 'fixed', time: '09:00', count: 3 }, { mode: 'random', from: '12:00', to: '14:00', count: 2 }] } },
      { type: 'send_now', args: {} },
      { type: 'rm -rf', args: {} },
    ],
  });
  try {
    const out = await aiActions.propose({ acc, text: '09:00 发 3 条，中午随机发 2 条', cfg });
    assert.equal(out.actions.length, 2);
    assert.equal(out.actions[0].type, 'set_schedule');
    assert.match(out.actions[0].summary, /09:00×3/);
    assert.equal(out.actions[1].type, 'send_now');
    assert.equal(out.actions[1].risk, 'high');
  } finally { global.fetch = original; }
});

test('plain conversational replies do not fail as invalid action JSON', async () => {
  const acc = repos.getAccount('A');
  const original = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '这个视频确实和二次元没关系，可能是推荐流偏了。' } }] }) });
  try {
    const out = await aiActions.propose({ acc, text: '你分享的视频和二次元完全没关系啊', cfg });
    assert.match(out.answer, /推荐流/);
    assert.deepEqual(out.actions, []);
  } finally { global.fetch = original; }
});

test('schedule action validates fixed and random trigger points', () => {
  const acc = repos.getAccount('A');
  const action = aiActions.validateAction({
    type: 'set_schedule',
    args: {
      schedulePoints: [
        { mode: 'random', from: '12:00', to: '14:00', count: 2 },
        { time: '09:00', count: 3 },
        { time: '09:00', count: 9 },
      ],
      burstMinSec: 15,
      burstMaxSec: 40,
    },
  }, acc);
  assert.equal(action.type, 'set_schedule');
  assert.deepEqual(action.args.schedulePoints, [
    { mode: 'fixed', time: '09:00', count: 3 },
    { mode: 'random', from: '12:00', to: '14:00', count: 2 },
  ]);
  assert.equal(action.args.burstMinSec, 15);
  assert.equal(action.args.burstMaxSec, 40);
  assert.match(aiActions.actionSummary(action.type, action.args, acc), /09:00×3/);
  assert.match(aiActions.actionSummary(action.type, action.args, acc), /12:00–14:00 随机×2/);

  assert.equal(aiActions.validateAction({
    type: 'set_schedule',
    args: { schedulePoints: [{ mode: 'random', from: '14:00', to: '14:00', count: 2 }] },
  }, acc), null);
  assert.equal(aiActions.validateAction({ type: 'set_schedule', args: { schedulePoints: [] } }, acc), null);
  assert.equal(aiActions.validateAction({ type: 'set_schedule', args: {} }, acc), null);
});

test('common model action aliases normalize to the whitelist', () => {
  const acc = repos.getAccount('A');
  const schedule = aiActions.validateAction({
    type: 'schedule',
    args: { account: 'A', schedulePoints: [{ time: '21:00', count: 4 }] },
  }, acc);
  assert.equal(schedule.type, 'set_schedule');
  assert.deepEqual(schedule.args.schedulePoints, [{ mode: 'fixed', time: '21:00', count: 4 }]);
  const pause = aiActions.validateAction({ type: 'pause', args: {} }, acc);
  assert.equal(pause.type, 'set_enabled');
  assert.equal(pause.args.enabled, false);
});

test('AI execute endpoint applies a validated schedule change', async () => {
  const acc = repos.getAccount('A');
  const { server, url } = await startServer({ host: '127.0.0.1', port: 0 });
  try {
    const before = await (await fetch(url + '/api/config')).json();
    assert.ok(Array.isArray(before.schedulePoints) && before.schedulePoints.length >= 1);
    const res = await fetch(url + '/api/ai/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: {
          type: 'set_schedule',
          args: { schedulePoints: [{ mode: 'fixed', time: '21:00', count: 2 }, { mode: 'random', from: '12:00', to: '14:00', count: 3 }] },
        },
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.match(body.summary, /21:00×2/);
    const after = await (await fetch(url + '/api/config')).json();
    assert.deepEqual(after.schedulePoints, [
      { mode: 'random', from: '12:00', to: '14:00', count: 3 },
      { mode: 'fixed', time: '21:00', count: 2 },
    ]);
    assert.equal(after.scheduleTotal, 5);
  } finally { server.close(); require('../src/db').close(); }
});
