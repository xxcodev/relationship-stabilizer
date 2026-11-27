> **历史文档说明**：本文是 0.21–0.29 阶段的需求分析。0.32.6 已移除首页「快速发送」，好友管理移到首页；文中相关段落仅作历史记录。

# 需求分析：账户级配置、MySQL/PostgreSQL 支持、抖音默认推荐视频源

> 基线版本：**v0.24.2**（2026-11-25）
> 范围：只做需求拆解、现状核对、方案与风险评估，**不含实现**。
> 相关文档：[架构说明](architecture.md)、[优化计划](optimization-plan.md)、[纯 API 模式](api-mode.md)、[飞牛交接](handoff-fnos.md)。

## 0. 结论摘要

| 需求 | 结论 | 规模 | 建议 |
|---|---|---|---|
| 1. 每账户配置独立 + 简化配置 | **必要且可行**。当前只有时段/好友/开关/会话按账户隔离，间隔、条数、屏蔽词、视频池、发送模式都是全局的，多账户会互相影响 | M（约 3.5–5 天） | **先做**。`account_settings` + `account_pools`；基础区只留「每天 N 条 + 时段」，后台随机分配 |
| 2. 支持 MySQL / PostgreSQL | **技术上可行，但代价远大于字面**。现有数据层是同步 `node:sqlite`，换成 pg/mysql2 要把 repos 和所有调用方异步化，并维护三套 schema / 迁移 / 测试 | L（约 10–15 天，PG 先行约 7–10 天） | **SQLite 保持默认**；按你提供的连接信息做可选后端。若只是远程查看/备份/报表，优先做单向同步 |
| 3. 直接用抖音默认推荐 | **浏览器路径可行**；**纯 HTTP 路径有签名墙**。你要求「都走 API」：发送没问题，feed 选片需要先 POC 签名/重放，或采用「浏览器取数 + API 发送」 | 浏览器源 M（约 2–3 天）；API 取数 +1–2 天；纯 API 重放 POC 0.5 天 | **先做 feed POC**；推荐源默认关闭；API 选片优先「浏览器取数（A）」，纯 HTTP 重放（B）看 POC 结果 |

一句话：**需求 1 是地基，应该先做；需求 3 的推荐源可以做，但「选片也完全无浏览器」需要先 POC；需求 2 保持 SQLite 默认，按你提供的连接信息做可选后端。**

---

## 0.1 本轮确认（2026-11-25）

