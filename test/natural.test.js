// Public comment parsing + AI share-note generation (network mocked).
const test = require('node:test');
const assert = require('node:assert');
const { fetchComments, useful } = require('../src/comments');
const naturalAi = require('../src/ai/natural');

const cfg = { enabled: true, baseUrl: 'https://ai.test/v1', model: 'm', apiKey: 'k', timeoutMs: 2000, assistantEnabled: true };

test('public comments are filtered, sorted by likes and de-duplicated', async () => {
  const original = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      status_code: { StatusCode: 0, StatusMsg: '' },
      comments: [
        { text: '00:07', digg_count: 999, user: { nickname: 'a' } },
        { text: '第一条有意思', digg_count: 10, user: { nickname: 'b' } },
        { text: '第一条有意思', digg_count: 9, user: { nickname: 'c' } },
        { text: '第二条更好笑', digg_count: 50, user: { nickname: 'd' } },
        { text: 'https://spam.example', digg_count: 1, user: { nickname: 'e' } },
      ],
    }),
  });
  try {
    const out = await fetchComments({ cookies: [] }, '123', { limit: 5 });
    assert.deepEqual(out.comments.map((c) => c.text), ['第二条更好笑', '第一条有意思']);
    assert.equal(useful('00:07'), false);
    assert.equal(useful('正常评论'), true);
  } finally { global.fetch = original; }
});

test('AI compose returns short valid messages', async () => {
  const original = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ messages: ['这个评论区太真实了', '你看过没'] }) } }] }),
  });
  try {
    const out = await naturalAi.composeShareNotes({
      video: { title: '测试视频', author: '作者' },
      comments: [{ text: '哈哈哈', likes: 3 }],
      cfg,
    });
    assert.equal(out.used, true);
    assert.deepEqual(out.messages, ['这个评论区太真实了', '你看过没']);
  } finally { global.fetch = original; }
});

test('AI failure falls back to a neutral short note', async () => {
  const original = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500, text: async () => 'nope' });
  try {
    const out = await naturalAi.composeShareNotes({ video: { title: '测试视频' }, comments: [], cfg });
    assert.equal(out.used, false);
    assert.ok(out.messages.length >= 1);
    assert.ok(out.messages.every((m) => m.length <= 60));
  } finally { global.fetch = original; }
});

test('mechanical template wording is filtered from AI notes', () => {
  const out = naturalAi.validMessages([
    '刷到这个新番导视，感觉可以蹲一波',
    '五条悟一出来我就知道要出事',
    '这个视频真的绝了',
    '评论区那句“一出来就知道要出事”，笑到我了',
  ]);
  assert.deepEqual(out, ['五条悟一出来我就知道要出事', '评论区那句“一出来就知道要出事”，笑到我了']);
});
