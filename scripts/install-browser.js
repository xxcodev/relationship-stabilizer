#!/usr/bin/env node
/**
 * @file Download Playwright's Chromium into node_modules for the bundled variant.
 *
 * PLAYWRIGHT_BROWSERS_PATH=0 puts the browser under node_modules/playwright-core/.local-browsers,
 * which is what `scripts/build-app.js --variant bundled` copies into the packaged app.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const cli = path.join(__dirname, '..', 'node_modules', 'playwright-core', 'cli.js');
const result = spawnSync(process.execPath, [cli, 'install', 'chromium', '--no-shell'], {
  stdio: 'inherit',
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '0' },
});
process.exit(result.status === null ? 1 : result.status);
