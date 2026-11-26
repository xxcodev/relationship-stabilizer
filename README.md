# douyin-forwarder

把「定时从抖音挑视频 → 转发给好友」做成一个可移植、数据默认落在 SQLite（可选 MySQL/PostgreSQL）里的后台程序。

它不是一个网页爬虫,而是一个**受控的浏览器代理**:用 Playwright 驱动本机 Chrome,
按配置好的触发计划,挑选视频并发给指定好友。所有可调参数、计划、发送记录、
事件流水都在本机数据库里,并提供本地控制面板。

```
 ┌──────────────┐   排班   ┌───────────────┐   HTTP   ┌──────────────────┐
 │  scheduler   │ ───────▶ │ browser-server│ ───────▶ │ Chrome(登录态)  │
 │  (SQLite)    │ ◀─────── │  (Playwright) │ ◀─────── │  抖音网页版      │
 └──────┬───────┘  结果回写 └───────────────┘          └──────────────────┘
        │
 ┌──────▼───────┐
 │  dashboard   │  http://127.0.0.1:9400  只读统计 + 参数配置 + 立即发送
 └──────────────┘
```

## 特性

- **按账户独立配置**:触发计划、发送节奏、视频时效、屏蔽词、池延迟、发送模式、视频来源都按账户保存;新增 `account_settings` / `account_pools`
- **统一触发计划**:每行可选「固定时间」或在「时间范围」内随机触发,每行单独填条数;条数大于 1 时按 10–50 秒(可配)的随机间隔连续分享,间隔不短于上一条视频时长
- **筛选条件表格**:视频时效、点赞/评论/收藏/转发各一行,每行独立开关;关闭后不参与筛选,开启时可设门槛;纯 API 选片全量校验,浏览器回退只能校验点赞
- **选片来源可配**:视频池搜索(20 个池、随机搜索词),或抖音首页默认推荐(纯 HTTP,零浏览器,需要导出的 feed URL);默认只发最近 7 天发布的视频,30 天内发过的视频优先跳过
- **AI 旁路**:可选 AI 运维助手(只读问诊/日报上下文)、自然语言配置草案,以及推荐源的 AI 安全过滤/排序;默认关闭,失败自动回退规则
- **数据库可选**:默认 SQLite;面板可配置 MySQL / PostgreSQL(单机,重启生效)
- **精确投递**:按昵称 + `data-userid` 双重校验命中好友,不靠坐标猜
- **好友轮换**:优先发给当天成功次数最少的好友,先每人一轮再进入下一轮,避免连着发给同一个人
- **互关好友下拉发送**:快速发送改用互关好友下拉多选,支持搜索/全选/清空,按 userid 直接建会话
- **可观测**:控制面板、`events` 事件流水、发送截图、`npm run verify` 跨层冒烟
- **可运维**:暂停/继续/重启服务、失败重试一次后跳过、验证码检测后停手、每日自检
- **可移植**:`doctor` 环境自检、迁移系统、空目录一键初始化

## 快速开始

要求:Node.js ≥ 22.5(使用内置 `node:sqlite`,无原生依赖)、本机安装 Chrome。

```bash
git clone <this repo> && cd douyin-forwarder
npm install
cp .env.example .env      # 可选,默认值即可跑

npm run doctor            # 环境自检:Node / sqlite / 数据目录 / 浏览器 / 端口
npm run init              # 建库 + 灌入 20 个视频池 + 默认账号与时段
npm run verify            # 跨层冒烟(15 项,不碰调度和浏览器)
npm run dashboard         # http://127.0.0.1:9400
```

首次使用某个账号需要**扫码登录一次**。窗口默认在屏幕外,可以在面板的「🖥 浏览器画面」里
看到二维码并直接点击完成;也可以先把窗口移到台前再操作。,登录态留在该账号的
`profile_dir`(Playwright 的 user data dir),之后无需重复扫码。

启动调度:

```bash
npm run schedule          # 常驻,按数据库里的时段发送
node src/index.js api:export    # 导出纯 API 会话(短暂开一次最小化浏览器,不发送)
node src/index.js api:status    # 会话是否可用、是否捕获到推荐 feed
node src/index.js api:feed      # 只读验证推荐 feed(重放,不发送)
node src/index.js api:mode auto|browser [account]

```

