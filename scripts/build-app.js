#!/usr/bin/env node
/**
 * @file Build the macOS/Windows app in one of two variants.
 *
 *   standard : drives the installed Google Chrome (small dmg, uses the existing login profile)
 *   bundled  : ships Playwright's Chromium, no Chrome install needed (+~200MB, own profile,
 *              requires one QR login)
 *
 * usage: node scripts/build-app.js --variant standard|bundled --platform mac|win|dir
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

const variant = flag('variant', 'standard');
const platform = flag('platform', process.platform === 'darwin' ? 'mac' : 'win');
const pkg = require(path.join(ROOT, 'package.json'));
const config = JSON.parse(JSON.stringify(pkg.build || {}));
const marker = path.join(ROOT, 'app', 'variant.json');
const browsers = path.join(ROOT, 'node_modules', 'playwright-core', '.local-browsers');

if (variant !== 'standard' && variant !== 'bundled') {
  console.error(`unknown variant: ${variant}`);
  process.exit(1);
}
if (!['mac', 'win', 'dir'].includes(platform)) {
  console.error(`unknown platform: ${platform}`);
  process.exit(1);
}

// always start clean so a stale marker can never leak into the standard build
fs.rmSync(marker, { force: true });
// never pack the browser cache inside app.asar: the standard build doesn't use it at all, and
// the bundled build copies it to Resources/playwright-browsers via extraResources
config.files = [...(config.files || []), '!node_modules/playwright-core/.local-browsers/**'];

if (variant === 'bundled') {
  if (!fs.existsSync(browsers)) {
    console.error('缺少内置 Chromium:先运行 `npm run browser:install`');
    process.exit(1);
  }
  config.artifactName = 'heartbeat-delivery-bundled-${version}-${arch}.${ext}';
  config.extraResources = [...(config.extraResources || []), { from: 'node_modules/playwright-core/.local-browsers', to: 'playwright-browsers' }];
  fs.writeFileSync(marker, JSON.stringify({ variant, browser: 'chromium' }, null, 2) + '\n');
}

const configPath = path.join(ROOT, 'build', 'electron-builder.variant.json');
fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

const cli = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
const platformFlag = { mac: '--mac', win: '--win', dir: '--dir' }[platform];
const result = spawnSync(process.execPath, [cli, platformFlag, '--publish', 'never', '--config', configPath], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env },
});

fs.rmSync(configPath, { force: true });
if (variant === 'bundled') fs.rmSync(marker, { force: true });
process.exit(result.status === null ? 1 : result.status);
