# 桌面应用（Electron）

> 状态：P0/P1/P2 已完成 —— 可托盘常驻、开机自启、首次运行向导、扫码登录入口、macOS `.dmg` 打包；
> Windows 安装包由 GitHub Actions 的 `windows-latest` 构建（见 `.github/workflows/build.yml`）。

![P0:Electron 窗口加载现有控制面板](assets/app-p0.png)

应用显示名为「心动投递」（Heartbeat Delivery，`appId com.dsh.heartbeat-delivery`）。
托盘「抖音画面…」/「扫码登录…」会在应用内打开画面窗口，扫码与验证码都在这里完成：

![应用内抖音画面：扫码登录/验证码都在里面完成](assets/app-viewer.png)

## 两个版本

| 版本 | 产物 | 浏览器 | 适用 |
|---|---|---|---|
| 标准版 | `heartbeat-delivery-<ver>-arm64.dmg` | 系统安装的 Google Chrome | 自己用、已登录过 Chrome，最稳 |
| 自带浏览器版 | `heartbeat-delivery-bundled-<ver>-arm64.dmg` | 打包进应用的 Playwright Chromium（Chrome for Testing） | 不想/不能装 Chrome、要分发给别人 |

自带浏览器版说明：

- 体积大约多 200MB（dmg 约 330MB）；
- **需要重新扫码登录一次**：自带的 Chromium 使用独立的浏览器配置目录
  `<dataDir>/profile-*-chromium`，不会碰系统 Chrome 的登录态（两边的 Cookie 加密 key 不同）；
- 指纹是干净的 Chromium，风控表现需要实测；标准版仍然是默认推荐；
- 构建方式：`npm run browser:install` 下载内核（装到 `node_modules/playwright-core/.local-browsers`），
  然后 `npm run app:dist:mac:bundled`；CI 会同时产出两个版本。

## 安装（macOS）

