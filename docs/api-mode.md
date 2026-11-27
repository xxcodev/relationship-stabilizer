# 纯 API 发送模式（实验）

> 0.11.0 起可用。默认 `sendMode = auto`：**优先走纯 HTTP 发送，失败自动回退到浏览器**。
> 原理与验证过程见 [api-poc.md](api-poc.md)。

## 它解决什么

以前每次发送都要启动一个真实 Chrome：即使窗口被最小化，也有进程、profile 锁和页面加载成本。
纯 API 模式下，**发送与选片都不需要浏览器**：

```
浏览器（仅导出会话时用一次）
   → data/api-session.json（cookies + 一条发送模板）
   → 只读搜索接口选片
   → POST imapi.douyin.com/v1/message/send（protobuf 模板 + cookies）
```

导出会话时浏览器会走一次「搜索 → 打开视频 → 分享面板 → 点好友」，但**发送请求会被捕获并中断**，
不会真的发出消息。

## 用法

### 1. 导出会话（需要登录态）

应用里：托盘菜单 →「纯 API（实验）」→「导出/刷新纯 API 会话…」（会先弹确认框）。

或命令行：

```bash
node src/index.js api:export            # 默认用第一个启用的视频池关键词
node src/index.js api:export --keyword 搞笑
```

要求：

- 账号已配置好友（`accounts.friend`），且浏览器已登录（没登录会失败，先在面板/应用里扫码）；
- 导出期间不要有正在运行的抖音画面/发送任务（会提示端口占用）；
- 建议在非发送时段操作。

### 2. 开关

默认就是 `auto`。命令行切换：

```bash
node src/index.js api:mode auto      # 纯 API 优先，失败回退浏览器（默认）
node src/index.js api:mode browser   # 关闭，完全走旧浏览器流程
```

应用里：托盘 →「纯 API（实验）」→「纯 API 优先」勾选框。切换后会自动重启调度子进程，
让时段循环立即读到新配置。

### 3. 状态与清理

```bash
node src/index.js api:status   # 会话是否可用、年龄、账号/好友、模板大小、cookies 数
node src/index.js api:send --dry   # 用 API 选一条视频但不发送
node src/index.js api:send         # 真实发送一条（会测试整条 API 链路）
node src/index.js api:clear        # 删除会话文件
```

应用托盘 →「纯 API（实验）」→「纯 API 会话状态…」可以看到同样的信息。

## 任意好友（不再重新导模板）

导出会话时会额外保存：

- 分享面板里的**最近好友列表**（昵称 + 数字 userid）；
- 一条 `POST imapi.douyin.com/v2/conversation/create` 请求模板。

发送给非默认好友时，应用会先用该模板创建/获取会话（替换目标 userid），再复用同一条发送模板，
**不需要为新好友重新导出**：

```bash
node src/index.js api:friends                         # 看账户好友 + 捕获好友
node src/index.js api:send --friend "🖐🏻" --dry       # 只选片
node src/index.js api:send --friends "Hime,🖐🏻"       # 一次发给多个好友
```

脚本按账户使用 `data/api-sessions/<account>.json`；旧版单文件 `data/api-session.json` 会自动迁移。

限制：好友必须在导出时捕获的最近好友列表里，或在已同步的互关好友缓存里（带 userid）。
都不在时会明确报错并回退浏览器；想更新捕获列表，在导出前先和对方在抖音里聊一句再重新导出会话；
互关 / 关注 / 粉丝可在首页「好友关系」里点「同步关注 / 粉丝」单独更新，不需要出现在会话捕获里。

### 独立自动已读接口

- `GET /api/auto-read`：当前账户配置、可选好友、最近状态和 API 会话；
- `POST /api/auto-read`：保存 `{enabled, friends:[{uid,name}], minMin, maxMin, windowEnabled, windowStart, windowEnd, windowIntervalMin, outside}`；
- `POST /api/auto-read/now`：立即检查全部已选好友（即使开关关闭，用于测试），并重置下一次时间。

实际定时由 scheduler 子进程的 5 秒轮询 + `nextAt` 执行，不依赖 `/api/slow` 或排班配置。

### 选片随机、时效与去重

每个视频池有基础关键词和 3 个同类变体（例如 `韩剧 / 韩剧推荐 / 韩剧解说 / 韩剧混剪`），
每次发送随机选一个，跑完再从该关键词搜索第一页的全部有效候选里随机，不再只取高赞前 8 条。
搜索会带「最新发布」排序和 `publish_time` 过滤，默认只保留最近 **7 天**发布的视频（配置范围 1-30 天）；
API 用 `create_time` 精确校验，浏览器从卡片相对时间（3天前/昨天/日期）解析校验，过期视频不会发送。

发送前还会读取最近 30 天成功发送的 `video_id` 和标题，优先跳过已发过的视频；
只有全部候选都重复时才回退，不会因为去重直接失败。浏览器选片同样使用池关键词、全部抓取卡片和这套规则。

## 视频来源：默认推荐（纯 HTTP，零浏览器）

账户配置里的「视频来源」可以选 **视频池搜索** 或 **抖音默认推荐（纯 API）**，默认是池搜索。

推荐源的工作方式：

1. 导出纯 API 会话时，browser-server 打开首页，然后**点击顶部「推荐」tab**（直接打开 `/` 或
   `?recommend=1` 都可能被跳到 `/jingxuan` 精选页），等待并滚动，捕获
   `GET /aweme/v1/web/tab/feed/`；同时兼容 `POST /aweme/v2/web/module/feed/` 作为兜底
   （连同站点自己的签名参数/请求头/POST body），存进 `session.feedUrl` 等字段；
