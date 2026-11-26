// AI assistant / config-draft integration with a mocked provider and a throwaway SQLite DB.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dyf-ai-assistant-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'app.db');

const repos = require('../src/repos');
const { POOLS } = require('../src/pools');
const assistant = require('../src/ai/assistant');

const cfg = { enabled: true, baseUrl: 'https://ai.test/v1', model: 'm', apiKey: 'k', timeoutMs: 2000, assistantEnabled: true };

function completion(content) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 9 } }),
  };
}

test.after(() => {
  try { require('../src/db').close(); } catch (e) {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('assistant answers from a read-only account snapshot', async () => {
  repos.seedPools(POOLS);
  const acc = repos.upsertAccount({ label: 'A', profileDir: path.join(tmp, 'p'), port: 9334, friend: 'Hime', enabled: true });
  repos.replaceBands(acc.id, [{ name: '晚', startMin: 1200, endMin: 1410, minCount: 2, maxCount: 4 }]);
  repos.seedAccountDefaults(acc.id);
  repos.addFriend(acc.id, 'Hime');

  let body = null;
  const original = global.fetch;
  global.fetch = async (url, init) => {
    body = JSON.parse(init.body);
    return completion('今天计划 3 条，已发 0 条；最近没有失败事件。');
  };
  try {
    const out = await assistant.ask({
      acc,
      question: '那推荐源呢？',
      history: [
        { role: 'user', content: '今天为什么只发了 0 条？' },
        { role: 'assistant', content: '今天计划 3 条，已发 0 条。' },
      ],
      cfg,
    });
    assert.match(out.answer, /今天计划/);
    const sent = JSON.stringify(body);
    assert.ok(sent.includes('今天为什么只发了 0 条'));
    assert.ok(sent.includes('那推荐源呢'));
    assert.ok(sent.includes('schedulePoints'));
    assert.ok(sent.includes('filterMinLikes'));
    assert.ok(!sent.includes('sid='));
    assert.ok(!sent.includes('"cookie":'));
  } finally {
    global.fetch = original;
  }
});

test('config draft is parsed and validated before returning', async () => {
  const acc = repos.getAccount('A');
  const original = global.fetch;
  global.fetch = async () => completion(JSON.stringify({
    schedulePoints: [
      { mode: 'fixed', time: '20:00', count: 3 },
      { mode: 'random', from: '21:00', to: '23:30', count: 2 },
    ],
    banWords: ['恐怖'],
    videoSource: 'recommend',
    filterMinLikes: 500,
    filterMinComments: 20,
    notes: '晚上为主',
  }));
  try {
    const out = await assistant.draftConfig({ acc, text: '20 点发 3 条，晚上随机再发 2 条，避开恐怖内容', cfg });
    assert.deepEqual(out.draft.schedulePoints, [
      { mode: 'fixed', time: '20:00', count: 3 },
      { mode: 'random', from: '21:00', to: '23:30', count: 2 },
    ]);
    assert.equal(out.draft.videoSource, 'recommend');
    assert.deepEqual(out.draft.banWords, ['恐怖']);
    assert.deepEqual(out.draft.filters, {
      minLikes: 500, minComments: 20, minFavorites: 0, minShares: 0,
    });
  } finally {
    global.fetch = original;
  }
});
