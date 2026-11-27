# 架构说明

这份文档写给"以后要加功能的人"(包括几个月后的我自己)。

## 分层

```
┌───────────────────────────────────────────────────────────┐
│ 入口            src/index.js  (CLI: init/verify/account/…) │
├───────────────────────────────────────────────────────────┤
│ 视图与控制      src/dashboard.js + src/page.html           │
│                 src/service.js (launchd/systemd 封装)      │
├───────────────────────────────────────────────────────────┤
│ 调度            src/scheduler.js                           │
│                 └─ 读配置 → 排班 → 调浏览器 → 回写结果     │
├───────────────────────────────────────────────────────────┤
│ 选片/浏览器     src/picker.js + src/browser-server.js      │
│                 纯 HTTP 契约,可独立进程运行                │
├───────────────────────────────────────────────────────────┤
│ 领域逻辑        src/planner.js (纯函数,零 IO)              │
├───────────────────────────────────────────────────────────┤
│ AI(旁路)        src/ai/client|ranker|assistant              │
│                 仅推荐源筛选/只读问诊，默认关闭                 │
├───────────────────────────────────────────────────────────┤
│ 数据            src/repos.js (全部 SQL) → src/db.js         │
│                 schema/*.sql (SQLite 编号迁移)               │
│                 src/db-worker.js + external-schema.js       │
│                 (可选 MySQL/PostgreSQL，单机同步门面)          │
└───────────────────────────────────────────────────────────┘
```

**依赖方向只能从上往下**。`planner` 不知道数据库,`repos` 不知道 HTTP,`dashboard` 不直接写 SQL。
这样加功能时,新增的东西一般只停在一到两层,不会牵一发动全身。

## 数据流

一次发送:

1. `scheduler.runLoop` 正常情况下走 `runSchedule`：`src/schedule.js` 读取 `account_settings.schedulePoints`（没有就按 0.27 及以前的时间点/时段/总数转换），`src/burst.js` 管理每个触发点的固定/范围内随机时刻、条数、秒级间隔与当天状态；进度存 `account_settings.burstState`，间隔不短于上一条视频时长；如果 `slowMailState` 是 live，则改走 `runSlowMail`（见下）；
2. 纯 API 源（池搜索 / 推荐 feed）直接 HTTP 选片+发送；候选先按时效、屏蔽词、已开启的互动指标（点赞/评论/收藏/转发）过滤，再交给 AI 和随机选片；只有池源需要浏览器兜底时才在到点前 3 分钟拉起 `browser-server`；
3. 浏览器路径由 `picker.pick` 通过 HTTP 让浏览器扫池子拿候选；推荐源不会走浏览器；
4. `picker.open` 打开视频,`/openshare` 打开分享面板;`/send` 优先按 `data-userid`（与 `friends.userid` 对应）命中好友，没有 UID 的旧好友才回退昵称匹配;
5. 结果写 `sends`（含 `source`），当天触发进度写 `account_settings.burstState`，过程写 `events`；AI 只记录 `ai-rank` / `ai-fallback`。

## 独立自动已读

`src/auto-read.js` 是排班/慢递之外的第三条已读链路：

- 每账户设置 `autoReadEnabled`、`autoReadFriends[]`、`autoReadMinMin` / `autoReadMaxMin`、固定时段 `autoReadWindow*`、`autoReadOutside`；
- scheduler 子进程每 5 秒轮询一次，只在 `autoReadState.nextAt` 到期时进行检查；账户暂停、排班 loop 等待时也继续；
- 下一次时间：无固定时段时在 [min,max] 分钟内随机；固定时段内按固定频率；时段外随机或暂停到下个时段；
- 每个好友首次通过 `conversation/create` 模板换取 conversationId/shortId，缓存在 `autoReadState.friends[]`；
- 到点后逐位调用 `v3/conversation/mark_read`，成功/失败写入每位好友的结果和 `auto-read` / `auto-read-fail` 事件；
- 不检测消息内容、不读消息正文；好友端收到服务器的已读状态后显示「已读」。

## 好友身份与同步

`friends.userid` 是好友的稳定身份，`friends.name` 只做展示。所有发送路径都把 UID 往下传：

- 纯 API：`apiAttempt` 把 `toUserId` 传给 `apiSender.sendVideo`，用 `conversation/create` 模板建会话；
- 浏览器：`scheduler.sendOneBrowser` 把 `{name, userid}` 一起传给 `browser-server /send`，按 `data-userid` 命中；传了 UID 但找不到时不降级到昵称匹配，没有 UID 的旧好友才按昵称；
- 首页好友管理：发送好友卡管理启用/停用/删除，好友关系 tab 的「添加」把 `{name, userid}` 写入 `friends`；
- 慢递：状态里同时存 `friend` 和 `friendUid`，调度器按 UID 找当前好友行；
- 纯 API 会话：`apiSession.canSendToUid` 按会话好友的 `userid` 判断，不依赖昵称。

互关同步在 `dashboard.syncMutualFriends`：通过已登录页面的 web API 读取
`following/list` 与 `follower/list`，按 UID 去重、取交集；`syncFriendNamesFromMutual`
按 UID 更新已有好友的昵称、给只有昵称的旧好友补 UID，不会自动新增或启用好友。
默认每 6 小时由 dashboard 定时器同步一次；失败退避 1 小时。

## 慢递

慢递是独立于每日触发计划的一条临时 lane，不占用 `burstState` 的 sent/total：

