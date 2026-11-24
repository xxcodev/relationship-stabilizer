# Changelog

## 0.12.0 — 2026-11-24

- **任意好友**:会话导出时额外捕获 `conversation/create` 模板与分享面板最近好友列表；
  发送给非默认好友时先调 `/v2/conversation/create` 建会话，再复用同一发送模板，
  **不需要重新导出模板**。CLI：`api:send --friend <名字>`、`api:friends`。
  限制：名字需在导出时捕获的最近好友列表里（可在导出前先和对方聊一下）。
- **会话自动刷新**:应用每 5 分钟检查一次；距过期不足 2 小时（`API_REFRESH_BEFORE_HOURS`）时
  自动在后台导出新会话（最小化浏览器、不发送消息），有通知；浏览器忙/导出中会跳过，
  失败后 30 分钟内不重试。托盘和面板都可开关自动刷新。
- **面板显示纯 API 状态**:面板新增「⚡ 纯 API 发送」区块：会话是否可用/年龄/有效期/好友数/模板、
  当前发送模式，以及「导出/刷新会话」「切换自动刷新」「纯 API 优先 / 仅浏览器」按钮。
- 会话格式升到 v2（含 createTemplate/friends），旧 v1 会话仍可用于默认好友发送；
  建议重新导出一次以获得任意好友与自动刷新能力。


## 0.11.1 — 2026-11-24

- 面板「立即分享一次」不再无条件先启动浏览器：交给 `sendOne` 按模式决定（纯 API 模式完全不启动浏览器，
  需要回退时自动启停）。
- 发布前修复：CI 构建显式 `--publish never`（无 GH_TOKEN 时不再尝试发布，0.11.0 的 CI Windows 构建因此失败过）。


## 0.11.0 — 2026-11-24

- **纯 API 发送模式（实验）**：发送不再必须启动浏览器。
  - `api:export`：短暂启动一个最小化浏览器，走一次分享流程并**中断发送**，只导出
    cookies + 一条 protobuf 发送模板（默认 12 小时有效，`API_SESSION_MAX_HOURS` 可调）。
  - `api-sender`：带 cookies 直接调用只读搜索接口选片，再用模板构造
    `POST imapi.douyin.com/v1/message/send` 发送视频卡片；整条链路没有浏览器进程。
  - 调度器 `sendMode`：`auto`（默认，API 优先、失败自动回退浏览器）/ `browser`（旧行为）；
    回退与失败都会写 events（`api-session-invalid` / `api-send-rejected` / `api-send-error`）。
  - CLI：`api:export` / `api:status` / `api:send` / `api:mode auto|browser` / `api:clear`；
    托盘菜单新增「纯 API（实验）」子菜单（优先级开关、导出会话、会话状态）。
  - 安全：会话文件 `data/api-session.json` 含 cookies/ticket，0600 权限、位于 gitignore 的 data/ 下。
- 修复 `send-once` 在纯 API 模式下也会先启动浏览器的问题（现在由 sendOne 按需启动）。
- 文档：`docs/api-mode.md`；`docs/api-poc.md` 记录验证过程与限制。


## 0.10.0 — 2026-11-24

- **自带浏览器版**:`npm run browser:install` 把 Playwright 的 Chromium(Chrome for Testing)
  装进 `node_modules/playwright-core/.local-browsers`,打包时复制到
  `Contents/Resources/playwright-browsers`;应用通过 `BROWSER_CHANNEL=chromium` +
  `PLAYWRIGHT_BROWSERS_PATH` 使用它,不再依赖系统 Chrome。
- 自带浏览器版使用独立配置目录 `<dataDir>/profile-*-chromium`(不碰系统 Chrome 的登录态,
  首次需要在应用内画面里重新扫码);标准版行为不变。
- `scripts/build-app.js`:一个构建入口,`--variant standard|bundled` 产出
  `heartbeat-delivery-*` / `heartbeat-delivery-bundled-*` 两种 dmg;CI 同时构建两个版本。
