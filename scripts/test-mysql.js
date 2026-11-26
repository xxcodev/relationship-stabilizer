#!/usr/bin/env node
// Opt-in: spins up an ephemeral real MySQL 8 and runs the external-backend integration test.
process.env.TEST_MYSQL = '1';
const { spawnSync } = require('child_process');
const path = require('path');
const result = spawnSync(process.execPath, ['--test', 'test/db-mysql.test.js'], {
  cwd: path.resolve(__dirname, '..'),
  stdio: 'inherit',
  env: process.env,
});
process.exit(result.status == null ? 1 : result.status);