1. 从 [GitHub Releases](https://github.com/xxcodev/relationship-stabilizer/releases) 下载
   `heartbeat-delivery-0.10.0-arm64.dmg`（标准版）或 `heartbeat-delivery-bundled-0.10.0-arm64.dmg`（自带浏览器版），把「心动投递」拖进「应用程序」；
2. 首次启动选数据目录：
   - **新建**：默认在 `~/Library/Application Support/抖音转发/data`；
   - **使用已有目录**：指向原来 `douyin-forwarder/data`，可复用数据库、截图和 Chrome 登录态（免重新扫码）；
3. 托盘菜单里可以：打开面板 / 抖音画面 / 暂停发送 / 重启调度 / 扫码登录 / 打开日志 / 打开数据目录 / 开机自启 / 退出。

**应用内完成抖音操作**：自动化 Chrome 启动后立即最小化（不是仅靠屏幕外坐标——macOS 在多屏下会把
完全出屏的窗口拉回显示器边缘、露出约 40px；最小化后实测 `kCGWindowIsOnscreen=false`，截帧照常渲染），
扫码登录、完成人机验证都在应用内的「抖音画面」窗口完成——画面通过 `/api/screen` 每 2.5 秒截帧，
点击图片会按坐标转发给真实浏览器（`/api/click`），需要时可以把窗口移到台前再挪回去（`/api/window`）。
托盘「扫码登录…」= 自动拉起浏览器 + 打开画面窗口；关闭画面窗口会关掉由它启动的浏览器进程。
「窗口移到台前」会恢复到**当前鼠标所在显示器**的左上角（多屏友好），「挪回屏幕外」= 重新最小化。

> 应用默认使用 9400 端口。**如果旧的 launchd 实例还在跑（`com.dsh.douyin-forwarder`），启动时会提示端口被占用**——
> 先 `launchctl bootout gui/$(id -u)/com.dsh.douyin-forwarder` 并停掉旧 dashboard，再启动应用。

未签名构建：本机自己构建、自己双击不会有隔离属性，可直接打开；若从别处拷贝 / 下载后提示“无法验证开发者”，
右键 →「打开」，或执行 `xattr -dr com.apple.quarantine "/Applications/心动投递.app"`。

## 开发运行

```bash
npm install          # 首次
npm run app:dev      # Electron 窗口 + 托盘,开发隔离数据目录 data-app/
```

| 项 | 开发（`app:dev`） | 打包后 |
|---|---|---|
| 面板端口 | `9420` | `9400` |
| 数据目录 | `<repo>/data-app/` | macOS `~/Library/Application Support/心动投递/data`，或首次向导选择的目录 |
| Chrome profile 端口 | `9433` | 沿用数据库里的账号端口（默认 `9333`） |

可用环境变量覆盖：`DF_PORT`、`DF_DATA_DIR`（两者在打包版也生效，便于多实例/测试）。

## 进程模型

```
Electron 主进程（app/main.js）—— 托盘、窗口、生命周期
  ├─ src/host.js：先跑一次 init（幂等），再拉起两个子进程并守护
  ├─ dashboard 子进程  → http://127.0.0.1:<port>（窗口加载的现有面板）
  └─ schedule 子进程   → 按 SQLite 排班驱动 browser-server
```

- 子进程用 Electron 自带的 Node 跑（`ELECTRON_RUN_AS_NODE=1` + `process.execPath`），
  不依赖系统 Node；Electron 45 内置 Node 24.22，`node:sqlite` 可用。
- 子进程崩溃后 2 秒自动重启；退出应用会先停子进程。
- 日志：`<dataDir>/logs/{app,dashboard,schedule,init}.log`。
- 控制标记：`<dataDir>/run/{host.pid,host.json}`；面板「重启服务」写入
  `restart-scheduler` 标志，由 host 轮询后重启 schedule 子进程（不依赖 launchd）。
- 关闭窗口 = 隐藏到托盘，服务继续按排班发送；托盘「退出」才真正停止。

## 打包

```bash
npm run app:pack        # 只出未打包目录 dist/mac-arm64/心动投递.app,便于快速验证
npm run app:dist:mac    # dmg + zip (arm64)
npm run app:dist:win    # Windows NSIS + zip（需在 Windows 上跑；本机构建 Windows 包需要 Wine）
```

产物在 `dist/`（已 gitignore）。GitHub Actions 在每次 push 到 `main` 时用
`macos-latest` / `windows-latest` 各跑一次，artifact 名 `dist-macOS`、`dist-Windows`。

## 注意：ELECTRON_RUN_AS_NODE

某些终端/IDE（包括本仓库的开发环境）会在环境里带 `ELECTRON_RUN_AS_NODE=1`。
若直接 `electron .`，Electron 会以纯 Node 身份启动并在 `require('electron')` 处崩溃。
`scripts/run-electron.js` 在启动前剥掉该变量，`npm run app:dev` 已走这个包装，无需手工处理。
打包后的应用从 Finder 双击启动，不受影响。

## 已修的相关缺陷

- `src/dashboard.js`：截图目录默认值原来指向项目外的 `../browser-test`，与 browser-server 的
  `data/shots` 不一致；现统一为 `data/shots`。
- `src/scheduler.js`：spawn `browser-server` 增加 `windowsHide: true`，Windows 下不弹黑框。
- `src/db.js`：连接加 5 秒 busy timeout，避免面板与调度并发写时偶发 `database is locked`。
- `src/service.js`：面板状态/重启优先走 host（`data/run/host.pid`），launchd/systemd 仅作回退。
- `src/host.js`：面板「重启服务」不再产生两个 schedule 子进程（主动重启抑制 + 去重）。

## 下一步（P3，可选）

- 发送成功/验证码系统通知；
- 自动更新（electron-updater + GitHub Releases）；
- Developer ID 签名 + 公证（分发给别人时需要）；
- universal（Intel + Apple Silicon）安装包。
