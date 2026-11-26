const test = require('node:test');
const assert = require('node:assert');
const { toPgSql } = require('../src/db-sql');

test('toPgSql converts positional placeholders in order', () => {
  assert.equal(
    toPgSql('SELECT * FROM sends WHERE account_id = ? AND day = ? LIMIT ?'),
    'SELECT * FROM sends WHERE account_id = $1 AND day = $2 LIMIT $3'
  );
  assert.equal(toPgSql('SELECT 1'), 'SELECT 1');
});
