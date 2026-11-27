/**
 * @file Electron shell: tray + window + background host lifecycle.
 *
 * - dev (`npm run app:dev`): port 9420, data in <repo>/data-app, no first-run wizard
 * - packaged: port 9400, data in the platform userData directory (or a user-picked data dir)
 *
 * The two long-lived processes stay in src/host.js, so CLI usage and the app share one model.
 */
const { app, BrowserWindow, Tray, Menu, dialog, shell, nativeImage, screen, Notification, session } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { Host } = require('../src/host');
const sessionRefresh = require('../src/session-refresh');

const DEV = !app.isPackaged;
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_PORT = DEV ? 9420 : 9400;
const TITLE = '心动投递';
// older builds used this name; keep their settings.json when upgrading
const LEGACY_TITLES = ['抖音转发'];

// `scripts/build-app.js --variant bundled` writes app/variant.json into the package.
const VARIANT = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'variant.json'), 'utf8'));
  } catch (e) {
    return {};
  }
})();
const BUNDLED_BROWSER = VARIANT.browser === 'chromium';

// keep the bundled Chromium away from the system Chrome profile (separate cookies/keychain)
function browserProfileDir(base) {
  return BUNDLED_BROWSER ? `${base}-chromium` : base;
}
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
let apiExportChild = null;
let loginWin = null;
let appBridgeServer = null;
let appBridgeUrl = '';
const APP_BRIDGE_TOKEN = crypto.randomBytes(24).toString('hex');
const qrStates = new Map();
let lastApiRefreshAt = 0;
let lastApiRefreshFailed = false;
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
    const repos = require('../src/repos');
    const label = process.env.ACCOUNT || repos.getSetting('activeAccount', null);
    return repos.getAccount(label);
  } catch (e) {
    return null;
  }
}

function sendMode() {
  try {
    const repos = require('../src/repos');
    const acc = account();
    return acc ? repos.getAccountSetting(acc.id, 'sendMode', 'auto') : 'auto';
  } catch (e) {
    return 'browser';
  }
}

function setSendMode(mode) {
  try {
    const repos = require('../src/repos');
    const acc = account();
    if (!acc) return false;
    repos.setAccountSetting(acc.id, 'sendMode', mode);
    return true;
  } catch (e) {
    log(`setSendMode failed: ${e.message}`);
    return false;
  }
}

function apiAutoRefreshEnabled() {
  try {
    const value = require('../src/repos').getSetting('apiAutoRefresh', '1');
    return !(value === 0 || value === '0' || value === false);
  } catch (e) {
    return false;
  }
}

function setApiAutoRefresh(enabled) {
  try {
    require('../src/repos').setSetting('apiAutoRefresh', enabled ? '1' : '0');
    return true;
  } catch (e) {
    log(`setApiAutoRefresh failed: ${e.message}`);
    return false;
  }
}

function notify(body) {
  try {
    new Notification({ title: TITLE, body }).show();
  } catch (e) {
    log(`notification failed: ${e.message}`);
  }
}

function apiSessionInfo() {
  try {
    const apiSession = require('../src/api-session');
    const repos = require('../src/repos');
    const acc = account();
    const session = acc ? apiSession.load(acc.label) : null;
    return {
      file: acc ? apiSession.pathFor(acc.label) : apiSession.FILE,
      session,
      state: apiSession.status(session, null),
      friend: acc ? (repos.listEnabledFriendNames(acc.id)[0] || acc.friend) : '',
      accountName: session && session.accountName || (acc && (acc.display_name || acc.label)) || null,
    };
  } catch (e) {
    return { error: e.message };
  }
}

function showApiStatus() {
  const info = apiSessionInfo();
  if (info.error) {
    dialog.showErrorBox('纯 API 会话', info.error);
    return;
  }
  const s = info.session;
  const st = info.state;
  const lines = [
    `发送模式：${sendMode() === 'auto' ? '纯 API 优先（失败回退浏览器）' : '仅浏览器'}`,
    `会话文件：${info.file}`,
    s
      ? [
          `状态：${st.valid ? '可用' : '不可用（' + st.reason + '）'}`,
          `账号 / 当前好友：${info.accountName || s.accountName || s.account || '-'} / ${s.friend || '-'}`,
          `好友列表：${(s.friends || []).length} 个捕获好友`,
          `抓取时间：${new Date(s.createdAt).toLocaleString('zh-CN', { hour12: false })}（${st.ageHours}h 前）`,
          `模板 / cookies：${s.template ? s.template.bodyB64.length + ' base64 字符' : '无'} / ${(s.cookies || []).length} 条`,
        ].join('\n')
      : '还没有导出过会话。点「导出/刷新纯 API 会话…」，会短暂启动一个最小化浏览器（不会真的发送）。',
  ];
  dialog.showMessageBox({ type: 'info', title: '纯 API 会话', message: `纯 API 会话（${st.valid ? '可用' : '未就绪'}）`, detail: lines.join('\n\n') });
}

