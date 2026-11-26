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

1. `scheduler.runLoop` 始终走 `runSchedule`：`src/schedule.js` 读取 `account_settings.schedulePoints`（没有就按 0.27 及以前的时间点/时段/总数转换），`src/burst.js` 管理每个触发点的固定/范围内随机时刻、条数、秒级间隔与当天状态；进度存 `account_settings.burstState`，间隔不短于上一条视频时长；
2. 纯 API 源（池搜索 / 推荐 feed）直接 HTTP 选片+发送；候选先按时效、屏蔽词、已开启的互动指标（点赞/评论/收藏/转发）过滤，再交给 AI 和随机选片；只有池源需要浏览器兜底时才在到点前 3 分钟拉起 `browser-server`；
3. 浏览器路径由 `picker.pick` 通过 HTTP 让浏览器扫池子拿候选；推荐源不会走浏览器；
4. `picker.open` 打开视频,`/openshare` 打开分享面板;`/send` 按昵称+userid 精确命中好友并点击;
5. 结果写 `sends`（含 `source`），当天触发进度写 `account_settings.burstState`，过程写 `events`；AI 只记录 `ai-rank` / `ai-fallback`。

## 扩展点

| 想加的东西 | 改哪里 | 注意 |
|---|---|---|
| 新的选片池 | `pools` 表 / `src/pools.js` 种子 | 面板的勾选框自动出现 |
| 新的触发/节奏策略 | `src/burst.js`（纯状态机）/ `src/schedule.js`（配置读取与迁移） | 保持纯函数,补单测 |
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
POST /send   {name,confirm}      → confirm=false 只定位不点
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
| 纯 API 会话过期 | 到期前 2 小时自动导出刷新；导出前关闭占用 profile 的 browser-server，启动时清理遗留进程；失败 10 分钟后重试 |
| 人机验证 | 记 `captcha-blocked`,停止当天尝试,等人工处理 |
| 服务崩溃 | launchd/systemd 重启;数据库状态决定从哪继续 |

## 测试策略

- `planner.test.js` — 纯函数边界(区间、上下限、自动放宽)
- `db.test.js` — 迁移、repos 往返、幂等
- `importer.test.js` — 旧数据导入的幂等与保护(不覆盖正在执行的当日计划)
- `picker.test.js` — 用本地 fixture 页面验证选择器,不访问抖音
- `verify.js` — 跨层冒烟:环境 + 表结构 + 排班 + HTTP 接口
