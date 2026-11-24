/**
 * @file Child-process host: keeps `dashboard` and `schedule` alive for the Electron shell or CLI.
 */
// The host owns the two long-lived processes. All business logic stays in the
// `node src/index.js <cmd>` subcommands, so the packaged app, the dev app and a plain
// CLI supervisor behave identically. Electron runs its own Node build, so children are
// spawned with ELECTRON_RUN_AS_NODE=1 (ignored when the parent is plain Node).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

async function ping(url, timeout = 1500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    return res.ok;
  } catch (e) {
    return false;
  }
}

class Host {
  /**
   * @param {{dataDir?: string, port?: number, env?: object, onLog?: Function}} opts
   */
  constructor({ dataDir, port = 9400, env = {}, onLog } = {}) {
    this.dataDir = path.resolve(dataDir || path.join(ROOT, 'data'));
    this.port = Number(port);
    this.logDir = path.join(this.dataDir, 'logs');
    this.runDir = path.join(this.dataDir, 'run');
    this.children = {};
    this.timers = [];
    this.stopping = false;
    this.owned = false;
    this.intentional = new Set();
    this.restartTimers = {};
    this.onLog = onLog || (() => {});
    this.env = {
      ...process.env,
      ...env,
      DATA_DIR: this.dataDir,
      // absolute paths keep a packaged app out of its read-only .app bundle
      DB_FILE: path.join(this.dataDir, 'app.db'),
      SHOTS_DIR: path.join(this.dataDir, 'shots'),
    };
  }

  log(message) {
    try {
      this.onLog(`host: ${message}`);
    } catch (e) {}
  }

  spawnChild(name, args) {
    const existing = this.children[name];
    if (existing && existing.exitCode === null && alive(existing.pid)) {
      this.log(`${name} already running pid=${existing.pid}; not spawning another`);
      return existing;
    }
    fs.mkdirSync(this.logDir, { recursive: true });
    const out = fs.openSync(path.join(this.logDir, `${name}.log`), 'a');
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: this.env,
      windowsHide: true,
      stdio: ['ignore', out, out],
    });
    child.on('error', (e) => this.log(`${name} spawn failed: ${e.message}`));
    child.on('exit', (code, signal) => {
      try {
        fs.closeSync(out);
      } catch (e) {}
      if (this.children[name] === child) delete this.children[name];
      if (this.stopping) return;
      if (this.intentional.delete(name)) {
        this.log(`${name} exited for a requested restart (code=${code})`);
        return;
      }
      this.log(`${name} exited code=${code} signal=${signal || '-'}; restarting in 2s`);
      const t = setTimeout(() => {
        if (!this.stopping) this.spawnChild(name, args);
      }, 2000);
      if (t.unref) t.unref();
      this.restartTimers[name] = t;
    });
    this.children[name] = child;
    this.log(`${name} started pid=${child.pid}`);
    return child;
  }

  runOnce(args) {
    fs.mkdirSync(this.logDir, { recursive: true });
    const out = fs.openSync(path.join(this.logDir, 'init.log'), 'a');
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: ROOT,
        env: this.env,
        windowsHide: true,
        stdio: ['ignore', out, out],
      });
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`${args.join(' ')} exited ${code}; see ${path.join(this.logDir, 'init.log')}`))
      );
    });
  }

  async start() {
    fs.mkdirSync(this.runDir, { recursive: true });
    fs.mkdirSync(this.logDir, { recursive: true });

    const pidFile = path.join(this.runDir, 'host.pid');
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      if (alive(pid) && pid !== process.pid) {
        throw new Error(`another host is already running (pid ${pid}) on ${this.dataDir}`);
      }
    }
    fs.writeFileSync(pidFile, String(process.pid));
    this.owned = true;
    fs.writeFileSync(
      path.join(this.runDir, 'host.json'),
      JSON.stringify({ pid: process.pid, port: this.port, dataDir: this.dataDir, startedAt: new Date().toISOString() }, null, 2)
    );
    for (const marker of ['stop', 'restart-scheduler']) fs.rmSync(path.join(this.runDir, marker), { force: true });

    // first run: create + seed the database (init is idempotent)
    if (!fs.existsSync(path.join(this.dataDir, 'app.db'))) {
      this.log('database missing; running init');
      await this.runOnce(['src/index.js', 'init']);
      this.log('init ok');
    }

    this.spawnChild('dashboard', ['src/index.js', 'dashboard', '--port', String(this.port)]);
    this.spawnChild('schedule', ['src/index.js', 'schedule']);
    this.timers.push(setInterval(() => this.control(), 2000));
    await this.waitReady(30000);
    this.log(`ready at http://127.0.0.1:${this.port}`);
  }

  async waitReady(ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await ping(`http://127.0.0.1:${this.port}/api/status`)) return;
      await sleep(500);
    }
    throw new Error(`dashboard did not answer on :${this.port} within ${ms}ms; see ${this.logDir}`);
  }

  control() {
    try {
      if (fs.existsSync(path.join(this.runDir, 'stop'))) {
        this.log('stop marker seen');
        this.stop();
        return;
      }
      if (fs.existsSync(path.join(this.runDir, 'restart-scheduler'))) {
        fs.rmSync(path.join(this.runDir, 'restart-scheduler'), { force: true });
        this.log('restart-scheduler marker seen; restarting schedule child');
        clearTimeout(this.restartTimers.schedule);
        delete this.restartTimers.schedule;
        const child = this.children.schedule;
        if (child && child.exitCode === null) {
          // suppress the generic crash-restart in the exit handler; respawn once below
          this.intentional.add('schedule');
          try {
            child.kill('SIGTERM');
          } catch (e) {
            this.intentional.delete('schedule');
          }
          delete this.children.schedule;
        }
        const t = setTimeout(() => {
          if (!this.stopping) this.spawnChild('schedule', ['src/index.js', 'schedule']);
        }, 800);
        if (t.unref) t.unref();
      }
    } catch (e) {
      this.log(`control failed: ${e.message}`);
    }
  }

  releaseFiles() {
    if (!this.owned) return;
    try {
      const pidFile = path.join(this.runDir, 'host.pid');
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      if (pid !== process.pid) return;
    } catch (e) {
      return;
    }
    for (const file of ['host.pid', 'host.json']) fs.rmSync(path.join(this.runDir, file), { force: true });
    this.owned = false;
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.intentional.clear();
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.releaseFiles();
    const kids = Object.values(this.children);
    for (const child of kids) {
      try {
        child.kill('SIGTERM');
      } catch (e) {}
    }
    await sleep(1500);
    for (const child of kids) {
      try {
        child.kill('SIGKILL');
      } catch (e) {}
    }
    this.children = {};
    this.log('stopped');
  }
}

module.exports = { Host, alive, ping, ROOT };
