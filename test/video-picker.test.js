/**
 * @file Video variety tests: randomized search pages, recent-history filtering, fallback.
 */
const test = require('node:test');
const assert = require('node:assert');
const { normalizeTitle, buildHistory, chooseVideo } = require('../src/video-picker');

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