1. 面板 `POST /api/slow/start` 写 `account_settings.slowMailState`（`pending`），调度器在 ≤3 秒内接手；
2. `scheduler.runSlowMail` 先把窗口内会到点的日常触发点标记为 `skipped`（reason=`slow-mail`），再固定收件人；
3. 首条立即发；后续 `gap = max(随机(min,max), 上一条视频时长 + 5s)`，下一次落点超过 `endsAt` 就收束；
4. 暂停账户时冻结倒计时，恢复顺延；重启/睡眠迟到超过 2 分钟不补发，重新抽间隔；验证码/会话失效/好友删除立即停；
5. 发送仍走 `sendOne`，因此选片、去重、AI、互动门槛、好友 UID 校验全部复用；慢递期间手动发送和计划重置返回 409；
6. 勾选「顺便已读」时，发送结果里的 `conversationId` / `conversationShortId` 会写进慢递状态，发送后立即、之后每 45 秒调用 `src/api-read.js` 的纯 HTTP `v3/conversation/mark_read`；失败只记 `slow-read-fail`，不阻断发送。

纯函数在 `src/slow-mail.js`（无 IO，单测覆盖），调度器只负责等待、调用 `sendOne` / 已读和落库。

## 扩展点

| 想加的东西 | 改哪里 | 注意 |
|---|---|---|
| 新的选片池 | `pools` 表 / `src/pools.js` 种子 | 面板的勾选框自动出现 |
| 新的触发/节奏策略 | `src/burst.js`（纯状态机）/ `src/schedule.js`（配置读取与迁移） | 保持纯函数,补单测 |
| 临时长会话（慢递） | `src/slow-mail.js` + `scheduler.runSlowMail` + `/api/slow` | 状态独立于 `burstState`；发送仍走 `sendOne` |
| 好友身份 / 互关同步 | `repos.upsertFriendByUid` + `dashboard.syncMutualFriends` | UID 是键，昵称只展示；不自动新增/启用好友 |
| 新的发送渠道(非抖音) | 新增 `src/<channel>-server.js`,让 `scheduler.sendOne` 走同一契约 | 契约见下 |
| 新的面板区块 | `src/dashboard.js` 加只读接口 + `page.html` | 写操作集中在 `/api/control` |
| 新的持久化字段 | 新增 `schema/00N_*.sql` + `external-schema.js` | 不要改已应用的迁移；外部库要同步最终 schema |
| 新的 AI 能力 | `src/ai/` + `/api/ai/*` | AI 默认关闭；不能进发送主链路，失败必须回退 |
| 新的数据库后端 | `src/db.js` + `src/db-worker.js` + `db-config.js` | SQLite 仍是默认；外部后端需真实实例联调 |

## browser-server 的 HTTP 契约

```
GET  /state                      → {url,title,loggedIn,challenge}
POST /goto   {url}               → 导航
POST /click  {x,y}               → 真实鼠标点击
POST /eval   {js}                → 在页面里求值
POST /openshare                  → 打开分享面板,返回好友列表
POST /send   {name,userid,confirm} → 优先按 data-userid 命中；没有 userid 的旧好友才按 name
POST /quit                       → 关闭浏览器并退出
```

换一个平台或多开账号,只要这个契约不变,`scheduler` 和 `picker` 都不用动。

## 失败模型

| 失败 | 处理 |
|---|---|
| 单条发送失败 | 同一触发点内重试 1 次(间隔 15s),仍失败只中止该触发点；后续触发点照常 |
| 触发点错过 | 晚于该点触发时刻 30 分钟记 `schedule-trigger-skipped`(late-start) 只跳过该点 |
| 触发点中途停机过久 | 晚于该点下一条 10 分钟记 `schedule-trigger-skipped`(late-resume) 只跳过该点剩余条数 |
| 单个触发点失败 | 记 `schedule-trigger-aborted`,后面的触发点照常 |
| 候选视频全部已发送 | 严格去重：记 `dedup-exhausted`，中止/跳过该触发点，不回退重发 |
| 慢递单条失败 | 15s 重试 1 次；仍失败记 `slow-fail`，按 `max(下限, 2min)` 退避；连续 3 轮 `blocked` |
| 慢递候选耗尽 | 连续 2 轮 `no-fresh-candidate` 记 `slow-exhausted`，保留已发条数 |
| 慢递顺便已读失败 | 记 `slow-read-fail`（10 分钟节流），卡片显示「已读失败」，不影响发送/收束 |
| 互关同步失败 | 记 `mutual-sync-error`，退避 1 小时；不影响发送，面板显示上次缓存 |
| 纯 API 会话过期 | 到期前 2 小时自动导出刷新；导出前关闭占用 profile 的 browser-server，启动时清理遗留进程；失败 10 分钟后重试 |
| 人机验证 | 记 `captcha-blocked`,停止当天尝试,等人工处理 |
| 服务崩溃 | launchd/systemd 重启;数据库状态决定从哪继续 |

## 测试策略

- `planner.test.js` — 纯函数边界(区间、上下限、自动放宽)
- `db.test.js` — 迁移、repos 往返、幂等
- `importer.test.js` — 旧数据导入的幂等与保护(不覆盖正在执行的当日计划)
- `picker.test.js` — 用本地 fixture 页面验证选择器,不访问抖音
- `slow-mail.test.js` / `scheduler-slow.test.js` — 慢递纯状态机与会话端到端（假 send/时钟、假已读）
- `dashboard-slow.test.js` — `/api/slow` 预检、启动/停止、手动发送互斥、已读开关持久化
- `api-read.test.js` — 本地 HTTP 服务验证 mark_read 模板的目标/索引/cookie
- `friend-uid.test.js` — 好友 UID upsert、按 UID 改名/补 UID、冲突、按 UID 判断会话可发
- `mutual-sync.test.js` — 用假的 browser `/state`/`/eval` 验证互关缓存与按 UID 改名
- `verify.js` — 跨层冒烟:环境 + 表结构 + 排班 + HTTP 接口