| 项 | 你的选择 | 对方案的影响 |
|---|---|---|
| 数据库 | **默认仍用 SQLite**；后续提供 MySQL/PG 连接信息 | 做可选适配器，SQLite 保持默认；连接信息只放本机 0600 配置/环境变量，不进仓库、不发聊天记录 |
| 默认推荐 | **默认关闭**；需要时使用抖音推荐视频 | `videoSource` 默认 `pool`，按账户显式开启 `recommend`；默认混合不做 |
| 快速发送 | **都走 API** | 需要区分「发送走 API」还是「选片也不能用浏览器」：发送本身已经是 API；推荐的 feed **选片**受签名限制，见 [4.4.6](#446-如果选片和发送都要走-api) |
| 简化配置 | **只配「总数量 + 时段」，后台随机分配** | 基础区改为「每天 N 条 + 时段起止」；新增随机分配算法，不再要求每时段 min/max |

> AI 接入的专项分析见 [ai-integration.md](ai-integration.md)。

### 0.2 实施结果（0.25.0）

- 需求 1 已实现：`account_settings` / `account_pools`、账户级配置、每日总数 + 时段随机分配、调度重读/可中断暂停。
- 需求 3 已实现纯 HTTP 路径：导出时捕获首页 `/tab/feed/`，`videoSource=recommend` 只走 API；feed 签名过期会明确报错。
  真实账号上仍需验证签名有效期（`node src/index.js api:feed`）。
- 需求 2 已实现可选后端与面板配置：默认 SQLite，MySQL/PostgreSQL 通过 worker 同步门面接入；MySQL 已用 ephemeral MySQL 8、PostgreSQL 用 pg-mem + bundled 真实 PG 回归；你的实例仍需连接信息联调。
- AI 已落地：只读运维助手、自然语言配置草案、推荐源安全过滤/排序；默认关闭。
- 详见 [CHANGELOG](../CHANGELOG.md)、[database.md](database.md)、[ai-integration.md](ai-integration.md)。

---

## 1. 现状：配置和视频来源到底在哪里

### 1.1 已按账户隔离的部分

| 数据 | 位置 | 说明 |
|---|---|---|
| 账户本体（标签、端口、profile、启用状态） | `accounts` | [schema/001_init.sql](../schema/001_init.sql#L10-L19) |
| 时段与条数 | `bands.account_id` | [schema/001_init.sql](../schema/001_init.sql#L36-L46) |
| 当日计划 | `plans.account_id` | [schema/001_init.sql](../schema/001_init.sql#L48-L58) |
| 发送记录 | `sends.account_id` | [schema/001_init.sql](../schema/001_init.sql#L60-L77) |
| 好友 | `friends.account_id` | [schema/004_account_name_friends.sql](../schema/004_account_name_friends.sql#L1-L16) |
| 纯 API 会话文件 | `data/api-sessions/<label>.json` | [src/api-session.js](../src/api-session.js#L14-L35) |
| 浏览器 profile / 端口 | `accounts.profile_dir` / `accounts.port` | 每账户一个 browser-server |
| 互关缓存 | `settings` 键 `mutualFriends:<label>` | 按账户，但用了「设置表 + 标签」的混合方式 |
| 调度进程 | `schedule:<label>` 子进程 | [src/host.js](../src/host.js#L169-L179) |

### 1.2 仍是全局的部分（需求 1 的核心问题）

| 全局设置 / 数据 | 位置 | 被谁使用 | 影响 |
|---|---|---|---|
| `minGapMinutes` | `settings` | `runtimeConfig` / 配置页 | 改一个账户的间隔，所有账户一起变 |
| `totalMin` / `totalMax` | `settings` | `runtimeConfig` / 配置页 | 同上 |
| `banWords` | `settings` | API / 浏览器选片、快速发送 | 一个账户加屏蔽词，全部账户生效 |
| `maxVideoAgeDays` | `settings` | API / 浏览器选片、快速发送 | 同上 |
| `poolDelayMs` | `settings` | 浏览器选片节奏 | 同上 |
| `sendMode`（auto/browser） | `settings` | 调度、面板、托盘 | 一个账户关纯 API，全部账户都关 |
| `pools.enabled` | `pools` 表 | 选片、配置页、CLI | 视频池开关是全局的，不是账户级 |
| `apiAutoRefresh` | `settings` | Electron 主进程 | 应用级行为，建议保持全局 |
| `activeAccount` | `settings` | 面板「当前查看」 | 面板状态，不是调度配置，保持全局合理 |

证据：

- `schema/001_init.sql` 明确写着 settings 是 "tunables that are not per-account"（[L21-L25](../schema/001_init.sql#L21-L25)）。
- `configFromDb()` 从全局 `settings` 读取所有计划参数（[src/dashboard.js](../src/dashboard.js#L37-L60)）。
- `persist()` 直接写全局 `settings`，时段写当前账户（[src/dashboard.js](../src/dashboard.js#L288-L322)）。
- 每个调度子进程各自 `runtimeConfig()`，但读到的计划参数来自同一张全局 `settings`（[src/scheduler.js](../src/scheduler.js#L22-L60)）。
- 快速发送的纯 API 路径也直接读全局 `banWords` / `maxVideoAgeDays`（[src/dashboard.js](../src/dashboard.js#L490-L502)）。
- `sendMode` 在托盘里是全局开关（[app/main.js](../app/main.js#L192-L208)）。

> 结论：**「每个账户配置独立」目前只做了一半**。时段、好友、账户开关独立；真正影响发送行为的大部分参数不独立。

### 1.3 配置读写链路

```
配置页 (page.html)
  → GET  /api/config        → configFromDb()      → settings + bands + pools
  → POST /api/config  {…}   → sanitize() → persist() → UPDATE accounts.enabled
                                                       + 全局 settings
                                                       + replaceBands(当前账户)
                                                       + 全局 pools.enabled

调度子进程 (schedule:<label>)
  → runtimeConfig(ACCOUNT)  → getAccount(label) + bands(account_id)
                            → 全局 settings(minGap/total/ban/age/poolDelay/sendMode)
  → runDay() 持有 cfg 快照，整天不再重新读取
```

两个直接后果：

1. 账户 A 改间隔，账户 B 的调度也变；
2. 保存配置后**不会重启调度**，而 `runDay()` 在当天剩余的每个时段都用启动时的 cfg 快照（[src/scheduler.js](../src/scheduler.js#L254-L337)）。所以「保存了但没生效」是现有体验问题，和需求 1 一起处理。

### 1.4 视频来源现状

当前只有一种来源：**视频池搜索**。

- 池目录是全局 `pools`（[src/pools.js](../src/pools.js#L6-L27)），每个池有一个基础关键词和 3 个同类变体。
- 纯 API 路径：`apiSender.pick()` 拼接搜索 URL，带「最新发布 + publish_time」过滤，解析 `general/search/single`，再用 `create_time` 精确过滤（[src/api-sender.js](../src/api-sender.js#L24-L123)）。
- 浏览器路径：`picker.pick()` 随机扫最多 4 个池，加载 `douyin.com/search/<keyword>` 页面，用 DOM 提取时长徽标+卡片文本，再用卡片上的相对时间过滤（[src/picker.js](../src/picker.js#L8-L123)）。
- 发送前还有 30 天去重（`video_id` + 标题）和屏蔽词（[src/video-picker.js](../src/video-picker.js#L54-L107)）。
- 结果写 `sends.bucket = 池名`，没有「来源」维度（[schema/001_init.sql](../schema/001_init.sql#L60-L74)）。

目前没有「首页推荐」来源，也没有「来源」字段。

---

## 2. 需求一：每账户配置独立 + 简化配置

### 2.1 需求拆解

这句话实际包含两件事：

1. **隔离**：账户 A / B 的间隔、每日条数、屏蔽词、视频池、发送模式、视频来源互不影响；切换账户后配置页显示该账户的值；调度子进程只读自己的值。
2. **简化**：配置页不要再让用户同时理解「每日总条数」和「每个时段的 min/max」两套东西，也不要暴露池间延迟这类技术参数；常用配置一屏能改完。

### 2.2 现状问题（带证据）

| 问题 | 现状 | 证据 |
|---|---|---|
| 核心参数全局 | 见 1.2 表 | `settings` 读写 |
| 视频池开关全局 | 勾选一个池，所有账户生效 | `setPoolEnabled` 更新 `pools` 表（[src/repos.js](../src/repos.js#L127-L129)） |
| 发送模式全局 | 一个账户关纯 API，其他账户一起关 | [src/dashboard.js](../src/dashboard.js#L544-L552) |
| 双份总条数 | 用户既要填每日总条数，又要填每个时段 min/max；`planner.fitBands` 会在后台按比例放宽/收紧，预览才显示 notes | [src/planner.js](../src/planner.js#L13-L76)、[src/dashboard.js](../src/dashboard.js#L798-L819) |
| 配置页过载 | 6 个字段 + 3 行×5 输入 + 20 个池勾选 + 屏蔽词 + 好友列表 + 纯 API 卡片 + 维护按钮 | [src/page.html](../src/page.html#L783-L855) |
| 技术参数暴露 | 池间延迟、视频最多几天前、间隔都直接给用户 | 同上 |
| 新账户默认时段三处复制 | `init`、账户页「添加」、扫码添加各写一份，值还不一样 | [src/index.js](../src/index.js#L34-L40)、[src/dashboard.js](../src/dashboard.js#L604-L608)、[src/dashboard.js](../src/dashboard.js#L658-L662) |
| 保存不重排 | 保存后当天计划不变，用户以为没生效 | `persist()` 不调用 planDay；`runDay` 用旧 plan |
| 账户切换丢草稿 | 切账户直接重新加载配置，未保存的修改静默丢失 | `quickSwitchAccount()` 里 `state.config = null`（[src/page.html](../src/page.html#L1071-L1092)） |
| 保存不区分账户 | 请求体没有账户标识，慢请求/多标签页可能写到「当前账户」而不是用户看到的账户 | `/api/config` POST |
| 配置 payload 里的 `friend` | `sanitize()` 接收，但 `persist()` 从不写入；实际好友来自 `friends` 表 | 属于死字段，简化时删除 |

### 2.3 账户级配置设计

#### 2.3.1 存储模型：账户覆盖 + 全局默认（推荐 A）

**方案 A（推荐）：`account_settings` 键值表 + 全局 `settings` 作为默认值**

```sql
-- 006_account_settings.sql（示意）
CREATE TABLE IF NOT EXISTS account_settings (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,          -- 刻意不用 key：MySQL 里 KEY 是保留字
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, name)
);

CREATE TABLE IF NOT EXISTS account_pools (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  pool_id    INTEGER NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  enabled    INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (account_id, pool_id)
);
```

> 若后续要做 MySQL/PG（需求 2），`updated_at` 的 `datetime('now')` 默认值要换成 `CURRENT_TIMESTAMP` 或由应用写入；`name` 列已经刻意避开 MySQL 的保留字 `key`。

- `settings` 继续存在，作为**默认值/应用级配置**（`activeAccount`、`apiAutoRefresh`、新账户默认值）。
- 现有全局值在迁移时复制到每个账户的 `account_settings`，保证上线后行为不变；之后每个账户改自己的行。
- 视频池启用状态放 `account_pools`，`pools.enabled` 降级为「新账户默认」。
- 键值用 TEXT 存 JSON/原始字符串，沿用 `getSetting` 的编码习惯（对象/数字 JSON，字符串原文），读取时 `JSON.parse` 失败则按字符串返回。

**为什么不用「给 accounts 加一堆列」**：配置键会随版本增加（0.23.0 就新增了 `maxVideoAgeDays`），每加一个设置都要 ALTER TABLE；键值表更适合这种演进速度，且便于做「继承默认/重置」。

**为什么不用「每个账户一个配置文件」**：备份、迁移、并发写、CLI 统计都会变复杂，而且和需求 2 的方向相反。

#### 2.3.2 读取优先级

```
账户值 (account_settings)
  → 全局默认 (settings)
  → 代码默认 (sanitize/defaults)
```

`repos.getAccountSetting(accountId, name, fallback)` 实现这个顺序；写入只写 `account_settings`。这样：

- 读取上即使没有复制也有回退，不会因为新增设置导致老账户缺值；
- 以后新增设置，老账户自动拿到全局默认；
- 需要一个「重置为默认」动作时，删除该账户的行即可。

不过迁移时仍建议**把现有全局值复制到每个账户一次**：否则以后有人改了全局默认，所有没有覆盖行的老账户会一起变，和「账户独立」的预期相反。

#### 2.3.3 键位清单

| 键 | 作用域 | 说明 |
|---|---|---|
| `dailyTotal` | 账户 | 每天总条数 N；基础区唯一的总量配置 |
| `minGapMinutes` | 账户 | 两条之间的最少间隔 |
| `totalMin` / `totalMax` | 账户 | 每日总条数；建议改为「高级覆盖」，默认由时段合计 |
| `banWords` | 账户 | 屏蔽词数组 |
| `maxVideoAgeDays` | 账户 | 视频最大年龄 |
| `poolDelayMs` | 账户 | 浏览器池间节奏（建议收进高级） |
| `sendMode` | 账户 | auto / browser；每账户的 API 会话独立，模式也应独立 |
| `videoSource` | 账户 | 需求 3 新增：pool / recommend / mixed |
| `mutualFriends` | 账户 | 从 `mutualFriends:<label>` 迁进来（缓存，不是配置，但放一起更一致） |
| `activeAccount` | 全局 | 面板查看状态 |
| `apiAutoRefresh` | 全局 | Electron 主进程的应用级行为 |
| 池选择 | 账户 | `account_pools` |

#### 2.3.4 代码改造点

| 层 | 改动 |
|---|---|
| `schema/006_*.sql` | 建 `account_settings` / `account_pools`；回填现有全局值 |
| `src/repos.js` | 新增 `getAccountSetting` / `setAccountSetting` / `listAccountSettings`；`listPools(accountId)` 或 `listAccountPools`；`setAccountPoolEnabled`；新账户默认值集中到 `defaults.js` |
| `src/scheduler.js` | `runtimeConfig` 按 `acc.id` 读取；`runDay` 在每个时段发送前重新读取轻量配置（至少 enabled / 好友 / 来源 / 时效 / 屏蔽词）；`dailyTotal` 存在时走 `planDayRandom` |
| `src/dashboard.js` | `configFromDb` / `persist` 按 `acc.id`；`/api/config` 请求体带 `account` 或 `accountId`；`/api/api-session/mode` 写账户级；预览接口返回随机分配的时段/时刻 |
| `src/page.html` | 配置页显示「当前账户」；切账户/离开前未保存提示；池选择改为账户级 |
| `app/main.js` | 托盘「纯 API 优先」改为读当前账户的 `sendMode`；文案说明只影响当前账户 |
| `src/index.js` | `api:mode` / `api:status` / CLI 增加 `--account`，或明确作用于当前账户 |
| 默认时段 | 抽出 `DEFAULT_BANDS`，`init` / 手动添加 / 扫码添加共用 |

#### 2.3.5 迁移与兼容

- 迁移 006 只做加法：新表 + 回填，不改旧表结构；旧版本回滚时新表被忽略，旧代码继续读 `settings`，行为退化为全局，可接受。
- 回填值：`minGapMinutes`、`totalMin`、`totalMax`、`dailyTotal`、`banWords`、`maxVideoAgeDays`、`poolDelayMs`、`sendMode` 各复制一份到每个账户；`account_pools` 按 `pools.enabled` 初始化。
- 新账户：创建时把当前全局默认复制进 `account_settings`，或依赖读取回退；建议复制，行为更可预期。
- CLI/脚本：`api:mode` 这类全局命令要更新，否则会出现「CLI 改了默认，老账户不受影响」的困惑。
- 回滚：保留 `settings` 原值；把账户行删掉即可回到全局值。

### 2.4 简化配置

#### 2.4.1 当前配置页审计

| 控件 | 问题 | 建议 |
|---|---|---|
| 运行状态 | 顶部已有暂停/继续 | 保留但弱化，或只留顶部 |
| 两条间隔 | 常用但偏技术 | 基础区保留，默认 5；给一句人话说明 |
| 每日总条数（下限/上限） | 与时段 min/max 重复；0 的含义不直观 | **改为基础区唯一的总量（单个 N）**；时段只配起止；后台随机分配。高级可保留「范围/每时段上限」覆盖 |
| 池间延迟 | 纯技术防封参数 | 收进高级，默认 2500 |
| 视频最多几天前 | 有价值但不需要常改 | 收进高级，默认 7 |
| 时段 5 输入/行 | 一屏放不下，min/max 与总数关系难理解 | 基础区只留「名称 / 开始 / 结束」；条数由总量随机分配；预设 |
| 20 个视频池勾选 | 信息过载 | 可搜索/分组的多选，或先选「主题」再展开；提供全选/清空 |
| 屏蔽词 textarea | 高级内容 | 收进高级 |
| 好友列表 | 与账户页重复 | 移到账户页；配置页只显示「启用好友 N 位」摘要 |
| 纯 API 会话卡片 | 属于连接/高级 | 收进高级或账户页 |
| 维护按钮 | 首页已有 | 高级区保留一个入口即可 |
| 保存 / 预览 / 安全模式 | 保存与「今天计划」关系不明 | 保存后提示「已保存；要让今天生效请重排/应用」；预览保留 |

#### 2.4.2 建议的信息架构

```
配置（当前账户：B · 独立保存）
┌ 基础 ─────────────────────────────────────┐
│ 运行状态          [启用/暂停]              │
│ 每天条数          [8] 条（后台随机分配）    │
│ 发送时段                                   │
│   早间  09:00-12:00                        │
│   下午  14:00-18:00                        │
│   晚间  20:00-23:30                        │
│   [+ 添加时段]  [预设：轻量/标准/活跃]      │
│ 视频来源          (•)视频池 ( )默认推荐 ( )混合 │
│ 启用好友          3 位（去账户页管理）      │
│ [保存] [预览] [重排今日]                   │
└────────────────────────────────────────────┘
▸ 高级
  每条最少间隔 / 视频最多几天前 / 池间延迟
  每日条数范围 / 每时段权重或上限（默认不填）
  视频池多选 / 屏蔽词 / 纯 API 会话 / 维护
```

要点：

- **基础区只有 3 个决定**：开不开、每天几条、什么时段（视频来源是第 4 个，但默认值可不动）。
- 时段只填起止，不再让用户做「每个时段几条」的二次分配；后台按容量随机分配。
- 高级区默认折叠，老用户仍然能精确控制（范围、权重、每时段上限）。
- 顶部明确「当前账户」和「独立保存」，减少切账户后的误解。
- 保存后立刻给「只影响后续发送 / 要改今天请重排」的提示。

#### 2.4.3 模型简化：总数 + 时段，后台随机分配

这是本轮确认的核心改动。目标：用户只回答两个问题——**每天发几条、哪些时段可以发**；系统自己决定每个时段分几条、每条几点发。

**数据模型**

- 新增账户设置 `dailyTotal`（单个正整数 N）。
- `bands` 只保留 `name / start_min / end_min / sort` 的语义；基础区不再写 `min_count / max_count`（旧字段保留，供老版本/高级模式使用）。
- 高级可选：`dailyTotalMin/Max`（范围）、`bandWeights`（每时段权重）、`bandMax`（每时段上限）。默认不填。
- 调度仍写 `plans.times_json`，不需要新的计划表。

**算法（纯函数，放在 planner.js）**

输入：`bands[]`（起止）、总数 `N`、`minGapMinutes`、`startMin`（当天当前时刻后的起点）、可选权重/上限。

1. 规范化时段：按开始时间排序；重叠时段合并或拒绝（建议拒绝并提示）；过滤掉当天已经过去的时段。
2. 计算容量：每个时段 `capacity = floor((end - from) / minGap) + 1`；总容量 = 各段之和。若 `N > 总容量`，不静默压缩间隔；预览提示「时段容纳不下 N 条」，可选把 N 降到容量或建议加长时段。
3. 随机分配条数：以时段时长（或高级权重）为权重，把 N 条按随机多项分布分到各段；超过该段容量的部分重新分配，直到每段 `0 <= count <= capacity`。
4. 段内随机时刻：复用/改造 `planBand`：在 `[from, end)` 内随机取 `count` 个时刻并保持 `minGap`；如果失败（空间不足），按容量减少该段并重新分配。
5. 跨段最小间隔：如果两个时段相邻很近，检查相邻段最后一个/第一个时刻；必要时把后一段的第一个时刻向后推，或从该段重新采样。
6. 输出：`{ total: N, times: [...], allocation: [{name,count}], notes }`；全程使用可注入的随机数，便于单测固定种子。

**为什么不用「在并集里均匀撒 N 个点」**：也能做，但多个时段时长不同时分布不可控，且 minGap 冲突后要反复重采样；按时段容量加权分配更稳定，也方便预览。

**保留旧模式**

- `planner.planDay`（现有 min/max + fitBands）保留，供高级模式/回滚；`runtimeConfig` 读 `dailyTotal`：有值走 `planDayRandom`，无值走旧 `planDay`。
- 这样迁移可以先只写 `dailyTotal`，不删除旧字段；回滚版本仍能按旧逻辑跑。

**迁移**

- 迁移 006 给每个账户写 `dailyTotal`：优先用当前 `totalMax`（>0 时）；否则用 `min(30, max(1, round((sum(min)+sum(max))/2)))`；并在 CHANGELOG/面板提示「已根据旧配置推算每天 N 条，可调整」。
- 旧 `totalMin/totalMax` 和 bands 的 min/max 保留，作为高级覆盖；不清空，避免回滚丢配置。
- 当天已有 `plans` 不动；用户点「重排今日」才用新算法重新生成。

**界面**

- 基础区：`每天条数 [N]` + 时段起止列表；预览显示每段随机分配到的条数和具体时刻。
- 高级区：可选「每天条数范围」「每时段权重/上限」「最少间隔」；不填就是默认行为。
- 保存后提示：总数/时段改变不会自动改今天的计划，点「重排今日」应用。

**边界**

- N=0：暂停/不排班（和 `enabled=false` 区分）。
- 当天开始得晚：只从 `now+3` 之后分配；剩余容量不够时按容量降级并记录事件。
- 时段跨午夜：当前 planner 假定同日；跨午夜要么拒绝，要么拆成两段；第一期建议拒绝并提示。
- 容量不足：不静默减少发送，预览/日志明确说明；用户可加长时段或降低 N。

**测试**

- 固定种子下输出可复现；
- 单时段/多时段、容量刚好/不足、最小间隔、跨段相邻、晚启动；
- N=0、重叠时段、跨午夜拒绝；
- 旧模式 `planDay` 的现有测试保持通过。

#### 2.4.4 预设与复制

- 预设：轻量（2–4/天）、标准（6–8/天，接近现有「安全模式」）、活跃（10–14/天）。预设只改时段和总数，不碰屏蔽词/池。
- 「复制到其他账户」：显式确认后，把当前账户的 `account_settings` + `account_pools` 复制到目标账户；多账户初始化一次即可，不用逐个配。
- 「恢复默认」：删除当前账户的覆盖行。

### 2.5 必须一起处理的边界

1. **调度快照**：`runDay` 现在整天持有一份 cfg。建议在每个时段发送前重新读取「轻量配置」（enabled、好友、视频来源、时效、屏蔽词、间隔），或者引入配置版本号（`updated_at` 最大值）检查。否则「保存后不生效」会继续存在。这同时是优化计划 P0-1（暂停立即生效）的前置工作。
2. **暂停**：暂停只改数据库，`runDay` 的 sleep 不会被打断。修复方式：可中断 sleep，每 1–5 秒检查 `accounts.enabled` 和配置版本。需求 1 的验收标准里应该包含「暂停 5 秒内生效」。
3. **账户切换与草稿**：切账户前检查表单是否有未保存修改；`/api/config` 请求带账户标识，服务端校验，避免慢请求写错账户。
4. **并发写**：`persist` 现在是手写 BEGIN/COMMIT（[src/dashboard.js](../src/dashboard.js#L290-L320)）。需求 1 加了新表，仍在同一事务里；如果需求 2 改成连接池，事务必须绑定单连接。
5. **Electron 托盘**：`account()` / `sendMode()` 是同步读 DB（[app/main.js](../app/main.js#L182-L217)）；账户级 `sendMode` 后托盘要显示当前账户的模式，并明确只改当前账户。若以后异步化，托盘菜单需要缓存快照。
6. **新账户默认值**：三处重复的时段默认值必须收口，否则「简化配置」后新账户仍然五花八门。
7. **API 会话与模式**：`sendMode` 每账户独立后，快速发送的「纯 API 会话」卡片和托盘都要跟着账户走；`apiAutoRefresh` 保持全局，避免每个账户各跑一套刷新循环（Electron 主进程本来就按账户循环）。

### 2.6 验收标准

- 账户 A 设间隔 30、屏蔽词 `["国漫"]`、只开 3 个池、`sendMode=browser`；账户 B 设间隔 5、不屏蔽、开 10 个池、`sendMode=auto`；两边保存后互不影响。
- 账户只填「每天 8 条 + 三个时段」后，预览能得到 8 个时刻，且各时段条数随机、每条间隔不小于配置值；容量不足时明确提示而不是静默少发。
- 切换账户后，配置页显示的是该账户的值；`GET /api/config` 返回的 `account` 与当前账户一致。
- 两个调度子进程各自按自己的配置发送；日志里能看到各自的 `sendMode` / 屏蔽词 / 池。
- 新账户继承默认值；「复制到其他账户」后目标账户完全一致。
- 配置页基础区只有「开/关、每天条数、时段、视频来源、好友摘要」；高级区可完成所有旧能力。
- 暂停后 5 秒内不再发送；保存配置后，下一次发送使用新值（当天计划本身是否重排，需在 UI 明确）。
- 迁移前后，现有单账户的行为不变（用 `npm test` + 临时 DB 往返验证）；旧 `planDay` 测试保持通过。
- 回滚旧版本后，旧代码仍能读 `settings` 并正常运行。

### 2.7 工作量

| 子项 | 估时 |
|---|---|
| 006 迁移 + repos + 默认值收口 | 0.5–1 天 |
| `runtimeConfig` / `configFromDb` / `persist` / API | 0.5 天 |
| 调度每时段重读 + 可中断暂停 | 0.5–1 天 |
| 随机分配算法 `planDayRandom` + 预览 + 测试 | 0.5–1 天 |
| 配置页重构 + 预设 + 复制 + 未保存提示 | 1–1.5 天 |
| 测试 + 迁移/回滚验证 + 文档 | 0.5–1 天 |
| **合计** | **约 3.5–5 天**（只做隔离、不做随机分配约 1.5–2 天） |

---

## 3. 需求二：支持 MySQL / PostgreSQL

### 3.1 先确认需求动机

「支持 MySQL/PostgreSQL」至少可能是四种不同诉求，成本相差一个数量级：

| 诉求 | 更便宜的满足方式 | 是否需要真后端 |
|---|---|---|
| 想把数据放到 NAS，24 小时在线 | 仅数据库层面：SQLite 放 NAS 的 `data/` 目录即可；浏览器执行仍需要桌面机（见 [handoff-fnos.md](handoff-fnos.md#L49-L72)） | 否 |
| 想让别人/BI 查数据 | 定时导出 JSON/CSV，或单向同步到 MySQL/PG | 否（推荐） |
| 想多台机器/多人同时用 | 需要拆分「调度端 / 执行端」，DB 只是其中一环；参考 [handoff-fnos.md](handoff-fnos.md#L63-L72) 方案 B | 是，但还要做 agent 协议 |
| 已有 MySQL/PG 运维规范，要求数据进库 | 真后端或单向同步 | 视规范而定 |

如果动机只是前两种，**不建议直接把应用改成依赖远程数据库**：SQLite 是本地优先架构的关键优势，改成远程 DB 会引入网络分区、延迟、凭据管理和重复发送风险。

> 另外注意：数据库只存账户配置、计划、发送记录和事件；**浏览器 profile 与纯 API 会话仍是本机文件**（`data/profile-*`、`data/api-sessions/*.json`）。换成远程 DB 不会让多台机器共享登录态，多机方案仍要把「执行端 + 登录态」绑定在一起。

### 3.2 为什么不是「换个连接串」

| 障碍 | 现状 | 影响 |
|---|---|---|
| **同步 API** | `db.open()` 返回 `DatabaseSync`，`repos` 全部同步；`node:sqlite` 只有同步接口 | `pg` / `mysql2` 是异步的；`repos` 的 47 条语句、约 290 处引用（含测试）都要 `await` 化 |
| **调用方同步假设** | dashboard、scheduler、index.js、host.js、app/main.js 都直接同步调用 repos | 不是包一层 Promise 就能解决；Electron 托盘菜单、host 的 `spawnSchedules` 都需要改 |
| **方言差异** | `?` 占位符、`AUTOINCREMENT`、`ON CONFLICT`、`INSERT OR IGNORE`、`datetime('now')`、`sqlite_master`、`LIMIT ?`、布尔/JSON/长文本索引 | 每条都要有方言版本或适配器 |
| **迁移模型** | `schema/*.sql` + `meta` 表，SQLite 语法；MySQL DDL 隐式提交，事务回滚语义不同 | 需要三套 schema 或 JS 迁移；失败回滚策略要重设计 |
| **裸 SQL** | dashboard/index/host/doctor/backup/verify/test 里有 `prepare` / `exec` / `sqlite_master` / `VACUUM INTO` | 必须收进 repos 或适配器，工作量扩散 |
| **测试** | `test/db.test.js` 用 `sqlite_master`，CI 只跑 SQLite | 需要 PG/MySQL 服务、迁移矩阵、并发/事务测试 |
| **运维** | 本地文件、WAL、busy timeout | 连接池、断线重连、超时、慢查询、备份（pg_dump/mysqldump）、凭据 |

具体方言差异（实现时必须逐项处理）：

| 关注点 | SQLite | PostgreSQL | MySQL |
|---|---|---|---|
| 占位符 | `?` | `$1` | `?` |
| 自增主键 | `INTEGER PRIMARY KEY AUTOINCREMENT` | `INTEGER GENERATED ... AS IDENTITY` | `INT AUTO_INCREMENT` |
| upsert | `ON CONFLICT … DO UPDATE` | 同左 | `ON DUPLICATE KEY UPDATE` |
| insert-ignore | `INSERT OR IGNORE` | `ON CONFLICT DO NOTHING` | `INSERT IGNORE` 或 upsert 空更新 |
| 当前时间 | `datetime('now')` | `now()` / `CURRENT_TIMESTAMP` | `CURRENT_TIMESTAMP` |
| 布尔 | `INTEGER 0/1` | 建议 `SMALLINT` | `TINYINT(1)` |
| JSON | `TEXT` + 代码 parse | 建议也 `TEXT`，避免 jsonb 自动映射 | 建议也 `TEXT`，避免驱动自动 parse |
| 保留字 | 无碍 | `key`/`value` 可用 | **`KEY` 是保留字**，`settings(key,value)` 要改列名或加反引号 |
| `COUNT(*)` 返回 | number | node-postgres 默认 **string**（int8） | number |
| 长文本唯一索引 | 可以 | btree 行大小限制 | 需要前缀长度或 hash 列 |
| DDL 事务 | 支持 | 支持 | **隐式提交** |
| 备份 | `VACUUM INTO` | `pg_dump` | `mysqldump` |
| 连接 | 文件 + busy timeout | 连接池 | 连接池 |

> 其中两个容易踩的坑：`events` 的唯一索引 `(ts, event, payload)` 在 MySQL/PG 上对长 payload 都不安全，建议改成 `payload_hash`（SHA-256）+ 唯一索引；当前 `settings.key` 在 MySQL 里是保留字，设计 `account_settings` 时我已经建议用 `name`。

### 3.3 改造面清单

| 文件 / 区域 | 现状 | 改造 |
|---|---|---|
| `src/db.js` | 打开 SQLite、PRAGMA、迁移循环 | 拆成 `db/index.js` + `db/sqlite.js` / `db/postgres.js` / `db/mysql.js`，暴露 async `query/get/all/run/exec/transaction` |
| `src/repos.js` | 全部同步 SQL | 全部 async；upsert/insert-ignore/now/count 适配；事务 API |
| `src/scheduler.js` | 同步读配置 | `runtimeConfig` async；调用方 await；`runDay` 中所有 repos 调用 await |
| `src/dashboard.js` | 同步 + 裸 SQL（persist/accounts/control） | 裸 SQL 收进 repos；handler 已经 async，主要是 await |
| `src/host.js` | `DatabaseSync` 读 accounts | 改为 async 读，或通过 dashboard API 读 |
| `app/main.js` | 托盘同步读 repos | 缓存快照或 async 刷新菜单 |
| `src/index.js` | CLI 裸 SQL + 同步 repos | async + repos 方法 |
| `src/importer.js` / `doctor.js` / `verify.js` / `backup.js` | SQLite 专用检查/SQL | 按驱动分支；`doctor` 检测连接；`backup` 按驱动 |
| `schema/*.sql` | SQLite 语法 | 三套目录或 JS 迁移 |
| `test/*.js` | SQLite 测试 | 驱动矩阵；CI 加 PG/MySQL service |
| `package.json` | 无 DB 依赖 | 加 `pg` / `mysql2`（纯 JS，无原生编译；打包体积略增） |

### 3.4 方案对比

| 方案 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **A. 保持 SQLite + 导出/单向同步** | 定时把 `sends/events/plans` 导出 JSON/CSV，或写到 MySQL/PG 的报表库 | 改动小、风险低、本地优先不变 | 不是「应用运行在 MySQL/PG 上」；双向写入不支持 | **如果只是报表/备份，推荐** |
| **B. 异步适配器 + 先 PostgreSQL** | 数据层抽象，repos async，PG 迁移/测试；SQLite 仍默认 | 满足真后端；PG 的 SQL 与 SQLite 最接近（ON CONFLICT/RETURNING/事务 DDL） | 仍需大规模 await 化；连接/网络错误处理 | **如果必须做，推荐 B** |
| **C. 异步适配器 + PG + MySQL** | 在 B 上加 MySQL 方言和测试 | 覆盖两个目标 | 工作量再加 3–5 天；MySQL 差异最多 | 分阶段，B 稳定后再 C |
| **D. 同步 worker 桥接** | 用 Worker + Atomics.wait 把异步驱动包装成同步 | 调用方几乎不改 | 阻塞事件循环、难调试、崩溃/超时语义复杂 | **不推荐** |
| **E. Knex/Drizzle 等** | 用查询构建器/迁移工具抽象方言 | 减少方言 SQL；迁移工具成熟 | 仍要 async 化；重写现有 SQL/迁移；新增依赖和心智负担 | 可选，但不解决主要成本 |

### 3.5 若必须做：推荐路径

**原则：SQLite 继续是默认和首选；MySQL/PG 是可选后端；分阶段交付。**

1. **先做 P0-3 发送幂等**（优化计划）：远程 DB 的网络失败会放大「已发送但没记录」的重复发送风险。没有幂等键，不建议接远程库。
2. **抽象存储接口**（同步调用方改成 async）：
   ```js
   // 目标形态（示意）
   const db = require('./db');           // 根据 DB_DRIVER 选实现
   await db.query('SELECT ...');         // 或 repos 层
   await db.transaction(async (tx) => { ... });
   ```
3. **repos 全量 async 化**：这是最大的一块，约 290 处调用点；建议按模块分批（db/repos → scheduler → dashboard → CLI/host/app），每批保持测试绿。
4. **SQL 可移植子集**：
   - 所有时间/日期继续用 ISO/TEXT（`ts`、`day`、`created_at`），不用 `TIMESTAMP WITH TIME ZONE`；
   - 布尔/JSON 继续用 `INTEGER` / `TEXT`，由代码 parse；
   - 自增用 `INT`（不用 bigserial），避免 JS 精度问题；
   - 唯一索引用 `payload_hash`；
   - 列名避开 `key` 等保留字；
   - 每个方言只保留少量 helper：`now()`、`upsert()`、`insertIgnore()`、`tableExists()`、`lastInsertId()`。
5. **迁移**：两种可选
   - **推荐（透明）**：`schema/sqlite/00N.sql`、`schema/postgres/00N.sql`、`schema/mysql/00N.sql`，同编号；runner 按驱动选目录；迁移记录加 `checksum`；MySQL 的 DDL 失败不能回滚，逐条记录并在启动时校验。
   - 备选：JS 迁移模块 + 方言 DDL helper，一份逻辑；但会改写现有迁移，且 SQL 可读性下降。
   - **存量数据迁移**：SQLite → 目标库做一次性导入（保留 `id`，导入后重置自增序列），或直接从空库开始；导入前备份，导入后校验行数与抽样；`times_json` / `done_json` 等 TEXT 原样搬运。
6. **配置/凭据**：
   - `DB_DRIVER=sqlite|postgres|mysql`；`DB_URL` 或分字段（host/port/user/password/database/ssl）；
   - 密码不要进 `.env` 提交；放 `data/` 下 0600 文件或系统钥匙串；面板只显示连接状态，不回显密码；
   - 启动时 `doctor` 检查连接、schema 版本、写权限；连接失败时面板明确报错，不要静默降级（避免写到另一个库）；
   - 如果要在面板里配置连接串，还要做「测试连接 / 保存凭据 / 重启子进程」，工作量另计；第一版建议只用环境变量或数据目录里的配置文件。
7. **并发与事务**：
   - 连接池（PG `pg.Pool`、MySQL `mysql2/promise` pool）；
   - `persist` 等事务必须 `BEGIN/COMMIT` 在同一连接；
   - 调度子进程 × 账户数 × dashboard 的连接数要限制；
   - 断线重试策略：只读可重试，写入谨慎（配合幂等键）。
8. **备份/运维**：SQLite `VACUUM INTO`；PG `pg_dump`；MySQL `mysqldump`；或者应用内逻辑导出 JSON。远程库的备份责任要写进文档。
9. **测试**：SQLite 全量；PG/MySQL 至少跑迁移、repos 往返、事务回滚、并发写、`COUNT(*)` 类型、唯一索引、JSON 往返；CI 用 service container。
10. **分阶段**：先 PG（与 SQLite SQL 最接近），稳定后再 MySQL；SQLite 保持默认，不强制用户迁移。

### 3.6 成本与风险

| 项 | 估时 |
|---|---|
| 存储抽象 + 方言 helper | 1.5–2 天 |
| repos async + 调用方改造（含 scheduler/dashboard/CLI/host/app） | 3–5 天 |
| schema/迁移 × 2–3 方言 | 2–3 天 |
| 测试矩阵 + CI | 2 天 |
| 运维（doctor/backup/文档/凭据） | 1–2 天 |
| **合计** | **约 10–15 天**（PG only 约 7–10 天） |

主要风险：

- **重复发送**：远程库写入失败但消息已送达；必须先做幂等（P0-3）。
- **行为漂移**：布尔/JSON/计数类型/日期格式/事务语义在三种库上不完全一致，容易出现「SQLite 通过、PG 失败」。
- **调度回归**：把同步改异步会触及调度主循环，风险高于 UI。
- **运维复杂度**：用户要装/维护数据库；Electron 桌面版第一次启动可能连不上。
- **测试成本**：CI 需要数据库服务，开发机也要有。
- **打包**：`pg`/`mysql2` 是纯 JS，问题不大，但需要确认 electron-builder 的 `files` 包含依赖。

### 3.7 结论

- **按本轮确认：SQLite 继续做默认，MySQL/PG 以「可选后端」实现，不阻塞需求 1/3 的功能开发。** 等你提供连接信息后，再做适配器和联调。
- 如果目标是**报表/备份/让别人查**：做「SQLite → MySQL/PG 的单向同步/导出」，1–2 天可交付，风险低；这比直接换后端更适合作为第一步。
- 如果目标是**真后端/多实例**：先 PG、保留 SQLite 默认，并且先完成发送幂等和「调度端/执行端」拆分；MySQL 作为第二阶段。
- 如果目标是**NAS 上 24 小时运行**：数据库层面 SQLite + NAS 数据目录足够；但浏览器执行仍需要一台有桌面环境的机器，参考 [handoff-fnos.md](handoff-fnos.md#L49-L72) 的方案 A/B，不需要为了 NAS 换数据库。

### 3.8 需要拍板

1. 你要的是「数据进 MySQL/PG 可查」，还是「应用本身跑在 MySQL/PG 上」？
2. 部署形态是单机桌面、NAS、还是多台机器/多人共用？
3. 是否接受先完成「发送幂等」再上远程库？
4. 是否接受 PG 先行、MySQL 后置，以及 SQLite 继续做默认？

---

## 4. 需求三：直接用抖音默认推荐作为视频源

### 4.1 需求拆解

「视频分享可否直接使用抖音推荐，分为视频池搜索和默认推荐」可以落到三个层面：

1. **来源**：每个账户可以选择「视频池搜索」或「默认推荐」（以及可选的混合）。
2. **选片**：默认推荐不再走关键词搜索，而是读该账户的首页推荐流。
3. **发送**：仍然复用现有「打开视频 → 打开分享面板 → 点好友」的发送链路；记录里能区分来源。

### 4.2 现状：只有池搜索

- 池搜索是**主动、可控**的：关键词 + 变体 + 最新发布 + 7 天时效 + 30 天去重 + 屏蔽词。
- 浏览器路径每次发送最多加载 4 个搜索页（`scanLimit=4`），再随机选一个候选（[src/picker.js](../src/picker.js#L78-L123)）。
- 纯 API 路径只依赖一个捕获的搜索 URL（`session.searchUrl`），cookie 重放即可（[src/api-sender.js](../src/api-sender.js#L24-L123)）。
- 结果按池名记录（`sends.bucket`），没有「来源」字段。

### 4.3 两条技术路径

#### 4.3.1 浏览器路径（可行，推荐先做）

思路：复用现有 browser-server，打开抖音首页推荐流，从 DOM 抓候选，然后走现有分享链路。

```
browser-server 启动时已经打开 https://www.douyin.com/（推荐流）
  → /goto 首页（或 ?recommend=1）
  → 轮询 /eval 执行推荐卡片提取器
  → 过滤：非视频（图文/直播）、广告、屏蔽词、30 天去重、可选时效
  → 选中一条：优先用卡片上的 /video/<id> 直接打开视频页
  → /openshare → /send（现有逻辑不变）
```

需要新增/调整：

| 项 | 说明 |
|---|---|
| `RECOMMEND_URL` | 首页推荐页；具体 URL/是否带 `?recommend=1` 需 POC 确认 |
| `EXTRACT_RECOMMEND` | 新的 DOM 提取器：从 `a[href*="/video/"]` 找卡片，取 `aweme_id`、标题、作者、点赞；跳过 `/note/`（图文）、`/live/`（直播）、广告 |
| 打开方式 | 推荐直接 `goto https://www.douyin.com/video/<id>`，避免「按标题找卡片」在推荐流里失效；现有 `/openshare` 依赖视频详情页的 `data-e2e="video-player-share"`，POC 验证 |
| 时效过滤 | 推荐流卡片可能不显示发布时间；当前 `filterRecent` 会丢弃无日期候选（[src/video-picker.js](../src/video-picker.js#L54-L72)）。推荐流本身就是新鲜的，建议对推荐源**放宽为「有日期才校验，无日期接受」**，或直接用详情页/接口拿 `create_time` |
| 去重 | 继续用 30 天 `video_id` + 标题；推荐流可能重复推同一条，去重尤其重要 |
| 节奏 | 推荐源每次只加载 1 个首页，比池搜索最多 4 个搜索页更轻；但仍要保留随机延迟和人机验证检测 |
| 记录 | `sends.bucket = '默认推荐'`，新增 `source = 'recommend'`；池源保持 `source='pool'` |

#### 4.3.2 纯 HTTP 路径（有签名墙，暂不承诺）

首页推荐接口是 `GET https://www.douyin.com/aweme/v1/web/tab/feed/`（社区资料一致，响应里有 `aweme_list` / `has_more`，`refresh_index` 控制刷新/翻页）。问题在于鉴权：

- 本项目 POC 已经证明：**搜索等只读接口带 cookie 重放即可**，去掉 `a_bogus`/`msToken` 仍成功（[docs/api-poc.md](api-poc.md#L16-L20)）。
- 但社区对 feed 的逆向结论是：**feed 需要 `a_bogus` + `timestamp` + `x-secsdk-web-signature` 三件套**，缺一个就 403（[sign_reverse_findings.md](https://raw.githubusercontent.com/mafqla/douyin-api/main/docs/sign_reverse_findings.md#1)）。这是外部资料，必须在自己的账号上复测，但它说明「搜索能重放」不能直接推导出「推荐也能重放」。
- 如果只是捕获导出时的一条已签名 feed URL 再重放：签名带时间戳，通常几分钟内就可能失效；会话/模板虽然每 12 小时刷新一次，但不能把捕获的 feed URL 当作长期可用的接口；每次发送前重新捕获又需要浏览器，等于回到浏览器路径。
- 结论：**纯 API 推荐不是「加一个 URL」的工作量**，需要 secsdk 签名或浏览器在环；短期不建议作为承诺项。

#### 4.3.3 对比

| 维度 | 浏览器推荐源 | 纯 API 推荐源 |
|---|---|---|
| 可行性 | 高（复用现有 browser-server） | 低–中（签名墙，需 POC） |
| 工作量 | 2–3 天 | +3–5 天，且可能失败 |
| 风控 | 每次 1 个首页加载；比池搜索 4 页更轻 | 无浏览器指纹，但接口签名要求高 |
| 时效过滤 | 卡片可能无日期，需放宽 | 响应有 `create_time`，更容易 |
| 维护 | DOM 改版要更新提取器 | 签名/DOM 都要跟，维护更重 |
| 内容可控性 | 推荐流由算法决定，需屏蔽词/过滤 | 同左 |

### 4.4 建议设计

#### 4.4.1 配置

- 账户级 `videoSource`：`pool`（默认，保持现状）/ `recommend` / `mixed`（可选，各 50%）。推荐流按该账户的浏览器 profile/登录态个性化，正好和账户级配置匹配。
- 默认 `pool`：推荐源是**显式开启**的，符合现有「影响收件人的功能默认保守」原则（优化计划明确不采用「随机热榜/随机热词」，见 [optimization-plan.md](optimization-plan.md#L365-L369)）。
- 开启 `recommend` 时，配置页给一句风险提示：推荐流由账号兴趣决定，可能包含与视频池主题无关的内容；屏蔽词仍然生效。
- 混合模式的落点：每次发送随机选来源；如果推荐源无候选，是否回退到池？建议：
  - `pool`：不变；
  - `recommend`：无候选就失败并记录原因，**不静默改用池**（尊重用户选择）；
  - `mixed`：推荐失败可回退池，并记录 `source-fallback` 事件。

#### 4.4.2 选片流程

```
sendOne(cfg)
  → source = cfg.videoSource === 'mixed' ? random('pool','recommend') : cfg.videoSource
  → source === 'pool':
       纯 API：apiAttempt()（搜索接口）→ 失败回退浏览器
  → source === 'recommend':
       feed API 可用：apiAttemptFeed()（纯 HTTP 或浏览器取数）→ API 发送
       feed API 未启用：浏览器 pickRecommend() → API/浏览器发送（见 4.4.6）
  → 记录 source / bucket / videoId
```

- `apiAttempt` 在 `source=recommend` 且 feed API 未启用时直接返回 `null`，让 `sendOne` 走浏览器；日志里写 `recommend-browser-only`，避免用户以为「纯 API 坏了」。
- 以后如果纯 API 推荐 POC 成功，再把 `apiSender.pickFromFeed()` 接进来，`apiAttempt` 分支不变。

#### 4.4.3 推荐候选标准化

浏览器提取器和未来 API 提取器都归一化成同一结构：

```js
{
  awemeId, title, author, likes,
  createTime?, ageDays?, width, height,
  coverUrlList?, thumbUrlList?, uid?,
  source: 'recommend'
}
```

过滤规则（顺序执行）：

1. 只保留视频：跳过 `/note/`（图文）、`/live/`（直播）、无 `aweme_id` 的卡片；
2. 跳过广告/推广卡片（文案/标记检测；POC 确认 DOM 特征）；
3. 屏蔽词命中标题或作者 → 跳过；
4. 30 天去重（`video_id` + 归一化标题）；
5. 时效：有日期则按 `maxVideoAgeDays` 过滤；无日期则接受（推荐流新鲜度由算法保证）；
6. 均匀随机选一条，而不是只取第一条/最高赞（与现有 `chooseVideo` 一致）。

#### 4.4.4 记录与统计

- 新增 `sends.source`（`pool` / `recommend`），迁移 `ALTER TABLE sends ADD COLUMN source TEXT NOT NULL DEFAULT 'pool'`；旧记录默认 `pool`。
- `bucket`：池源仍写池名；推荐源写 `默认推荐`。
- 记录页可按来源筛选；首页「最常分类」能区分。
- `events` 增加 `source-picked` / `recommend-no-candidate` 等，方便排障。

#### 4.4.5 快速发送

- 你希望快速发送也走 API，所以推荐源必须先有 feed 取数方案（见 [4.4.6](#446-如果选片和发送都要走-api)）。
- 快速发送增加来源选择：`池 / 推荐`；两者都调用 API 发送。
- 推荐源在 feed API 未启用/失败时：**不要偷偷换池**；返回明确错误（或按账户配置回退），由用户决定。
- 如果短期内 feed API 未打通，可以暂时只允许池源走快速发送；推荐源只用于定时发送（浏览器兜底），并在按钮/提示里标注清楚。
- 多好友快速发送：现有行为是**同一条视频发给多个好友**。推荐源也保持这个语义；如果用户希望每人不同视频，需要另做（不在本次范围）。

#### 4.4.6 如果选片和发送都要走 API

先区分两件事：

- **发送**：现在 `sendVideo()` 已经是纯 HTTP（protobuf 模板 + cookies），不需要浏览器；
- **选片**：池搜索可以纯 HTTP（导出时捕获的 `searchUrl` + cookie 重放）；推荐 feed 的签名要求更高。

所以「都走 API」有四种落点：

| 方案 | 选片怎么做 | 发送 | 浏览器依赖 | 可行性/成本 | 建议 |
|---|---|---|---|---|---|
| **A. 浏览器只做取数** | 打开一次抖音首页，让页面自己发 `/tab/feed/`，通过 Playwright 网络事件捕获响应 JSON（不点卡片、不开分享面板）；或调用页面签名函数后再 fetch | 纯 HTTP | 需要一个浏览器进程/页面 | 高；约 1–2 天 | **推荐**：满足「发送走 API」，不重写签名，风险最低 |
| **B. 纯 HTTP 重放签名 URL** | 导出会话时捕获一条已签名的 feed URL，发送时重放 | 纯 HTTP | 无 | POC；签名带时间戳，可能几分钟就失效 | **先做 0.5 天 POC**；若有效期够长才可用 |
| **C. Node 复现签名** | 在 Node 里复现 `a_bogus` + secsdk 三件套 | 纯 HTTP | 无 | 低；3–5 天+，平台一改就坏 | 不作为第一版 |
| **D. 浏览器选片 + 浏览器分享** | 打开首页、抓 DOM、点卡片、分享 | 浏览器 | 有 | 高 | 与「都走 API」冲突；只作为兜底 |

如果「都走 API」的含义是**选片和发送都不能启动浏览器**：

- 只能走 B 或 C；B 需要 POC 证明「捕获的 feed URL 在真正发送的时刻仍然可用」，C 成本高且脆弱。
- **不要在没有 POC 前承诺「推荐源完全无浏览器」**。建议先抓一条 `/tab/feed/` 请求，分别在 1 分钟 / 5 分钟 / 30 分钟后重放，看是否还是 200；如果很快 403，B 不可行。
- 如果只是「发送走 API」，A 就够了：浏览器只负责取推荐 JSON，发送仍由 `apiSender` 完成，也不需要分享面板。

POC 还要确认：feed 响应里的 `aweme_list` 是否包含封面 `url_list`、`aweme_id`、`desc`、`author`、`statistics`、`create_time`——这些是 `apiSender.sendVideo()` 构造视频卡片所必需的字段。缺字段时要补详情接口或改用浏览器发卡片。



| 风险 | 说明 | 缓解 |
|---|---|---|
| 内容不可控 | 推荐流可能包含与预期无关/不合适的内容，直接发给好友 | 默认关闭；屏蔽词；只允许视频；先在测试账号观察；不要默认混合 |
| 个性化曝光 | 推荐流反映账号兴趣，发给好友等于暴露「你平时看什么」 | 产品文案提示；默认关闭 |
| 广告/直播/图文混入 | 过滤不严会分享错类型 | `aweme_type`/URL/文案三重过滤；测试用例覆盖 |
| DOM 改版 | 首页卡片结构和搜索页不同，选择器容易失效 | 用 `/video/<id>` 链接而不是标题匹配；错误分类 + 截图/日志 |
| 无发布时间 | 浏览器卡片可能没有发布时间，严格时效过滤会误杀 | 推荐源放宽；或用详情页/接口补 `create_time` |
| 重复推荐 | 同一条反复出现在推荐流 | 30 天去重；全部重复时按现有策略回退或跳过 |
| 自动播放/带宽 | 首页可能自动播放，长时间停留消耗带宽/触发风控 | 打开后尽快操作；发送后离开页面；POC 观察 |
| 纯 API 403 | feed 三件套签名 | 第一阶段不做纯 API 推荐；POC 再评估 |
| 快速发送语义混乱 | 「纯 API」按钮却要浏览器 | 按钮/提示明确来源和通道；或让快速发送保持池源 |

### 4.6 POC 清单（半天）

在真实登录的测试账户上，**不发送**，只做只读验证：

1. 用现有 browser-server 打开首页，执行候选提取器，确认能拿到 ≥10 个唯一 `aweme_id`，并截图；
2. 记录卡片 DOM：标题、作者、点赞、时长、发布时间是否存在；广告/直播/图文如何标记；
3. 直接 `goto https://www.douyin.com/video/<id>`，确认详情页能打开、`/openshare` 能找到 `video-player-share`；
4. 连续 5 次刷新首页，统计推荐重复率、主题分布、是否有广告/直播；
5. 捕获 `/aweme/v1/web/tab/feed/` 请求：带 cookie 重放，分别测试「只用 cookie」「用捕获的完整签名 URL」「去掉 secsdk 参数」，确认 200/403；
6. 对比池搜索：一次发送的页面加载数、耗时、命中率；
7. 结论：浏览器源是否可上线；纯 API 源是否值得继续。

### 4.7 验收标准与工作量

验收（浏览器源）：

- 账户 `videoSource=recommend` 时，连续 5 次发送都来自推荐流，且没有图文/直播/广告/屏蔽词命中；
- 30 天内不重复（候选足够时）；
- 记录里 `source=recommend`、`bucket=默认推荐`，可按来源筛选；
- 推荐源无候选时，明确失败/回退（按配置），不静默发池里的视频；
- `videoSource=pool` 时行为与现在完全一致；
- 纯 API 会话不可用时，推荐源仍能通过浏览器发送。

工作量：

| 子项 | 估时 |
|---|---|
| POC（DOM + 签名 + 页面流程） | 0.5 天 |
| 推荐提取器 + 选片 + 打开/分享 | 1–1.5 天 |
| 配置（账户级 videoSource + UI） | 0.5 天 |
| 记录/统计 + 迁移 | 0.5 天 |
| 测试 + 文档 | 0.5 天 |
| **浏览器源合计** | **约 2–3 天** |
| 推荐源走「浏览器取数 + API 发送」（方案 A） | +1–2 天 |
| 纯 API 重放 POC（方案 B） | +0.5 天；成功后 +1–2 天 |
| Node 复现签名（方案 C） | +3–5 天，且可能不可行 |

---

## 5. 实施顺序与版本建议

| 阶段 | 内容 | 依赖 | 建议版本 |
|---|---|---|---|
| 0 | 推荐 feed 取数/签名 POC（方案 A/B） | 无 | 0.25.x，先做 |
| 1 | 账户级配置（隔离 + 迁移 + 调度重读/暂停） | 无 | 0.25.0 |
| 2 | 配置页简化（总数 + 时段随机分配、预设、复制） | 1 | 0.25.x |
| 3 | 推荐源（API 优先；浏览器取数/选片兜底） | 0、1 | 0.26.0 |
| 4 | 数据库模式（若批准：PG 先行，MySQL 后置） | 1、发送幂等（P0-3） | 单独大版本，如 1.0 / 0.27+ |
| 5 | AI 运维助手 + 自然语言配置（旁路，不碰发送） | 1 | 0.25.x |
| 6 | 推荐源 AI 筛选/去重（`aiMode`，默认关闭） | 3 | 与 3 同版或 0.26.x |

> AI 的详细场景、架构、护栏与成本见 [ai-integration.md](ai-integration.md)。AI 不解决纯 API 推荐的签名问题。

理由：

- 需求 1 是需求 3 的配置基础（`videoSource` 必须账户级），也顺带修掉「保存不生效/暂停不生效」。
- 需求 3 的 feed POC 决定「都走 API」能做到什么程度；先做 0.5 天 POC，再承诺 API 选片。
- 需求 2 跨层最多、风险最高，应与功能需求解耦，单独排期和回归。
- AI 助手不依赖推荐源，可以先做；AI 选片等推荐源和 POC 结论。

---

## 6. 决策状态与待确认

**已确认（2026-11-25）**

- 数据库默认仍是 SQLite；后续提供 MySQL/PG 连接信息。
- 默认推荐关闭；需要时使用抖音推荐视频。
- 简化到「总数量 + 时段」，后台随机分配。
- 快速发送与定时发送都走 API。

**仍需确认**

1. **「都走 API」的边界**：允许浏览器只做取数/签名（方案 A），还是要求完全不启动浏览器（方案 B/C）？这决定推荐源能否近期交付。
2. **推荐源兜底**：如果纯 API 重放 POC 失败，是否接受「浏览器取数 + API 发送」或「浏览器选片 + 浏览器分享」作为兜底？
3. **每天条数**：固定 N，还是 N~M 范围？N=0 是暂停当天，还是非法值？
4. **推荐源时效**：浏览器卡片没有发布时间时，接受它（推荐流天然新鲜）还是必须补到日期才发？
5. **数据库**：MySQL 还是 PostgreSQL？部署形态是单机、NAS 还是多人多机？是否接受 SQLite 默认 + 可选后端？连接信息请放在本机 `data/` 下 0600 文件或环境变量，**不要粘贴到聊天记录/提交到仓库**。
6. **配置生效**：保存后只影响后续发送、当天计划需手动「重排今日」，是否可接受？

---

## 7. 与现有优化计划的对应关系

| 本次需求 | 优化计划条目 | 关系 |
|---|---|---|
| 每账户独立配置 | [P1-1](optimization-plan.md#L122-L136) | 本次给出具体 schema/迁移/键位和简化方案；建议提前到 0.25.0 |
| 保存/暂停即时生效 | [P0-1](optimization-plan.md#L46-L70) | 需求 1 的验收会依赖它；至少做「每时段重读 + 可中断 sleep」 |
| 远程数据库重复发送风险 | [P0-3](optimization-plan.md#L96-L118) | 接 MySQL/PG 前必须完成幂等键 |
| 推荐视频预览/换一条 | [P2-1](optimization-plan.md#L252-L257) | 推荐源上线后更需要「预览/换一条」，可复用候选结构 |
| 互关好友与账户好友统一 | [P2-2](optimization-plan.md#L259-L265) | 配置简化时把好友管理收口到账户页，与此一致 |
| 多账户健康总览 | [P2-4](optimization-plan.md#L274-L278) | 账户级配置后，总览应显示每个账户的来源/配置摘要 |
| 面板 token / 远程访问 | [P2-6](optimization-plan.md#L287-L292) | 如果需求 2 的真实动机是远程查看，优先做这个 + 导出，而不是换 DB |
| 错误分类/通知 | [P1-3](optimization-plan.md#L166-L184) | 推荐源 DOM 失败、feed 403 都需要明确错误码，不能静默成 no candidate |

---

## 8. 外部参考（需实测复核）

以下为外部资料，用于判断「默认推荐」接口的可行性；本项目仍应在自己的登录态下用 POC 验证：

- 抖音 Web 首页推荐端点 `/aweme/v1/web/tab/feed/`、`aweme_list` / `has_more` / `refresh_index`：
  - [Douyin_TikTok_Download_API endpoints.py](https://raw.githubusercontent.com/Evil0ctal/Douyin_TikTok_Download_API/main/src/dtk/platforms/douyin/endpoints.py#1)
  - [TikHub fetch_home_feed 文档](https://github.com/aisa-team/docs/blob/cc379277c56982ec6233ce3c8c0b7d998e8f6982/zh/api-reference/tikhub/post_tikhub-douyin-web-fetch_home_feed.mdx)
- feed 需要 `a_bogus` + `timestamp` + `x-secsdk-web-signature` 三件套：
  - [抖音 Web 签名体系逆向结论（2026-06）](https://raw.githubusercontent.com/mafqla/douyin-api/main/docs/sign_reverse_findings.md#1)
- 本项目自己的只读接口 POC 结论（搜索可 cookie 重放）：
  - [docs/api-poc.md](api-poc.md#L16-L20)

> 外部结论只作为风险提示，不作为实现依据；以 POC 中真实账号的 200/403 结果为准。