- `doctor` 会检查内置 Chromium 目录;「关于」里显示当前使用的浏览器。


## 0.9.1 — 2026-11-24

- **多屏隐藏更彻底**:隐藏模式从「把窗口挪到 -20000,-20000」改为**启动即最小化**。
  实测 macOS 会把完全出屏的窗口拉回显示器边缘(多屏时露出约 40px),最小化后
  `kCGWindowIsOnscreen=false`,但截图/点击照常工作(Playwright 默认禁用后台节流)。
- 「窗口移到台前」先在最小化状态下恢复,再设置坐标(单次 CDP 调用会被忽略);恢复后会落在
  **当前鼠标所在显示器**的左上角,不再固定主屏 80,80。
- 应用内「抖音画面」窗口在**主窗口所在显示器**居中打开(多屏不再跑到主屏)。
- 启动时先最小化再导航,减少首屏加载期间多屏露出的可能。


## 0.9.0 — 2026-11-24

- **隐藏窗口模式**:自动化的 Chrome 默认启动在屏幕外(`--window-position=-20000,-20000`),
  不再弹窗打扰;需要扫码或过验证时用面板把窗口移到台前。
- **面板内嵌浏览器画面**:`/api/screen` 实时截图 + `/api/click` 坐标点击 + `/api/window` 显示/隐藏。
  扫码、完成「点击两个形状相同的物体」都可以直接在面板里操作,不需要切到 Chrome 窗口。
- `browser-server` 新增 `/screen` 与 `/window`(通过 CDP `Browser.setWindowBounds` 移动窗口)。
- **应用内抖音画面窗口**:Electron 托盘/菜单新增「抖音画面…」;扫码登录改为在应用内画面中完成,
  不再提示去 Chrome 窗口;发送时 Chrome 保持屏幕外,只有登录/验证码需要人看画面。
- **改名**:应用显示名从「抖音转发」改为「心动投递」(Heartbeat Delivery,`appId com.dsh.heartbeat-delivery`),
  旧版 `settings.json` 会自动迁移;npm 包名与仓库名保持不变。


## 0.8.0 — 2026-11-24

- **自包含**:浏览器配置目录从 `browser-test/profile-B` 迁到 `douyin-forwarder/data/profile-B`,
  数据库里的 `profile_dir` 同步更新。迁移后实测 `loggedIn=true`、无验证页。
  整个程序现在只依赖自己目录内的 `data/`。
- 修复 `account move-profile` 未传 `--to` 时把子命令名当成路径的问题(会落到 `./move-profile`)。
- 面板 `ACCOUNT=<label>` 环境变量可指定展示/操作的账号(多账号时用)。
- 清理:删除临时测试账号与 572MB 的 profile 副本,关闭测试用面板实例。


## 0.7.0 — 2026-11-24

- `docs/architecture.md`:分层与依赖方向、browser-server 的 HTTP 契约、扩展点、失败模型、测试策略。
- `GET /api/accounts`:账号列表(端口/好友/时段数/累计发送/配置目录),面板头部显示当前账号概要。
- `account move-profile`:安全搬移浏览器配置目录,带锁检测(端口在监听或存在 `SingletonLock` 直接拒绝)。
- 实测:`move-profile` 正常搬移并在数据库更新路径;锁定时正确拒绝且不动文件。


## 0.6.0 — 2026-11-24

- **浏览器层测试**:新增 `test/picker.test.js`,用本地 fixture 页面验证卡片提取与标题定位,
  不访问抖音。5 个用例覆盖 `EXTRACT` / `parse` / `OPEN_STEP` 命中与未命中。
- **导入保护**:重复导入不再覆盖「今天正在执行的计划」(除非 `--force`),避免像之前那样
  把已发/失败状态和时间表一起冲掉。`migrate` 新增 `--force`。