function runApiExport({ auto = false, accountLabel = null } = {}) {
  if (apiExportChild) return false;
  const label = accountLabel || (account() && account().label);
  log(`api export: start (${auto ? 'auto' : 'manual'}) account=${label || '-'}`);
  const args = [path.join(ROOT, 'src', 'index.js'), 'api:export'];
  if (label) args.push('--account', label);
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  apiExportChild = child;
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
    for (const line of String(chunk).split('\n').filter(Boolean)) log(`api export: ${line}`);
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
    for (const line of String(chunk).split('\n').filter(Boolean)) log(`api export err: ${line}`);
  });
  child.on('exit', (code) => {
    apiExportChild = null;
    lastApiRefreshAt = Date.now();
    lastApiRefreshFailed = code !== 0;
    log(`api export: exited ${code}`);
    refreshTrayMenu();
    const tail = output.trim().split('\n').slice(-12).join('\n');
    if (auto) {
      if (code === 0) notify('纯 API 会话已自动刷新');
      else notify('纯 API 会话自动刷新失败，可在托盘里手动导出');
      return;
    }
    if (code === 0) {
      dialog.showMessageBox({
        type: 'info',
        title: '纯 API 会话',
        message: '纯 API 会话已更新',
        detail: `${tail}\n\n之后发送会优先走 HTTP；失败会自动回退到浏览器。`,
      });
    } else {
      dialog.showErrorBox('导出纯 API 会话失败', `${tail || '没有输出'}\n\n完整日志见 data/logs/app.log`);
    }
  });
  return true;
}

async function exportApiSession() {
  if (sendMode() !== 'auto') setSendMode('auto');
  const ask = await dialog.showMessageBox({
    type: 'question',
    title: '导出纯 API 会话',
    message: '导出纯 API 会话？',
    detail:
      '会短暂启动一个最小化的 Chrome（不会弹出窗口），走一次「搜索 → 打开视频 → 分享面板 → 点好友」流程，' +
      '捕获发送请求后立即中断，不会真的发送消息。\n\n需要账号已登录、且当前没有正在运行的抖音画面。',
    buttons: ['开始导出', '取消'],
    defaultId: 0,
    cancelId: 1,
  });
  if (ask.response !== 0) return;
  runApiExport({ auto: false, accountLabel: account() && account().label });
}

