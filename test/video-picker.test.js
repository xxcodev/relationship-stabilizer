/**
 * @file Video variety tests: randomized search pages, recent-history filtering, fallback.
 */
const test = require('node:test');
const assert = require('node:assert');
const { normalizeTitle, buildHistory, parseAgeDays, publishWindow, filterRecent, chooseVideo } = require('../src/video-picker');

test('normalizes titles for duplicate comparison', () => {
  assert.equal(normalizeTitle('  Hello   World  '), 'helloworld');
  assert.equal(normalizeTitle(null), '');
});

test('buildHistory collects ids and normalized titles', () => {
  const history = buildHistory([
    { video_id: '123', title: ' Foo  Bar ' },
    { video_id: null, title: 'Baz' },
    { video_id: '456', title: '' },
  ]);
  assert.deepEqual([...history.ids], ['123', '456']);
  assert.deepEqual([...history.titles], ['foobar', 'baz']);
});

test('chooseVideo skips recently sent ids and titles', () => {
  const candidates = [
    { awemeId: '1', title: 'old by id' },
    { awemeId: '2', title: 'Old By Title' },
    { awemeId: '3', title: 'fresh' },
  ];
  const picked = chooseVideo(candidates, { ids: ['1'], titles: ['oldbytitle'] }, () => 0);
  assert.equal(picked.awemeId, '3');
});

test('chooseVideo falls back to repeats when every candidate was sent', () => {
  const candidates = [
    { awemeId: '1', title: 'a' },
    { awemeId: '2', title: 'b' },
  ];
  const picked = chooseVideo(candidates, { ids: ['1', '2'] }, () => 0.999);
  assert.equal(picked.awemeId, '2');
});

test('chooseVideo handles an empty candidate list', () => {
  assert.equal(chooseVideo([], {}, () => 0), null);
});

test('parseAgeDays understands common card date labels', () => {
  const now = new Date('2026-11-25T12:00:00+08:00');
  assert.equal(parseAgeDays('标题 @作者 · 3天前', now), 3);
  assert.equal(parseAgeDays('· 昨天', now), 1);
  assert.equal(parseAgeDays('· 2周前', now), 14);
  assert.equal(parseAgeDays('· 11-20', now), 4.500011574074074);
  assert.equal(parseAgeDays('没有日期', now), null);
});

test('filterRecent drops known-old and undated videos', () => {
  const now = new Date('2026-11-25T12:00:00+08:00');
  const fresh = filterRecent([
    { awemeId: 'old', createTime: 1790000000 },
    { awemeId: 'fresh', createTime: 1795400000 },
    { awemeId: 'unknown' },
  ], 7, { now });
  assert.deepEqual(fresh.map((c) => c.awemeId), ['fresh']);
  const onlyOld = filterRecent([{ ageDays: 8 }, { ageDays: 10 }], 7, { now });
  assert.deepEqual(onlyOld, []);
  const onlyUnknown = filterRecent([{ awemeId: 'u' }], 7, { now });
  assert.deepEqual(onlyUnknown, []);
});

test('publishWindow maps to the supported search windows', () => {
  assert.equal(publishWindow(0), 0);
  assert.equal(publishWindow(1), 1);
  assert.equal(publishWindow(7), 7);
  assert.equal(publishWindow(10), 30);
  assert.equal(publishWindow(90), 180);
});
