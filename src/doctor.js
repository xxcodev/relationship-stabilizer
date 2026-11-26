/**
 * @file Environment self-check: node, sqlite, data dir, playwright, browser, port, account.
 */
// Environment check: what is missing before this program can run on a new machine.
const fs = require('fs');
const path = require('path');
const net = require('net');
const env = require('./env');

const ok = (label, detail) => ({ ok: true, label, detail });
const bad = (label, detail) => ({ ok: false, label, detail });

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  return major >= 22
    ? ok('Node.js', `v${process.versions.node} (node:sqlite available)`)
    : bad('Node.js', `v${process.versions.node} — need >= 22.5 for node:sqlite`);
}

function checkSqlite() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('create table t(a)');
    db.close();
    return ok('node:sqlite', 'usable');
  } catch (e) {
    return bad('node:sqlite', e.message);
  }
}

async function checkDatabase() {
  try {
    const cfg = require('./db-config').load();
    if (cfg.driver === 'sqlite') return ok('database', 'SQLite (default)');
    const out = await require('./db-config').testConnection(cfg);
    return ok('database', `${out.driver}: ${out.detail}`);
  } catch (e) {
    return bad('database', e.message.split('\n')[0]);
  }
}

function checkDataDir() {
  try {
    fs.mkdirSync(env.DATA_DIR, { recursive: true });
    const probe = path.join(env.DATA_DIR, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return ok('DATA_DIR', env.DATA_DIR);
  } catch (e) {
    return bad('DATA_DIR', `${env.DATA_DIR} not writable: ${e.message}`);
  }
}

function checkBrowser() {
  const candidates = env.browser.executablePath
    ? [env.browser.executablePath]
    : {
        darwin: [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ],
        linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
        win32: [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        ],
      }[env.platform] || [];
  const found = candidates.find((p) => fs.existsSync(p));
  if (found) return ok('browser', found);
  if (env.browser.channel === 'chromium') {
    const dir = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (dir && dir !== '0' && fs.existsSync(dir)) return ok('browser', `bundled Chromium (${dir})`);
    return ok('browser', 'Playwright-managed Chromium (run `npm run browser:install`)');
  }
  return bad('browser', `no Chrome found; set BROWSER_EXECUTABLE or BROWSER_CHANNEL=chromium`);
}

function checkPlaywright() {
  try {
    require.resolve('playwright-core');
    return ok('playwright-core', 'installed');
  } catch (e) {
    return bad('playwright-core', 'not installed — run `npm install`');
  }
}

function checkPort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (e) =>
      resolve(e.code === 'EADDRINUSE' ? bad(`port ${port}`, 'already in use') : bad(`port ${port}`, e.message))
    );
    srv.once('listening', () => srv.close(() => resolve(ok(`port ${port}`, 'free'))));
    srv.listen(port, '127.0.0.1');
  });
}

async function run() {
  const results = [checkNode(), checkSqlite(), checkDataDir(), checkPlaywright(), checkBrowser(), await checkDatabase()];
  results.push(await checkPort(env.dashboard.port));
  const acc = (() => {
    try {
      const repos = require('./repos');
      return repos.getAccount();
    } catch (e) {
      return null;
    }
  })();
  results.push(acc ? ok('account', `${acc.label} → ${acc.friend || '(no friend)'} :${acc.port}`) : bad('account', 'none — run `npm run init` or `npm run migrate`'));
  return results;
}

module.exports = { run };

if (require.main === module) {
  run().then((rs) => {
    for (const r of rs) console.log(`${r.ok ? '✔' : '✖'} ${r.label.padEnd(16)} ${r.detail}`);
    process.exit(rs.every((r) => r.ok) ? 0 : 1);
  });
}