// refresh per-account sessions before they expire (12h by default), one export at a time
async function maybeAutoRefreshSession() {
  if (apiExportChild) return;
  if (!apiAutoRefreshEnabled()) return;
  const repos = require('../src/repos');
  const apiSession = require('../src/api-session');
  const maxAge = apiSession.DEFAULT_MAX_AGE_HOURS;
  const before = Number(process.env.API_REFRESH_BEFORE_HOURS || 2);
  const cooldown = lastApiRefreshFailed ? 10 * 60 * 1000 : 30 * 60 * 1000;
  if (Date.now() - lastApiRefreshAt < cooldown) return;
  for (const acc of repos.listAccounts()) {
    const session = apiSession.load(acc.label);
    if (!session) continue;
    const state = apiSession.status(session, null);
    if (!sessionRefresh.needsRefresh(state, { maxAgeHours: maxAge, beforeHours: before })) continue;
    const age = state.ageHours == null ? 0 : state.ageHours;
    if (await sessionRefresh.isBrowserUp(acc.port)) {
      // The export closes the browser itself; this is just visibility in the log.
      log(`api auto refresh: browser up for ${acc.label}, export will close it`);
    }
    lastApiRefreshAt = Date.now();
    lastApiRefreshFailed = false;
    log(`api auto refresh: account=${acc.label} age=${age}h valid=${state.valid}`);
    if (runApiExport({ auto: true, accountLabel: acc.label })) {
      notify(`${acc.display_name || acc.label} 的纯 API 会话即将过期，正在自动刷新…`);
    }
    return;
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
  const isMac = process.platform === 'darwin';
  const iconPath = path.join(ROOT, 'app', 'assets', isMac ? 'trayTemplate.png' : 'tray-light.png');
  try {
    const img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) {
      // macOS template images are tinted by the system (no white plate, follows menu bar theme).
      if (isMac) img.setTemplateImage(true);
      return img;
    }
  } catch (e) {}
  // Fallback for a broken/missing asset: keep a usable icon rather than an empty tray.
  try {
    const img = nativeImage.createFromPath(path.join(ROOT, 'logo.png'));
    if (!img.isEmpty()) return img.resize({ width: 18, height: 18, quality: 'best' });
  } catch (e) {}
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
    {
      label: '纯 API（实验）',
      submenu: [
        {
          label: '纯 API 优先（当前账户）',
          type: 'checkbox',
          checked: sendMode() === 'auto',
          click: async (menuItem) => {
            setSendMode(menuItem.checked ? 'auto' : 'browser');
            await api('restart');
            refreshTrayMenu();
          },
        },
        {
          label: '自动刷新会话',
          type: 'checkbox',
          checked: apiAutoRefreshEnabled(),
          click: (menuItem) => {
            setApiAutoRefresh(menuItem.checked);
            refreshTrayMenu();
          },
        },
        item('导出/刷新纯 API 会话…', () => exportApiSession()),
        item('纯 API 会话状态…', () => showApiStatus()),
      ],
    },
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
  // Icon-only menu bar item: no text label next to the template icon.
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
      [path.join(ROOT, 'src', 'browser-server.js'), '--profile', browserProfileDir(acc.profile_dir), '--port', String(acc.port)],
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

function partitionFor(label) {
  const hash = crypto.createHash('sha1').update(String(label || 'default')).digest('hex').slice(0, 12);
  return `persist:dyf-${hash}`;
}

function formatElectronCookies(rawList = []) {
  return rawList
    .filter((c) => c && c.name && /douyin\.com$/i.test(String(c.domain || '').replace(/^\./, '')))
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      expires: typeof c.expirationDate === 'number' ? c.expirationDate : -1,
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      sameSite: c.sameSite || 'unspecified',
    }));
}