2. 发送时用 cookies **原样重放**这条 URL（v1 用 GET，v2 用 POST + 原 body），解析 `aweme_list`；
3. 过滤直播、图文、广告、屏蔽词、30 天重复；推荐流使用独立的「推荐流最多几天前」（默认 30 天，
   0=不限），**不套用池搜索的 2/7 天时效**；再随机选一条；
4. 用现有的 `imapi.douyin.com/v1/message/send` 模板发送视频卡片。

> 2026-11-25 真实账号 POC：
> - `/jingxuan` 精选页使用 `POST /aweme/v2/web/module/feed/`（`module_id=3003101`），它的内容可能偏某个垂类；
> - 真正的「推荐」tab 是 `GET /aweme/v1/web/tab/feed/`，导出现在会点击该 tab 并优先使用它；
> - v2 feed 曾稳定重放 0/5/10/22/30 分钟（30 分钟时 20 条原始、6 条候选）；v1 推荐 feed 单次返回较少
>   （实测 4 条原始、2 条候选），内容会随账号兴趣变化，不保证全是某个垂类；
> - 推荐流原始候选可含 0.4–85 天前的常青内容，所以独立时效默认 30 天是必要的。

推荐源**不会启动浏览器**。但 feed URL 带时间戳/平台签名，有效期通常比会话短；如果重放返回
403 / `status_code` 非 0，会明确报错「推荐 feed 请求失败…签名可能已过期，请重新导出会话」。
这不是程序 bug，需要重新导出会话刷新 feed URL。想先验证当前会话：

```bash
node src/index.js api:feed          # 只读：打印 feed 候选数量和前 5 条
```

会话导出结果里的 `hasFeedUrl` / 面板「纯 API 会话」区块会显示是否捕获到 feed。

> 纯 API 推荐依赖抖音网页的签名参数，属于未公开接口；接口/签名一变就会失效，
> 所以保留「视频池搜索」作为默认和回退来源。推荐源只建议在自己的测试账号上先观察。
>
> 实测匿名请求 `/tab/feed/` 会返回 **HTTP 200 + 0 字节**，不是可直接调用的公开接口；
> 必须使用导出时捕获的签名 URL（连同 cookies）。`api:feed` 遇到空响应会明确提示
> 「可能需要登录，或签名/会话已过期」。
>
> 导出时会先预热首页并滚动，再进入搜索；feed 匹配不限于 `tab/feed`，也覆盖
> `/aweme/v1/web/.../feed` 和 `recommend` 端点。若仍未捕获，面板会显示脱敏的
> `feedPaths`（最近相关请求路径），事件记录 `feed-capture-missing`；这通常意味着
> 首页停在登录/验证页，或接口改版。

## 会话自动刷新

默认开启。应用启动后每 5 分钟检查一次会话：

- 距离过期不足 **2 小时**（`API_REFRESH_BEFORE_HOURS` 可调）或已过期时，后台自动执行一次导出
  （短暂启动最小化浏览器，**不发送消息**），并通过系统通知告知结果；
- 如果浏览器正在使用（发送回退/抖音画面），本轮跳过；
- 自动刷新失败后 30 分钟内不重试，避免反复拉起浏览器；
- 开关位置：托盘「纯 API（实验）」→「自动刷新会话」；面板「纯 API 发送」区块也可以切换。
- 每个账户的会话独立检查、分别刷新。

## 面板里查看状态

面板新增「⚡ 纯 API 发送」区块，显示：

- 当前发送模式（纯 API 优先 / 仅浏览器）、自动刷新开关；
- 会话是否可用、不可用原因、抓取时间/年龄、有效期；
- 账号/好友、模板大小、cookies 数、捕获好友数、是否支持任意好友；
- 按钮：导出/刷新会话、切换自动刷新、切换到纯 API 优先、仅浏览器。

对应接口：`GET /api/api-session`、`POST /api/api-session/refresh`、
`POST /api/api-session/mode {mode}`、`POST /api/api-session/auto-refresh {enabled}`。

## 回退与失败处理

`sendMode=auto` 时，调度器每次发送会：

1. 读取 `data/api-session.json`，校验：模板/cookies 存在、好友一致、未超过有效期（默认 12h，
   `API_SESSION_MAX_HOURS` 可调）；
2. 通过只读搜索接口选片 → 构造 protobuf → HTTP 发送；
3. 成功则写 `sends` 记录（`toast = HTTP API`）和 `sent-api` 事件，**不启动浏览器**；
4. 任一步失败（会话过期、接口拒绝、网络错误）→ 写事件 `api-session-invalid` /
   `api-send-rejected` / `api-send-error`，然后**回退到原来的浏览器流程**，保证当天排班不受影响。

> 回退策略的取舍：明确失败（服务端返回非 0）时回退是安全的；网络超时这类“不确定请求是否到达”
> 的情况也可能回退，理论上有极小概率重复发送一条，换取“不漏发”。

## 安全注意

- `data/api-session.json` 含登录 cookie 和会话 ticket：文件权限 0600、位于 gitignore 的 `data/`，
  **不要提交、不要分享**；
- 会话有时效：模板里的 ticket/identity token 会过期，过期后 `api:status` 会显示不可用，
  重新导出即可；
- 纯 HTTP 请求没有浏览器指纹，平台风控对高频更敏感：保持低频、和真实使用强度一致；
- 属于未公开接口自动化，和现有浏览器自动化一样处于灰色地带，只建议在自己的账号上使用。

## 已知限制

- 模板绑定**一个好友**（导出时账号的 friend）；换好友需要重新导出（或后续实现 conversation create）；
- 默认 12 小时有效期，需要周期性刷新（导出时要短暂开一次浏览器）；
- 发送记录没有截图（API 模式 `shot = null`），事件里会记录服务端 message id；
- 只读选片使用的是导出时捕获的搜索接口模板，如果抖音调整接口参数，重新导出即可。
