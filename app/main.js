/**
 * @file Electron shell: tray + window + background host lifecycle.
 *
 * - dev (`npm run app:dev`): port 9420, data in <repo>/data-app, no first-run wizard
 * - packaged: port 9400, data in the platform userData directory (or a user-picked data dir)
 *
 * The two long-lived processes stay in src/host.js, so CLI usage and the app share one model.
 */
const { app, BrowserWindow, Tray, Menu, dialog, shell, nativeImage, screen } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { Host } = require('../src/host');

const DEV = !app.isPackaged;
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_PORT = DEV ? 9420 : 9400;
const TITLE = '心动投递';
// older builds used this name; keep their settings.json when upgrading
const LEGACY_TITLES = ['抖音转发'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// app.getName() feeds userData; set it before the first getPath call.
app.setName(TITLE);

let settings = {};
let dataDir = '';
let port = DEFAULT_PORT;
let logDir = '';
let host = null;
let win = null;
let tray = null;
let trayTimer = null;
let viewerWin = null;
let viewerPort = null;
let viewerStarted = false;
let viewerChild = null;
let quitting = false;

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

// keep the chosen data directory when upgrading from a build with the old app name
function migrateLegacySettings() {
  const target = settingsFile();
  if (fs.existsSync(target)) return;
  for (const name of LEGACY_TITLES) {
    const legacy = path.join(app.getPath('appData'), name, 'settings.json');
    if (!fs.existsSync(legacy)) continue;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(legacy, target);
      log(`migrated settings from ${legacy}`);
    } catch (e) {
      log(`settings migration failed: ${e.message}`);
    }
    return;
  }
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveSettings(patch) {
  settings = { ...settings, ...patch };
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (e) {
    log(`saveSettings failed: ${e.message}`);
  }
  return settings;
}

function applyPaths() {
  dataDir = path.resolve(
    process.env.DF_DATA_DIR || (DEV ? path.join(ROOT, 'data-app') : settings.dataDir || path.join(app.getPath('userData'), 'data'))
  );
  port = Number(process.env.DF_PORT || (DEV ? DEFAULT_PORT : settings.port) || DEFAULT_PORT);
  logDir = path.join(dataDir, 'logs');
  // main process helpers (login / tray state) share the same DB as the children
  process.env.DATA_DIR = dataDir;
  process.env.DB_FILE = path.join(dataDir, 'app.db');
  process.env.SHOTS_DIR = path.join(dataDir, 'shots');
}

// "Move to front" should land on the display the user is actually looking at, not always the
// primary one (multi-monitor). Set before the browser-server child is spawned.
function visiblePosition() {
  try {
    const point = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(point);
    return `${Math.round(display.workArea.x + 80)},${Math.round(display.workArea.y + 80)}`;
  } catch (e) {
    return '80,80';
  }
}

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.log(line);
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'app.log'), line + '\n');
  } catch (e) {}
}

function checkPortFree(p) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(p, '127.0.0.1');
  });
}

async function firstRunWizard() {
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: TITLE,
    message: '首次运行 · 选择数据目录',
    detail:
      '应用需要保存数据库、浏览器登录态和截图。\n\n' +
      '· 新建目录：在系统应用数据目录下创建（推荐）\n' +
      '· 使用已有目录：指向之前 douyin-forwarder 的 data 目录（免重新扫码登录）',
    buttons: ['新建数据目录', '使用已有数据目录', '退出'],
    defaultId: 0,
    cancelId: 2,
  });
  if (response === 2) {
    app.exit(0);
    return false;
  }
  if (response === 1) {
    const picked = await dialog.showOpenDialog({
      title: '选择已有的 data 目录',
      properties: ['openDirectory'],
    });
    if (!picked.canceled && picked.filePaths[0]) saveSettings({ dataDir: picked.filePaths[0] });
    else saveSettings({ dataDir: path.join(app.getPath('userData'), 'data') });
  } else {
    saveSettings({ dataDir: path.join(app.getPath('userData'), 'data') });
  }
  return true;
}

function api(action) {
  return fetch(`http://127.0.0.1:${port}/api/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
    signal: AbortSignal.timeout(5000),
  })
    .then((r) => r.json())
    .catch((e) => ({ ok: false, error: e.message }));
}

function account() {
  try {
    return require('../src/repos').getAccount();
  } catch (e) {
    return null;
  }
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 880,
    title: TITLE,
    backgroundColor: '#0f1115',
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  win.once('ready-to-show', () => {
    win.show();
    if (DEV && app.dock) {
      try {
        app.dock.setIcon(nativeImage.createFromPath(path.join(ROOT, 'logo.png')));
      } catch (e) {}
    }
  });
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  win.on('closed', () => {
    win = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => log(`window load failed: ${code} ${desc}`));
  win.loadURL(`http://127.0.0.1:${port}`);
  log('window created');
}

function trayIcon() {
  const paths = [path.join(ROOT, 'logo.png'), path.join(ROOT, 'build', 'icon.png')];
  for (const p of paths) {
    try {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) return img.resize({ width: 18, height: 18, quality: 'best' });
    } catch (e) {}
  }
  return nativeImage.createEmpty();
}