async function openInAppLogin({ label = null, name = '', friend = '', isNew = false } = {}) {
  const repos = require('../src/repos');
  const apiSession = require('../src/api-session');
  const apiExport = require('../src/api-export');
  const acc = label ? repos.getAccount(String(label)) : account();
  if (!acc) {
    throw new Error('没有找到目标账户');
  }
  const targetLabel = acc.label;
  if (loginWin && !loginWin.isDestroyed()) {
    try { loginWin.close(); } catch (e) {}
    loginWin = null;
  }

  const st = {
    status: 'waiting',
    startedAt: Date.now(),
    nickname: '',
    uid: '',
    hasCookies: false,
    hasFeed: false,
    hasSearch: false,
    error: '',
  };
  qrStates.set(targetLabel, st);

  const partition = partitionFor(targetLabel);
  const ses = session.fromPartition(partition);
  const ua = ses.getUserAgent().replace(/\s*Electron\/[^\s]+/g, '').replace(/\s*心动投递\/[^\s]+/g, '');
  ses.setUserAgent(ua);

  let bounds = {};
  try {
    const anchor = win && !win.isDestroyed() ? win.getBounds() : null;
    const display = anchor ? screen.getDisplayMatching(anchor) : screen.getPrimaryDisplay();
    bounds = {
      x: Math.round(display.workArea.x + Math.max(40, (display.workArea.width - 1100) / 2)),
      y: Math.round(display.workArea.y + Math.max(40, (display.workArea.height - 820) / 2)),
    };
  } catch (e) {}

  const lw = new BrowserWindow({
    ...bounds,
    width: 1100,
    height: 820,
    title: isNew ? `${TITLE} · 扫码添加账户` : `${TITLE} · 扫码登录（${acc.display_name || acc.label}）`,
    backgroundColor: '#161823',
    webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  loginWin = lw;
  lw.webContents.setUserAgent(ua);
  lw.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\/[^/]*douyin\.com/i.test(url)) lw.loadURL(url).catch(() => {});
    else shell.openExternal(url);
    return { action: 'deny' };
  });

  let capturedFeed = null;
  let capturedSearchUrl = null;
  let capturedSend = null;
  let capturedCreate = null;
  let finishing = false;
  let pollTimer = null;
  let loginModalClicked = false;
  const pendingPost = new Map();

  ses.webRequest.onBeforeRequest({ urls: ['https://*.douyin.com/*'] }, (details, callback) => {
    try {
      const url = String(details.url || '');
      let bodyB64 = null;
      if (Array.isArray(details.uploadData) && details.uploadData.length) {
        const chunks = details.uploadData.map((d) => (d && d.bytes ? Buffer.from(d.bytes) : Buffer.alloc(0)));
        const buf = Buffer.concat(chunks);
        if (buf.length) bodyB64 = buf.toString('base64');
      }
      if (apiExport.isFeedRequestUrl(url) || /general\/search\/single|imapi\.douyin\.com/.test(url)) {
        pendingPost.set(details.id, { url, method: details.method || 'GET', bodyB64 });
      }
      if (/general\/search\/single/.test(url)) capturedSearchUrl = url;
    } catch (e) {}
    callback({});
  });

  ses.webRequest.onBeforeSendHeaders({ urls: ['https://*.douyin.com/*'] }, (details, callback) => {
    try {
      const url = String(details.url || '');
      const meta = pendingPost.get(details.id);
      if (meta) pendingPost.delete(details.id);
      const headers = details.requestHeaders || {};
      const bodyB64 = meta ? meta.bodyB64 : null;
      if (apiExport.isFeedRequestUrl(url)) {
        const nextFeed = { url, method: details.method || 'GET', headers, bodyB64 };
        if (!capturedFeed || /\/aweme\/v1\/web\/tab\/feed\/?/.test(url)) capturedFeed = nextFeed;
      }
      if (/imapi\.douyin\.com\/v1\/message\/send/.test(url) && bodyB64) {
        capturedSend = { url, headers, bodyB64 };
      }
      if (/imapi\.douyin\.com\/v2\/conversation\/create/.test(url) && bodyB64) {
        capturedCreate = { url, headers, bodyB64 };
      }
    } catch (e) {}
    callback({ requestHeaders: details.requestHeaders });
  });

  lw.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (isMain && code !== -3) log(`in-app qr load failed (${code}): ${desc} url=${url}`);
  });
  lw.webContents.on('did-finish-load', () => {
    if (loginModalClicked || finishing || lw.isDestroyed()) return;
    setTimeout(() => {
      if (loginModalClicked || finishing || lw.isDestroyed()) return;
      lw.webContents.executeJavaScript(`(() => {
        const txt = document.body ? document.body.innerText : '';
        if (txt.includes('扫码登录') || txt.includes('抖音App扫码')) return 'open';
        const btn = [...document.querySelectorAll('button,a,div,span')].find((el) => {
          const t = (el.textContent || '').trim();
          const r = el.getBoundingClientRect();
          return (t === '登录' || t === '登录/注册') && r.width > 30 && r.width < 200 && r.height > 20 && r.height < 60 && r.y < 140;
        });
        if (btn) { btn.click(); return 'clicked'; }
        return 'none';
      })()`, true).then((res) => {
        if (res === 'open' || res === 'clicked') loginModalClicked = true;
      }).catch(() => {});
    }, 1800);
  });

  const checkLogin = async () => {
    if (finishing || lw.isDestroyed()) return;
    try {
      const currentUrl = lw.webContents.getURL();
      if (!/^https:\/\/(?:www\.)?douyin\.com/i.test(currentUrl)) return;
      const cookies = formatElectronCookies(await ses.cookies.get({}));
      const hasAuthCookie = cookies.some((c) => /^(sessionid|sessionid_ss|uid_tt|sid_tt)$/.test(c.name) && c.value);
      if (!hasAuthCookie) return;
      const prof = await lw.webContents.executeJavaScript(
        `fetch('/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383&channel=channel_pc_web&publish_video_strategy_type=2&source=channel_pc_web',{credentials:'include'}).then(r=>r.json()).catch(()=>null)`,
        true
      );
      if (!prof || prof.status_code !== 0 || !prof.user || !prof.user.nickname) return;

      finishing = true;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      st.status = 'capturing';
      st.nickname = String(prof.user.nickname || '').trim();
      st.uid = String(prof.user.uid || '');

      const freshAcc = repos.getAccount(targetLabel) || acc;
      const autoName = !freshAcc.display_name || /^新账户/.test(freshAcc.display_name) || freshAcc.display_name === freshAcc.label;
      if (autoName && st.nickname) {
        repos.updateAccountDisplayName(freshAcc.id, st.nickname);
        repos.logEvent('account-detected', { label: freshAcc.label, nickname: st.nickname, uid: st.uid, source: 'in-app-qr' });
      }

      // Reload recommend + search with authenticated cookies so feedUrl & searchUrl carry login state.
      capturedFeed = null;
      capturedSearchUrl = null;
      if (!lw.isDestroyed()) await lw.loadURL('https://www.douyin.com/?recommend=1').catch(() => {});
      for (let i = 0; i < 8 && !capturedFeed && !lw.isDestroyed(); i++) await sleep(500);
      if (!capturedSearchUrl && !lw.isDestroyed()) {
        await lw.loadURL(`https://www.douyin.com/search/${encodeURIComponent('搞笑')}`).catch(() => {});
        for (let i = 0; i < 10 && !capturedSearchUrl && !lw.isDestroyed(); i++) await sleep(500);
      }

      const finalCookies = formatElectronCookies(await ses.cookies.get({}));
      const prev = apiSession.load(freshAcc.label) || {};
      const feedHeaders = capturedFeed ? apiExport.pickFeedHeaders(capturedFeed.headers) : (prev.feedHeaders || {});
      const nextSession = {
        ...prev,
        version: 4,
        createdAt: new Date().toISOString(),
        account: freshAcc.label,
        accountName: st.nickname || freshAcc.display_name || freshAcc.label,
        friend: friend || prev.friend || freshAcc.friend || '',
        searchUrl: capturedSearchUrl || prev.searchUrl || null,
        feedUrl: (capturedFeed && capturedFeed.url) || prev.feedUrl || null,
        feedHeaders,
        feedMethod: (capturedFeed && capturedFeed.method) || prev.feedMethod || 'GET',
        feedBodyB64: (capturedFeed && capturedFeed.bodyB64) || prev.feedBodyB64 || null,
        template: (capturedSend && capturedSend.bodyB64 ? capturedSend : prev.template) || null,
        createTemplate: (capturedCreate && capturedCreate.bodyB64 ? capturedCreate : prev.createTemplate) || null,
        friends: Array.isArray(prev.friends) ? prev.friends : [],
        cookies: finalCookies,
      };
      apiSession.save(nextSession, freshAcc.label);

      st.hasCookies = finalCookies.length > 0;
      st.hasFeed = !!nextSession.feedUrl;
      st.hasSearch = !!nextSession.searchUrl;
      st.status = 'done';
      log(`in-app qr login ok label=${freshAcc.label} nickname=${st.nickname} cookies=${finalCookies.length} feed=${st.hasFeed} search=${st.hasSearch}`);
      refreshTrayMenu();
      notify(`「${st.nickname || freshAcc.label}」扫码登录成功`);
      if (!lw.isDestroyed()) lw.close();
    } catch (e) {
      log(`in-app login check err: ${e.message}`);
      finishing = false;
    }
  };

  lw.on('closed', () => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    try { ses.webRequest.onBeforeRequest(null); } catch (e) {}
    try { ses.webRequest.onBeforeSendHeaders(null); } catch (e) {}
    if (loginWin === lw) loginWin = null;
    if (st.status === 'waiting') st.status = 'closed';
  });

  pollTimer = setInterval(checkLogin, 2000);
  // Start loading asynchronously so /qr-login returns immediately without hitting HTTP timeout.
  lw.loadURL('https://www.douyin.com/').catch((e) => {
    if (!/ERR_ABORTED/i.test(String(e && e.message))) log(`in-app qr load err: ${e && e.message}`);
  });
  log(`in-app qr login opened label=${targetLabel} isNew=${isNew}`);
  return st;
}

