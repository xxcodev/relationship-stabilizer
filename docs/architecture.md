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
│ 数据            src/repos.js (全部 SQL) → src/db.js         │
│                 schema/*.sql (编号迁移)                     │
└───────────────────────────────────────────────────────────┘
```

**依赖方向只能从上往下**。`planner` 不知道数据库,`repos` 不知道 HTTP,`dashboard` 不直接写 SQL。
这样加功能时,新增的东西一般只停在一到两层,不会牵一发动全身。

## 数据流

一次发送:

1. `scheduler.runDay` 从 `plans` 取当天计划(没有就 `planner.planDay` 生成并落库);
2. 到点前 3 分钟 `startServer` 拉起 `browser-server`(独立 node 进程,持有 Playwright);
3. `picker.pick` 通过 HTTP 让浏览器随机扫若干池子,拿回候选;
4. `picker.open` 打开视频,`/openshare` 打开分享面板;
5. `/send` 按昵称+userid 精确命中好友并点击;
6. 结果写 `sends`,计划状态写 `plans`,过程写 `events`。

## 扩展点

| 想加的东西 | 改哪里 | 注意 |
|---|---|---|
| 新的选片池 | `pools` 表 / `src/pools.js` 种子 | 面板的勾选框自动出现 |
| 新的时间策略 | `src/planner.js` | 保持纯函数,补单测 |
| 新的发送渠道(非抖音) | 新增 `src/<channel>-server.js`,让 `scheduler.sendOne` 走同一契约 | 契约见下 |
| 新的面板区块 | `src/dashboard.js` 加只读接口 + `page.html` | 写操作集中在 `/api/control` |
| 新的持久化字段 | 新增 `schema/00N_*.sql` | 不要改已应用的迁移 |

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
| 单条发送失败 | 同一时刻重试 1 次(间隔 90s),再失败记 `failed` 跳过 |
| 整日唤醒过晚 | 距窗口结束 ≥45 分钟就从当前时刻续排,否则跳过当天 |
| 机器睡过某些时刻 | 超过 25 分钟的时刻记 `slot-missed` 跳过,不补发 |
| 人机验证 | 记 `captcha-blocked`,停止当天尝试,等人工处理 |
| 服务崩溃 | launchd/systemd 重启;数据库状态决定从哪继续 |

## 测试策略

- `planner.test.js` — 纯函数边界(区间、上下限、自动放宽)
- `db.test.js` — 迁移、repos 往返、幂等
- `importer.test.js` — 旧数据导入的幂等与保护(不覆盖正在执行的当日计划)
- `picker.test.js` — 用本地 fixture 页面验证选择器,不访问抖音
- `verify.js` — 跨层冒烟:环境 + 表结构 + 排班 + HTTP 接口
