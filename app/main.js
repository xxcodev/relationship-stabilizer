/**
 * @file Electron shell: tray + window + background host lifecycle.
 *
 * - dev (`npm run app:dev`): port 9420, data in <repo>/data-app, no first-run wizard
 * - packaged: port 9400, data in the platform userData directory (or a user-picked data dir)
 *
 * The two long-lived processes stay in src/host.js, so CLI usage and the app share one model.
 */
const { app, BrowserWindow, Tray, Menu, dialog, shell, nativeImage } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { Host } = require('../src/host');

const DEV = !app.isPackaged;
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_PORT = DEV ? 9420 : 9400;
const TITLE = '抖音转发';

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
let quitting = false;

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
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
    process.env.DF_DATA_DIR || settings.dataDir || (DEV ? path.join(ROOT, 'data-app') : path.join(app.getPath('userData'), 'data'))
  );
  port = Number(process.env.DF_PORT || settings.port || DEFAULT_PORT);
  logDir = path.join(dataDir, 'logs');
  // main process helpers (login / tray state) share the same DB as the children
  process.env.DATA_DIR = dataDir;
  process.env.DB_FILE = path.join(dataDir, 'app.db');
  process.env.SHOTS_DIR = path.join(dataDir, 'shots');
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
  if (process.platform === 'darwin') tray.setTitle(DEV ? ' 抖音转发(dev)' : ' 抖音转发');
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

async function login() {
  const acc = account();
  if (!acc) {
    dialog.showErrorBox('没有账号', '请先在面板里初始化或导入数据目录。');
    return;
  }
  let child;
  try {
    child = spawn(
      process.execPath,
      [path.join(ROOT, 'src', 'browser-server.js'), '--profile', acc.profile_dir, '--port', String(acc.port)],
      {
        cwd: ROOT,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      }
    );
    child.unref();
  } catch (e) {
    dialog.showErrorBox('打开浏览器失败', e.message);
    return;
  }
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: '扫码登录',
    message: '请在打开的 Chrome 窗口里扫码登录',
    detail: '登录态会保存在数据目录，之后无需重复扫码。完成（或关闭浏览器）后点「完成」关闭浏览器窗口。',
    buttons: ['完成', '取消'],
    defaultId: 0,
    cancelId: 1,
  });
  try {
    await fetch(`http://127.0.0.1:${acc.port}/quit`, { method: 'POST', signal: AbortSignal.timeout(3000) });
  } catch (e) {}
  if (response !== 0) {
    setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch (e) {}
    }, 1000);
  }
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

  host = new Host({
    dataDir,
    port,
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      DASH_PORT: String(port),
      ...(DEV ? { ACCOUNT_PORT: '9433' } : {}),
    },
    onLog: log,
  });
  await host.start();
  createWindow();
  createTray();
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
  const done = () => app.exit(0);
  Promise.resolve(host && host.stop()).then(done, done);
});