function login() {
  const acc = account();
  if (!acc) {
    dialog.showErrorBox('没有账号', '请先在面板里创建或导入数据目录。');
    return;
  }
  return openInAppLogin({ label: acc.label, name: acc.display_name || acc.label, isNew: false }).catch((e) => {
    dialog.showErrorBox('打开扫码登录失败', e.message);
  });
}

function startAppBridge() {
  if (appBridgeServer) return Promise.resolve(appBridgeUrl);
  appBridgeServer = http.createServer(async (req, res) => {
    const sendJson = (code, data) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.headers['x-bridge-token'] !== APP_BRIDGE_TOKEN) {
      return sendJson(403, { ok: false, error: 'forbidden' });
    }
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname === '/qr-login' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const input = JSON.parse(body || '{}');
        await openInAppLogin({
          label: input.label,
          name: input.name,
          friend: input.friend,
          isNew: input.isNew !== false,
        });
        return sendJson(200, { ok: true, label: input.label, status: 'waiting' });
      }
      if (u.pathname === '/qr-status' && req.method === 'GET') {
        const label = String(u.searchParams.get('label') || '').trim();
        const st = qrStates.get(label) || { status: 'waiting', nickname: '', uid: '', hasCookies: false, hasFeed: false, hasSearch: false, error: '' };
        return sendJson(200, { ok: true, label, ...st });
      }
      if (u.pathname === '/clear-partition' && req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const input = JSON.parse(body || '{}');
        if (input.label) {
          qrStates.delete(String(input.label));
          const ses = session.fromPartition(partitionFor(String(input.label)));
          await ses.clearStorageData().catch(() => {});
        }
        return sendJson(200, { ok: true });
      }
      return sendJson(404, { ok: false, error: 'not found' });
    } catch (e) {
      return sendJson(500, { ok: false, error: e.message });
    }
  });
  return new Promise((resolve, reject) => {
    appBridgeServer.once('error', reject);
    appBridgeServer.listen(0, '127.0.0.1', () => {
      const actual = appBridgeServer.address().port;
      appBridgeUrl = `http://127.0.0.1:${actual}`;
      log(`app bridge listening on ${appBridgeUrl}`);
      resolve(appBridgeUrl);
    });
  });
}

