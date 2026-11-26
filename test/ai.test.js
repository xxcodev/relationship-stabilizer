// AI client/ranker/assistant pure logic tests (network mocked).
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'dyf-ai-'));
process.env.DATA_DIR = tmpData;
const client = require('../src/ai/client');
const ranker = require('../src/ai/ranker');
const assistant = require('../src/ai/assistant');

test.after(() => fs.rmSync(tmpData, { recursive: true, force: true }));

const cfg = {
  enabled: true,
  baseUrl: 'https://ai.test/v1',
  model: 'test-model',
  apiKey: 'secret',
  timeoutMs: 2000,
  assistantEnabled: true,
};

function chatCompletion(content) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 3 } }),
  };
}

test('client publicConfig never exposes the API key and blank save keeps it', () => {
  const saved = client.save({ enabled: true, apiKey: 'secret', baseUrl: cfg.baseUrl, model: cfg.model });
  assert.equal(saved.hasApiKey, true);
  assert.equal(saved.apiKey, undefined);
  client.save({ enabled: true, apiKey: '' });
  assert.equal(client.load().apiKey, 'secret');
  assert.equal(fs.statSync(client.FILE).mode & 0o777, 0o600);
});

test('chatJson extracts JSON from an explanation wrapper', async () => {
  const out = await client.chatJson({
    cfg,
    messages: [{ role: 'user', content: 'x' }],
    fetchImpl: async () => chatCompletion('好的：\n```json\n{"items":[{"id":"1"}]}\n```'),
  });
  assert.deepEqual(out.data, { items: [{ id: '1' }] });
});

test('rankCandidates filters unsafe/ads and ranks by score', async () => {
  ranker.clearCache();
  const calls = [];
  const out = await ranker.rankCandidates([
    { awemeId: '1', title: 'a' },
    { awemeId: '2', title: 'b' },
    { awemeId: '3', title: 'c' },
    { awemeId: '4', title: 'd' },
  ], {
    mode: 'rank',
    interests: ['搞笑'],
    cfg,
    fetchImpl: async (url, init) => {
      calls.push(JSON.parse(init.body));
      return chatCompletion(JSON.stringify({
        items: [
          { id: '1', safe: true, ad: false, score: 10, topic: '搞笑' },
          { id: '2', safe: true, ad: false, score: 90, topic: '搞笑' },
          { id: '3', safe: false, ad: false, score: 99 },
          { id: '4', safe: true, ad: true, score: 99 },
        ],
      }));
    },
  });
  assert.equal(out.used, true);
  assert.deepEqual(out.candidates.map((c) => c.awemeId), ['2', '1']);
  assert.equal(calls[0].messages[0].role, 'system');
});

test('rankCandidates keeps input order in moderate mode', async () => {
  ranker.clearCache();
  const out = await ranker.rankCandidates([
    { awemeId: 'a', title: 'a' },
    { awemeId: 'b', title: 'b' },
  ], {
    mode: 'moderate',
    cfg,
    fetchImpl: async () => chatCompletion(JSON.stringify({
      items: [
        { id: 'a', safe: true, ad: false, score: 10 },
        { id: 'b', safe: true, ad: false, score: 99 },
      ],
    })),
  });
  assert.deepEqual(out.candidates.map((c) => c.awemeId), ['a', 'b']);
});

test('rankCandidates falls back to the original list on AI failure', async () => {
  ranker.clearCache();
  const input = [{ awemeId: 'x', title: 'x' }];
  const out = await ranker.rankCandidates(input, {
    mode: 'rank',
    cfg,
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'boom' }),
  });
  assert.equal(out.used, false);
  assert.deepEqual(out.candidates, input);
});

test('rankCandidates treats an empty AI item list as a fallback, not a filter', async () => {
  ranker.clearCache();
  const input = [{ awemeId: 'x', title: 'x' }];
  const out = await ranker.rankCandidates(input, {
    mode: 'rank',
    cfg,
    fetchImpl: async () => chatCompletion('{"items":[]}'),
  });
  assert.equal(out.used, false);
  assert.deepEqual(out.candidates, input);
});

test('rankCandidates is off when not configured or mode is off', async () => {
  ranker.clearCache();
  const input = [{ awemeId: 'x' }];
  const off = await ranker.rankCandidates(input, { mode: 'off', cfg });
  assert.equal(off.used, false);
  const noKey = await ranker.rankCandidates(input, { mode: 'rank', cfg: { ...cfg, apiKey: '' } });
  assert.equal(noKey.used, false);
});

test('validateDraft rejects invalid trigger points and normalizes valid input', () => {
  assert.throws(() => assistant.validateDraft({ schedulePoints: [] }), /有效触发点/);
  assert.throws(() => assistant.validateDraft({ schedulePoints: [{ mode: 'random', from: '20:00', to: '19:00' }] }), /有效触发点/);
  assert.throws(() => assistant.validateDraft({ schedulePoints: [{ mode: 'fixed', time: '25:00' }] }), /有效触发点/);
  const d = assistant.validateDraft({
    schedulePoints: [
      { mode: 'fixed', time: '20:00', count: 3 },
      { mode: 'random', from: '21:00', to: '23:30', count: 2 },
      { mode: 'fixed', time: '20:00', count: 9 },
    ],
    banWords: ['恐怖', ''],
    videoSource: 'recommend',
    filterMinLikes: 1000,
    filterMinComments: 0,
    filterMinFavorites: 8,
    filterMinShares: -2,
  });
  assert.deepEqual(d.schedulePoints, [
    { mode: 'fixed', time: '20:00', count: 3 },
    { mode: 'random', from: '21:00', to: '23:30', count: 2 },
  ]);
  assert.deepEqual(d.banWords, ['恐怖']);
  assert.equal(d.videoSource, 'recommend');
  assert.deepEqual(d.filters, { minLikes: 1000, minComments: 0, minFavorites: 8, minShares: 0 });
});
