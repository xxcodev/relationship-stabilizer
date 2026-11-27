const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dyf-docker-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'app.db');
process.env.BROWSER_NO_SANDBOX = 'true';
process.env.BROWSER_DISABLE_DEV_SHM = 'true';
process.env.BROWSER_MINIMIZE_ON_START = 'false';
process.env.BROWSER_ARGS = '--disable-gpu --lang=zh-CN';

const env = require('../src/env');
const { Host, cleanStaleProfileLocks } = require('../src/host');
const { startServer } = require('../src/dashboard');
const db = require('../src/db');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.once('listening', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.listen(0, '127.0.0.1');
  });
}

test.after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('env builds container browser launch flags and SHOTS_DIR under DATA_DIR', () => {
  assert.strictEqual(env.SHOTS_DIR, path.join(tmp, 'shots'));
  assert.strictEqual(env.browser.noSandbox, true);
  assert.strictEqual(env.browser.disableDevShm, true);
  assert.strictEqual(env.browser.minimizeOnStart, false);
  const args = env.browserLaunchArgs(env.browser, '0,0');
  assert.deepStrictEqual(args, [
    '--window-position=0,0',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--lang=zh-CN',
  ]);
});

test('cleanStaleProfileLocks removes Chromium singleton locks in both profile dirs', () => {
  const base = path.join(tmp, 'profile-a');
  const chromiumDir = `${base}-chromium`;
  for (const dir of [base, chromiumDir]) {
    fs.mkdirSync(dir, { recursive: true });
    for (const file of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      fs.writeFileSync(path.join(dir, file), 'stale');
    }
    fs.writeFileSync(path.join(dir, 'Preferences'), '{}');
  }
  cleanStaleProfileLocks(base);
  for (const dir of [base, chromiumDir]) {
    assert.strictEqual(fs.existsSync(path.join(dir, 'SingletonLock')), false);
    assert.strictEqual(fs.existsSync(path.join(dir, 'SingletonCookie')), false);
    assert.strictEqual(fs.existsSync(path.join(dir, 'SingletonSocket')), false);
    assert.strictEqual(fs.existsSync(path.join(dir, 'Preferences')), true);
  }
});

test('dashboard exposes /healthz when bound to 0.0.0.0', async () => {
  const started = await startServer({ host: '0.0.0.0', port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${started.port}/healthz`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.ok(body.version);
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
  }
});

test('Host boots dashboard + scheduler children with env paths and stops cleanly', async () => {
  const hostData = path.join(tmp, 'host-run');
  const port = await freePort();
  const logs = [];
  const host = new Host({
    dataDir: hostData,
    port,
    streamLogs: true,
    env: { DASH_HOST: '0.0.0.0' },
    onLog: (m) => logs.push(m),
  });
  try {
    await host.start();
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.strictEqual(health.status, 200);
    const statusRes = await fetch(`http://127.0.0.1:${port}/api/status`);
    assert.strictEqual(statusRes.status, 200);
    const status = await statusRes.json();
    assert.strictEqual(status.scheduler.running, true);
    assert.strictEqual(status.scheduler.kind, 'host');
    assert.ok(fs.existsSync(path.join(hostData, 'app.db')));
    assert.ok(fs.existsSync(path.join(hostData, 'logs', 'dashboard.log')));
  } finally {
    await host.stop();
  }
  assert.strictEqual(fs.existsSync(path.join(hostData, 'run', 'host.pid')), false);
  assert.ok(logs.some((l) => l.includes('ready at')));
  assert.ok(logs.some((l) => l.includes('stopped')));
});

test('docker-entrypoint.sh has valid POSIX shell syntax', () => {
  const script = path.join(__dirname, '..', 'docker-entrypoint.sh');
  execFileSync('sh', ['-n', script], { stdio: 'pipe' });
});
