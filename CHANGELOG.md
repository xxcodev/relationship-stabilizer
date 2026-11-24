# Changelog

## 0.17.0 — 2026-11-24

- **扫码添加账户**:账户页新增「扫码添加账户」——自动创建账户、分配端口/profile、打开浏览器窗口，
  手机扫码登录后自动读取抖音昵称并更新账户显示名（可留空名称）；账户默认暂停，添加好友后点继续。
- 新增 `POST /api/accounts/add-qr` 与 `POST /api/accounts/detect-name`；账户页可手动「识别抖音昵称」。
- 修复非 ASCII 账户名的 profile 目录可能重名的问题（slug + hash）。
- 扫码流程会同时把浏览器窗口移到前台并打开面板实时画面，方便直接扫码。


## 0.16.0 — 2026-11-24

- **白天 / 黑夜模式**:侧栏底部新增主题切换按钮（当前模式显示「白天模式 / 黑夜模式」），
  选择保存在 localStorage，重启应用后保留；首次打开跟随系统外观。
- 新增完整浅色主题：背景、侧栏、顶栏、卡片、输入框、按钮、标签、表格、弹窗、Toast 等
  全部适配；图标/圆点/进度条/表格 hover 在浅色下重新调色。
- 移动端保留主题切换入口。
- 支持 `color-scheme`，原生复选框/下拉框/滚动条跟随主题。


## 0.15.0 — 2026-11-24

- 顶部状态/操作区统一：状态标签与按钮同高（38px）、同圆角（10px）、同字号内边距；
  「暂停 / 继续 / 重启服务」统一为深色描边按钮，「立即发送一次」为蓝色主按钮；状态带圆点。
- UI 整体视觉统一与动效：
  - 全局背景光晕；卡片 hover 浮起/描边高亮；主按钮阴影与按压反馈；
  - 侧栏激活项左侧光条、hover 位移；页面切换淡入位移；顶部栏吸顶毛玻璃；
  - 进度条流光、运行状态圆点呼吸、标签/好友多选 hover、表格行高亮、toast 毛玻璃；
  - 统一输入框 focus 光环、滚动条样式，并支持 `prefers-reduced-motion`。
- 其他按钮（继续）改为绿色柔和描边，保持和深色系一致。


## 0.14.2 — 2026-11-24

- 统一顶部操作区控件风格：高度 38px、圆角 10px、同一字号/内边距；
  「暂停 / 继续 / 重启服务」统一深色描边按钮，「立即发送一次」保留蓝色主按钮；
  状态标签与按钮同高同圆角，并带状态色圆点（运行中/已暂停/未运行）。


## 0.14.1 — 2026-11-24

- 首页「快速发送」直接列出**会话捕获的全部好友**（不再要求先加入账户好友列表），复选框多选，
  支持「全选可发送 / 清空」；选中数量实时显示。
- 不在会话捕获列表里的账户好友会以「未捕获」灰显，提示重新导出会话；配置页好友也标注
  「纯 API 可用 / 未捕获」。
- 修复：之前多选好友只能看到账户好友列表里的少数人，导致「怎么选多个好友」不直观。


## 0.14.0 — 2026-11-24

- **账户显示名称**: accounts 新增 display_name；导出会话时自动从 self userid 识别登录账户昵称
  （本次识别为「拍拍」），面板/托盘不再以内部 label B 展示。账户页可手动改名。
- **多账户同时排班**: host 为每个账户各起一个 scheduler 子进程；所有账户按各自时段、计划、
  浏览器 profile 独立同时发送。面板「切到面板」只切换查看数据，不停止其他账户。
- **每账户好友列表**: 新增 friends 表（旧 accounts.friend 自动迁移）。排班时从启用的好友里随机轮换；
  支持自动轮换 + 手动多选发送；配置页可添加/启用/删除好友。
- **多好友手动发送**: `POST /api/api-session/send` 支持 `friends: []`，同一视频依次发给所选好友；
  首页快速发送改为多选好友。
- **纯 API 会话按账户独立**: 会话保存在 `data/api-sessions/<account>.json`，旧的
  `data/api-session.json` 自动迁移；自动刷新按账户分别检查。
- **账户管理 UI**: 账户页可添加账户（默认暂停等待扫码）、改名、暂停/继续、切换面板；
  CLI 新增 `account rename`，`account add/switch` 适配。
- 修复账户切换/暂停会重启所有调度的问题；调度子进程会按账户自行读取最新状态。
- 版本 0.14.0。


## 0.13.0 — 2026-11-24

- **控制台重构为四页**:
  - 首页:今日进度/纯 API/浏览器三块状态、成功率/今日失败/最常分类/累计、时刻表、分类分布、
    快速发送(选好友/试选片/发送)、最近发送、最近事件、实时画面弹层。
  - 账户:当前账户详情(好友/端口/时段/累计/profile)、全部账户列表与切换、添加账户说明。
  - 配置:发送计划(好友/间隔/总条数/时段/视频池/屏蔽词/预览/安全模式)+ 纯 API 会话
    (模式切换/自动刷新/好友列表/导出会话)+ 维护工具 + 事件。
  - 记录:筛选(搜索/分类/结果)、成功与失败统计、分页表格、CSV 导出、事件日志。
- **账户切换**:新增 `activeAccount` 设置、`POST /api/accounts/switch`、CLI `account switch <label>`;
  切换会自动重启调度,面板/调度器/应用托盘都会跟随当前账户。
- 记录表格补充“好友”列;修复纯 API 卡片好友数/自动刷新开关等显示细节。
- 构建产物版本 0.13.0。


## 0.12.1 — 2026-11-24

- 面板「⚡ 纯 API 发送」新增**好友选择器**：展示导出时捕获的好友列表，可选择任意好友
  「只试选片」或「发送给所选好友」；新增 `POST /api/api-session/send {friend, dry}`，
  通过纯 API 建会话并发送（成功写入 sends，toast 为 HTTP API (panel)）。
- `GET /api/api-session` 返回完整好友列表（`friends: [{name, userid}]`）与 `friendCount`。
- 已用「拍拍」实测：纯 API 建会话 + 发送成功（服务端返回 message id）。


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
