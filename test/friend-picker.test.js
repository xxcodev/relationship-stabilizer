/**
 * @file Friend rotation tests: the least-sent friend today goes first, ties stay random.
 */
const test = require('node:test');
const assert = require('node:assert');
const { chooseFriend } = require('../src/friend-picker');

test('picks the friend with the fewest successful sends today', () => {
  const counts = { Hime: 3, 拍拍: 0, 薄荷西瓜汁: 1 };
  assert.equal(chooseFriend(['Hime', '拍拍', '薄荷西瓜汁'], counts, () => 0), '拍拍');
});

test('keeps rotating after every friend has one send', () => {
  const counts = { A: 1, B: 1, C: 0 };
  assert.equal(chooseFriend(['A', 'B', 'C'], counts, () => 0), 'C');
  assert.equal(chooseFriend(['A', 'B'], { A: 1, B: 2 }, () => 0.99), 'A');
});

test('breaks ties with the provided random source', () => {
  const counts = { A: 2, B: 2, C: 2 };
  assert.equal(chooseFriend(['A', 'B', 'C'], counts, () => 0), 'A');
  assert.equal(chooseFriend(['A', 'B', 'C'], counts, () => 0.999), 'C');
});

test('ignores blanks, duplicates and unknown count keys', () => {
  const counts = { B: 1, stranger: 9 };
  assert.equal(chooseFriend(['', 'A', 'A', null, 'B'], counts, () => 0), 'A');
  assert.equal(chooseFriend(['A', 'B'], counts, () => 0.999), 'A');
});

test('returns null when no friend is configured', () => {
  assert.equal(chooseFriend([], {}), null);
  assert.equal(chooseFriend(['', '   '], {}), null);
});