## 目录结构

```
src/
  index.js           CLI 入口
  env.js             环境变量与路径解析
  db.js              SQLite / 可选 MySQL/PG 连接 + 迁移执行器
  db-config.js       数据库后端配置(data/database.json)
  db-worker.js       外部数据库 worker(同步门面)
  db-sql.js          SQL 方言小工具
  external-schema.js MySQL/PG 最终 schema
  repos.js           所有 SQL 集中于此
  ai/                AI 客户端 / 推荐源 ranker / 只读助手
  planner.js         纯函数排班(可单测)
  pools.js           视频池种子数据
  picker.js          选片(经 browser-server)
  browser-server.js  Playwright 控制服务
  scheduler.js       调度循环
  dashboard.js       控制面板 + HTTP API
  service.js         launchd / systemd 封装
  doctor.js          环境自检
  verify.js          跨层冒烟
  importer.js        旧数据导入
  backup.js          数据库快照
  page.html          面板前端(无构建链)
schema/              编号迁移(001、002、…)
test/                单元测试(node --test)
docs/                架构、部署、切换、事故记录
deploy/              launchd plist 模板
app/                 Electron 桌面壳(P0,见 docs/app.md)
scripts/             开发辅助脚本(如 app:dev 启动器)
```

## 配置

所有配置都可通过 `.env` 覆盖,也可在面板里编辑并写入数据库。

| 变量 | 默认 | 说明 |
|---|---|---|
| `DATA_DIR` | `data` | 数据库与浏览器配置的根目录 |
| `DB_FILE` | `data/app.db` | SQLite 文件位置 |
| `DASH_HOST` / `DASH_PORT` | `127.0.0.1` / `9400` | 面板监听地址 |
| `BROWSER_CHANNEL` | `chrome` | `chrome` 用系统安装的 Chrome,`chromium` 用 Playwright 自带 |
| `BROWSER_EXECUTABLE` | — | 显式指定浏览器可执行文件 |
| `BROWSER_HEADLESS` | `false` | 无头模式(注意:抖音对无头更敏感) |
| `BROWSER_POS` | `-20000,-20000` | 自动化窗口初始位置(默认屏幕外,不打扰) |
| `BROWSER_VISIBLE_POS` | `80,80` | 面板点「移到台前」时的位置 |
| `SHOTS_DIR` | `data/shots` | 发送截图目录 |
| `DB_DRIVER` / `DB_URL` / `DB_HOST` … | `sqlite` | 可选数据库后端;面板 `data/database.json` 优先,环境变量覆盖 |
| `AI_ENABLED` / `AI_BASE_URL` / `AI_MODEL` / `AI_API_KEY` | 关闭 | 可选 AI;面板 `data/ai.json` 优先,环境变量覆盖 |

## 数据模型

| 表 | 作用 |
|---|---|
| `accounts` | 发送账号:配置目录、端口、好友、启用状态 |
| `settings` | 全局默认值/应用级参数(账户级配置的回退) |
| `account_settings` | 每账户配置:触发计划、发送节奏、屏蔽词、视频来源、发送模式、AI 模式等 |
| `pools` | 视频来源目录:名称、搜索词、默认开关 |
| `account_pools` | 每账户的视频池启用状态 |
| `bands` | 历史时段配置(旧版本迁移用;新触发计划不再依赖它) |
| `plans` | 旧版每日时刻表(历史记录/迁移用;统一计划改用 `burstState`) |
| `sends` | 每次发送的结果(分类、来源、标题、作者、赞、toast、截图、视频 id) |
| `events` | 计划、重排、失败、验证码、人工操作等流水 |

## 命令

```bash
npm run init            # 初始化数据库与默认配置
npm run migrate -- DIR  # 从旧版 JSON/JSONL 导入(幂等;--force 才覆盖当日计划)
npm run status          # 当前账号 / 计划 / 今日已发
npm run plan            # 今天的计划(有则读库,无则现场生成)
npm run dashboard       # 启动面板
npm run schedule        # 启动调度(前台)
npm run doctor          # 环境自检
npm run verify          # 跨层冒烟
npm run backup          # 数据库快照到 data/backups/
npm test                # 单元测试
```

