/**
 * @file Electron shell (P0): starts the two background children via src/host.js and shows the
 * existing dashboard in a desktop window.
 *
 * Dev:   npm run app:dev        -> port 9420, data in <repo>/data-app (never touches production data)
 * Packaged: port 9400, data in the platform userData directory.
 */
const { app, BrowserWindow, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { Host } = require('../src/host');

const ROOT = path.resolve(__dirname, '..');
const DEV = !app.isPackaged;
const PORT = Number(process.env.DF_PORT || (DEV ? 9420 : 9400));
const DATA_DIR = path.resolve(
  process.env.DF_DATA_DIR || (DEV ? path.join(ROOT, 'data-app') : path.join(app.getPath('userData'), 'data'))
);
const LOG_DIR = path.join(DATA_DIR, 'logs');

let win = null;
let host = null;
let shuttingDown = false;

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, 'app.log'), line + '\n');
  } catch (e) {}
}

function checkSqlite() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('create table probe(a)');
    db.close();
    log(`node:sqlite OK in Electron main (node ${process.versions.node})`);
  } catch (e) {
    log(`node:sqlite MISSING in Electron main: ${e.message}`);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName('抖音转发');
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  app.whenReady().then(boot).catch((e) => fail(e));
}

async function boot() {
  log(`electron=${process.versions.electron} node=${process.versions.node} dev=${DEV}`);
  log(`data=${DATA_DIR} port=${PORT}`);
  checkSqlite();

  host = new Host({
    dataDir: DATA_DIR,
    port: PORT,
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      DASH_PORT: String(PORT),
      // dev only: keep the Chrome profile port away from the live production account (:9333)
      ...(DEV ? { ACCOUNT_PORT: '9433' } : {}),
    },
    onLog: log,
  });
  await host.start();
  createWindow();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 880,
    title: '抖音转发',
    backgroundColor: '#0f1115',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.on('closed', () => {
    win = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL(`http://127.0.0.1:${PORT}`);
  log('window created');
}

function fail(err) {
  log(`boot failed: ${(err && err.stack) || err}`);
  try {
    dialog.showErrorBox('抖音转发启动失败', `${(err && err.message) || err}\n\n日志：${path.join(LOG_DIR, 'app.log')}`);
  } catch (e) {}
  app.quit();
}

app.on('window-all-closed', () => app.quit());

// Terminal `kill` / Ctrl-C in dev should still run the graceful shutdown path.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log(`${signal} received; quitting`);
    app.quit();
  });
}

app.on('before-quit', (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  log('quitting; stopping children');
  const done = () => app.exit(0);
  Promise.resolve(host && host.stop()).then(done, done);
});
