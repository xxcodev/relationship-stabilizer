#!/usr/bin/env node
// Opt-in: spins up a real PostgreSQL instance (bundled binary) and runs the external-backend test.
process.env.TEST_PG_REAL = '1';
const { spawnSync } = require('child_process');
const path = require('path');
const result = spawnSync(process.execPath, ['--test', 'test/db-postgres-real.test.js'], {
  cwd: path.resolve(__dirname, '..'),
  stdio: 'inherit',
  env: process.env,
});
process.exit(result.status == null ? 1 : result.status);