function buildTrayMenu() {
  const acc = account();
  const enabled = acc ? !!acc.enabled : true;
  const loginItem = app.getLoginItemSettings();
  const item = (label, click, extra = {}) => ({ label, click, ...extra });
  return Menu.buildFromTemplate([
    item('打开面板', () => showWindow()),
    { type: 'separator' },
    item(enabled ? '暂停发送' : '继续发送', async () => {
      const res = await api(enabled ? 'pause' : 'resume');
      if (!res.ok) dialog.showErrorBox('操作失败', res.error || '面板无响应');
      refreshTrayMenu();
    }),
    item('立即重启调度', async () => {
      const res = await api('restart');
      if (!res.ok) dialog.showErrorBox('操作失败', res.error || '面板无响应');
    }),
    { type: 'separator' },
    item('抖音画面…', () => openViewer()),
    item('扫码登录…', () => login()),
    item('打开日志目录', () => shell.openPath(logDir)),
    item('打开数据目录', () => shell.openPath(dataDir)),
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: !!loginItem.openAtLogin,
      enabled: app.isPackaged,
      click: (menuItem) => {
        app.setLoginItemSettings({ openAtLogin: menuItem.checked, openAsHidden: true });
        refreshTrayMenu();
      },
    },
    item('选择数据目录…', () => chooseDataDir()),
    { type: 'separator' },
    item(`关于 ${TITLE} v${app.getVersion()}`, () => about()),
    item('退出', () => app.quit(), { accelerator: 'CmdOrCtrl+Q' }),
  ]);
}

function refreshTrayMenu() {
  if (!tray) return;
  try {
    tray.setContextMenu(buildTrayMenu());
  } catch (e) {
    log(`tray menu failed: ${e.message}`);
  }
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip(TITLE);
  if (process.platform === 'darwin') tray.setTitle(DEV ? ` ${TITLE}(dev)` : ` ${TITLE}`);
  refreshTrayMenu();
  tray.on('double-click', () => showWindow());
  trayTimer = setInterval(refreshTrayMenu, 5000);
  log('tray created');
}