- `picker.js` 导出 `EXTRACT` / `OPEN_STEP` / `parse` 以便测试。
- 测试总数 25。


## 0.5.0 — 2026-11-24

- **导航节流**:每个池子扫描后随机停顿(默认 2500ms + 0–2000ms 抖动),对应人机验证的根因——
  连续页面加载。可在面板「池间延迟」调整(0–30000ms)。
- 面板新增「最近事件」折叠区,直接读 `events` 表,排障不用再开终端。
- `GET /api/events?limit=N` 接口。
- `settings.poolDelayMs` 进入配置往返。
- 多账号 CLI:`account list / add / enable / disable / remove`,每账号独立 profile + 端口。
- 事件去重:迁移 `003` 给 `events(ts,event,payload)` 建唯一索引;旧数据导入保留原始时间戳,
  重复导入不再产生重复行(修掉了面板里同一事件重复三四次的问题)。
- 修复:重复导入旧数据会把 `accounts.enabled` 重置成旧 `config.json` 的值,等于偷偷把暂停开关打开了。
  现在 `enabled` 只在新账号创建时初始化,导入不再覆盖。


## 0.4.0 — 2026-11-24

- `npm run verify`:15 项冒烟检查(环境/表结构/账号/时段/池子/排班/4 个 HTTP 接口),
  面板用临时端口启动,不影响正在跑的服务。当前 14/14 通过。
- `npm run backup`:`VACUUM INTO` 导出一致性快照到 `data/backups/`,并回读校验表数与发送数。
- 面板新增「安全模式」:一键把每天条数改成 6–8、间隔 ≥15 分钟,用于风控收紧时降载。
- `dashboard.startServer` 支持 `port: 0`,方便测试时随机端口启动。


## 0.3.0 — 2026-11-24

- 面板新增控制条:**暂停 / 继续 / 重启服务**,直接改 `accounts.enabled` 并重启 launchd 服务。
- 面板新增服务状态:`/api/status` 返回调度进程状态 + 浏览器窗口状态(是否停在验证页)。
- 人机验证:`/state` 增加 `challenge` 字段,`sendOne` 检测到验证页直接返回 `captcha` 错误,
  记录 `captcha-blocked` 并停手,不再盲重试。
- 时刻表支持三种状态:已发(绿)、失败(红)、待发(灰)。
- `src/service.js`:launchd / systemd 的查询与重启封装,非 macOS/Linux 降级为提示。
- 修复 `/api/control` 请求体解析(`for of` → `for await`)。
- 文档:README 增加控制说明,`docs/incidents.md` 记录人机验证事件。


## 0.2.0 — 2026-11-24

**切换上线**:launchd 任务从旧脚本(`com.dsh.douyin-forward`)切到新程序
(`com.dsh.douyin-forwarder` → `src/index.js schedule`),旧 plist 保留可回滚。

新增/变更:

- `failed_json`:每个时刻记录失败状态,失败后不再无限重试(迁移 `002`)。
- 唤醒策略:机器睡过晨间时段后不再整日跳过,而是从当前时刻开始排剩余时段;
  只有距窗口结束不足 45 分钟才放弃当天。
- 补发保护:唤醒后发现某时刻已过去 25 分钟以上,记为 `slot-missed` 跳过,避免连发。
- `npm run doctor`:Node / node:sqlite / 数据目录 / playwright / 浏览器 / 端口 / 账号 七项自检。
- 选片池 20 个,每次随机扫描其中 6 个(可在面板逐项开关)。
- 文档:`docs/cutover.md`、`docs/incidents.md`、`docs/daemon.md`。

## 0.1.0 — 2026-11-23

- 从 `browser-test/` 的单机脚本抽成独立程序:SQLite 存储、迁移系统、repos 层、
  纯函数排班、CLI、DB 驱动的面板、旧数据导入器、17 个单测。
- 端到端 `send-once --dry` 在真实账号上跑通(选片 → 打开 → 分享面板 → 精确命中好友)。