function about() {
  dialog.showMessageBox({
    type: 'info',
    title: `关于 ${TITLE}`,
    message: `${TITLE} v${app.getVersion()}`,
    detail:
      `数据目录：${dataDir}\n` +
      `面板端口：${port}\n` +
      `浏览器：${BUNDLED_BROWSER ? '自带 Chromium(独立登录态)' : '系统 Google Chrome'}\n` +
      `发送模式：${sendMode() === 'auto' ? '纯 API 优先（失败回退浏览器）' : '仅浏览器'}\n` +
      `自动刷新会话：${apiAutoRefreshEnabled() ? '开' : '关'}\n` +
      `日志：${logDir}\n` +
      `Electron ${process.versions.electron} / Node ${process.versions.node}`,
  });
}

async function boot() {
  if (!DEV) migrateLegacySettings();
  settings = readSettings();
  applyPaths();
  log(`electron=${process.versions.electron} node=${process.versions.node} dev=${DEV}`);
  log(`data=${dataDir} port=${port} browser=${BUNDLED_BROWSER ? 'bundled-chromium' : 'system-chrome'}`);
  if (BUNDLED_BROWSER) {
    process.env.BROWSER_CHANNEL = 'chromium';
    process.env.PLAYWRIGHT_BROWSERS_PATH = app.isPackaged
      ? path.join(process.resourcesPath, 'playwright-browsers')
      : path.join(ROOT, 'node_modules', 'playwright-core', '.local-browsers');
    log(`bundled chromium: ${process.env.PLAYWRIGHT_BROWSERS_PATH}`);
  }

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
  const bridgeUrl = await startAppBridge();
  host = new Host({
    dataDir,
    port,
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      DASH_PORT: String(port),
      BROWSER_VISIBLE_POS: process.env.BROWSER_VISIBLE_POS,
      DF_APP_BRIDGE_URL: bridgeUrl,
      DF_APP_BRIDGE_TOKEN: APP_BRIDGE_TOKEN,
      ...(DEV ? { ACCOUNT_PORT: '9433' } : {}),
    },
    onLog: log,
  });
  await host.start();
  createWindow();
  createTray();
  const autoRefresh = () => maybeAutoRefreshSession().catch((e) => log(`api auto refresh error: ${e.message}`));
  setTimeout(autoRefresh, 60 * 1000);
  setInterval(autoRefresh, 5 * 60 * 1000);
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
    if (loginWin && !loginWin.isDestroyed()) {
      try { loginWin.destroy(); } catch (e) {}
      loginWin = null;
    }
    if (appBridgeServer) {
      try { appBridgeServer.close(); } catch (e) {}
      appBridgeServer = null;
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