async function chooseDataDir() {
  const picked = await dialog.showOpenDialog({
    title: '选择数据目录',
    defaultPath: dataDir,
    properties: ['openDirectory'],
  });
  if (picked.canceled || !picked.filePaths[0]) return;
  saveSettings({ dataDir: picked.filePaths[0] });
  const { response } = await dialog.showMessageBox({
    type: 'info',
    message: '数据目录已修改，需要重启应用生效',
    buttons: ['立即重启', '稍后'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) {
    app.relaunch();
    app.quit();
  }
}

function browserBase(accountPort) {
  return `http://127.0.0.1:${accountPort}`;
}

async function browserUp(accountPort) {
  try {
    const res = await fetch(`${browserBase(accountPort)}/state`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch (e) {
    return false;
  }
}

async function quitBrowserServer(accountPort) {
  try {
    await fetch(`${browserBase(accountPort)}/quit`, { method: 'POST', signal: AbortSignal.timeout(3000) });
  } catch (e) {}
}

// The viewer talks to the dashboard proxy (/api/screen, /api/click, /api/window), which in turn
// talks to browser-server. Chrome itself stays on the off-screen position; the user only sees
// the frame inside the app.
async function ensureBrowserServer(acc) {
  if (await browserUp(acc.port)) return { ok: true, started: false };
  log(`starting browser-server on :${acc.port} for the in-app viewer`);
  try {
    const child = spawn(
      process.execPath,
      [path.join(ROOT, 'src', 'browser-server.js'), '--profile', acc.profile_dir, '--port', String(acc.port)],
      {
        cwd: ROOT,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', BROWSER_VISIBLE_POS: visiblePosition() },
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      }
    );
    child.unref();
    viewerChild = child;
  } catch (e) {
    return { ok: false, error: e.message };
  }
  for (let i = 0; i < 40; i++) {
    await sleep(750);
    if (await browserUp(acc.port)) return { ok: true, started: true };
  }
  return { ok: false, error: `浏览器端口 ${acc.port} 未就绪（可能是 profile 被占用）` };
}

async function openViewer({ login = false } = {}) {
  const acc = account();
  if (!acc) {
    dialog.showErrorBox('没有账号', '请先在面板里初始化或导入数据目录。');
    return;
  }
  if (viewerWin) {
    viewerWin.show();
    viewerWin.focus();
    return;
  }
  const ready = await ensureBrowserServer(acc);
  if (!ready.ok) {
    dialog.showErrorBox('打开抖音画面失败', ready.error);
    return;
  }
  viewerPort = acc.port;
  viewerStarted = ready.started;
  let viewerBounds = {};
  try {
    const anchor = win && !win.isDestroyed() ? win.getBounds() : null;
    const display = anchor ? screen.getDisplayMatching(anchor) : screen.getPrimaryDisplay();
    viewerBounds = {
      x: Math.round(display.workArea.x + Math.max(40, (display.workArea.width - 1040) / 2)),
      y: Math.round(display.workArea.y + Math.max(40, (display.workArea.height - 920) / 2)),
    };
  } catch (e) {}
  viewerWin = new BrowserWindow({
    ...viewerBounds,
    width: 1040,
    height: 920,
    title: login ? `${TITLE} · 扫码登录` : `${TITLE} · 抖音画面`,
    backgroundColor: '#0f1115',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  viewerWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  viewerWin.on('closed', () => {
    viewerWin = null;
    if (viewerStarted && viewerPort) quitBrowserServer(viewerPort);
    viewerStarted = false;
    viewerPort = null;
    viewerChild = null;
  });
  await viewerWin.loadURL(`http://127.0.0.1:${port}/viewer${login ? '?mode=login' : ''}`);
  log(`viewer opened login=${login} browser-port=${acc.port} started=${ready.started}`);
}

function login() {
  return openViewer({ login: true });
}

function about() {
  dialog.showMessageBox({
    type: 'info',
    title: `关于 ${TITLE}`,
    message: `${TITLE} v${app.getVersion()}`,
    detail:
      `数据目录：${dataDir}\n` +
      `面板端口：${port}\n` +
      `日志：${logDir}\n` +
      `Electron ${process.versions.electron} / Node ${process.versions.node}`,
  });
}

async function boot() {
  if (!DEV) migrateLegacySettings();
  settings = readSettings();
  applyPaths();
  log(`electron=${process.versions.electron} node=${process.versions.node} dev=${DEV}`);
  log(`data=${dataDir} port=${port}`);

  if (!DEV && !process.env.DF_DATA_DIR && !settings.dataDir) {
    const proceed = await firstRunWizard();
    if (!proceed) return;
    applyPaths();
    log(`first-run data=${dataDir}`);
  }

  const free = await checkPortFree(port);
  if (!free) {
    dialog.showErrorBox(
      `${TITLE} 无法启动`,
      `面板端口 ${port} 已被占用。\n\n可能原因：\n· 旧版 launchd 实例还在运行（com.dsh.douyin-forwarder）\n· 另一个面板进程占用了该端口\n\n处理：先停掉旧实例，或设置环境变量 DF_PORT 换一个端口。\n日志：${path.join(logDir, 'app.log')}`
    );
    app.quit();
    return;
  }

  process.env.BROWSER_VISIBLE_POS = visiblePosition();
  host = new Host({
    dataDir,
    port,
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      DASH_PORT: String(port),
      BROWSER_VISIBLE_POS: process.env.BROWSER_VISIBLE_POS,
      ...(DEV ? { ACCOUNT_PORT: '9433' } : {}),
    },
    onLog: log,
  });
  await host.start();
  createWindow();
  createTray();
  if (process.env.DF_OPEN_VIEWER === '1') {
    openViewer().catch((e) => log(`openViewer failed: ${e.message}`));
  }
}

function fail(err) {
  log(`boot failed: ${(err && err.stack) || err}`);
  try {
    dialog.showErrorBox(`${TITLE} 启动失败`, `${(err && err.message) || err}\n\n日志：${path.join(logDir, 'app.log')}`);
  } catch (e) {}
  app.quit();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    log('second instance: focusing existing window');
    showWindow();
  });
  app.whenReady().then(boot).catch(fail);
}

app.on('activate', () => showWindow());

// keep running in the tray when the last window is hidden/closed
app.on('window-all-closed', () => {
  if (!tray) app.quit();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log(`${signal} received; quitting`);
    app.quit();
  });
}

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  if (trayTimer) clearInterval(trayTimer);
  log('quitting; stopping children');
  // Keep cleanup non-blocking: awaiting fetches or destroying windows inside before-quit can
  // stall the quit sequence. Fire the requests, then do the second app.quit() pass and let a
  // hard timer force the exit if anything is still holding the process.
  const done = () => {
    const portToQuit = viewerStarted && viewerPort ? viewerPort : null;
    const childToStop = viewerChild;
    log(`quit: cleaning up viewer/browser port=${portToQuit || '-'}`);
    if (portToQuit) quitBrowserServer(portToQuit);
    if (childToStop) {
      setTimeout(() => {
        try {
          childToStop.kill('SIGTERM');
        } catch (e) {}
      }, 1500);
    }
    if (tray) {
      try {
        tray.destroy();
      } catch (e) {}
      tray = null;
    }
    // Second pass: `quitting` is already true, so the handler above lets the quit proceed.
    // Calling app.exit() directly from a prevented before-quit can leave the process alive.
    log('quit: second app.quit()');
    app.quit();
    setTimeout(() => {
      log('quit: forced exit');
      app.exit(0);
    }, 2000);
  };
  Promise.resolve(host && host.stop()).then(
    () => {
      log('host stopped');
      done();
    },
    () => {
      log('host stop failed');
      done();
    }
  );
});