多账号:

```bash
node src/index.js account list
node src/index.js account add work --port 9335 --friend 某人
node src/index.js account enable|disable|remove work
node src/index.js account move-profile work --to data/profile-work
```

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/data` | 面板数据:今日计划/已发/时间线/历史 |
| GET | `/api/config` | 当前配置 |
| POST | `/api/config` | 保存配置 |
| GET | `/api/status` | 服务与浏览器状态(含验证页检测) |
| POST | `/api/control` | `pause` / `resume` / `restart` |
| POST | `/api/send-now` | 立即分享一次(后台任务) |
| GET | `/api/send-now` | 任务进度 |
| POST | `/api/preview` | 按当前参数试算一份计划,不落库 |
| POST | `/api/apply` | 保存配置并采用预览结果 |
| POST | `/api/today/regenerate` | 重置今日计划（兼容旧入口） |
| GET | `/api/accounts` | 账号列表 |
| GET | `/api/events` | 最近事件 |
| GET | `/api/ai/status` | AI 配置/本账户模式 |
| POST | `/api/ai/config` | 保存 AI 连接、账户级模式 |
| POST | `/api/ai/test` | 测试 AI 连接 |
| POST | `/api/ai/ask` | 只读运维问答 |
| POST | `/api/ai/config-draft` | 自然语言生成配置草案(需确认后保存) |
| GET | `/api/database` | 数据库后端/当前驱动/是否需重启 |
| POST | `/api/database` | 保存数据库连接配置(重启生效) |
| POST | `/api/database/test` | 测试数据库连接 |

## 测试

```bash
npm test        # 数据库 / 排班 / 导入 / 浏览器层(本地 fixture,不访问抖音)
npm run test:pg # PostgreSQL schema/repos 回归(pg-mem,无服务)
npm run test:mysql # 真实 MySQL 8 回归(会启动临时 mysqld,默认不在 npm test 里)
npm run test:pg:real # 真实 PostgreSQL 回归(自带二进制,默认不在 npm test 里)
npm run verify  # 环境 + 表结构 + HTTP 接口冒烟
```

`test/picker.test.js` 需要一个真实 Chrome;CI 里只跑其余三个文件(见 `.github/workflows/ci.yml`)。

## 部署

macOS(launchd)与 Linux(systemd --user)的示例配置见 `docs/daemon.md`;
从旧版脚本切换与回滚见 `docs/cutover.md`。

桌面应用「心动投递」(Electron):`npm install && npm run app:dev` 打开原生窗口加载现有面板(开发数据隔离在
`data-app/`);打包用 `npm run app:dist:mac`(macOS)或 `npm run app:dist:win`(Windows)。
安装、托盘、开机自启与数据目录说明见 `docs/app.md`。

## 已知限制

- 抖音网页端是前端渲染的,搜索结果可能延迟 15–40 秒才出现;程序用轮询等待,但仍受平台可用性影响。
- 自动化请求密度过高会触发人机验证或网关 502;程序会记录 `captcha-blocked` / 限流事件并停手,
  恢复需要人工在浏览器窗口完成验证。
- 同一账号被多个进程同时驱动会锁冲突;面板与调度会互相避让(端口/锁检测)。
- 平台若调整 DOM 结构,需要更新 `picker.js` 里的选择器,并跑 `test/picker.test.js`。

## 许可

本项目以 GPL-3.0 许可发布,详见 [LICENSE](LICENSE)。


## macOS 首次打开提示「已损坏」

这是 macOS Gatekeeper 对**未签名且从浏览器下载**的应用的拦截，不是文件真的损坏。
把应用拖进「应用程序」后，在终端执行一次：

```bash
xattr -dr com.apple.quarantine "/Applications/心动投递.app"
```

然后再双击打开即可（数据/登录态不受影响）。以后每个新版本替换后都需要执行一次；
如果希望彻底免掉这一步，需要 Apple Developer ID 签名 + 公证（付费账号）。
