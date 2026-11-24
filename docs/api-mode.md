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
