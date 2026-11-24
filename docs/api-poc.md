# API 直连可行性验证（POC，2026-11-24）

问题：能不能不驱动浏览器，直接用 Node 调抖音的接口完成「选片 + 发给好友」？

**结论：只读部分可行，发送部分不可行（至少不划算）。**

## 实测结果

用已登录的 Chrome profile 采集了 `/aweme/v1/web/*` 的 53 个 XHR/fetch 请求，
再用 Node（无浏览器）带 cookie 重放：

| 端点 | 重放结果 |
|---|---|
| `/aweme/v1/web/user/profile/self/` | ✅ 200，登录态识别正常 |
| `/aweme/v1/web/hot/search/list/` | ✅ 200，70KB 热榜数据 |
| `/aweme/v1/web/general/search/single/` | ✅ 200，**711KB 搜索结果**（选片就靠这个） |
| `/aweme/v1/web/multicast/query/`、`social/count` | ✅ 200，需 cookie |
| 无副作用 POST（`page/turn/offline` 等） | ✅ 200 |
| 去掉 cookie 的对照组 | ❌ `status_code 8 / 2483`、"用户未登录"、`blocked` |

细节：

- 采集到的请求普遍带 `a_bogus`、`msToken` 等风控参数；但**部分只读 GET 去掉签名参数仍然成功**，
  说明这些接口主要靠登录 cookie 鉴权，签名不是唯一门槛；
- 会话 cookie 仍是关键凭据，没有它会被风控直接拒绝。

## 为什么「发送给好友」不行

- 在分享面板里点击好友时，HTTP 只出现 `im_communication/share_report`（埋点，已拦截），
  **没有对应的发送 POST**，但界面提示「分享成功」；
- 同时页面维持着 `frontier-im.douyin.com/ws/v2`、`frontier-pc.douyin.com/ws/v2`、
  `bytelink100-ws.douyin.com` 等 WebSocket 连接，帧是二进制（类似 protobuf），
  需要 `access_key` / `device_id` / 签名等会话参数。

也就是说：**抖音的 IM 发送走 WebSocket，不是 REST**。要直连发送就得逆向整套 WS 协议、
心跳、二进制帧编码和签名，维护成本高、版本一变就失效，账号风控风险也更大。

> 透明说明：验证时因为发送走 WebSocket，HTTP 层拦截没有挡住，实际向好友发出了一条视频。
> 这是应用本身每天在做的动作，但本次不是计划内的发送，特此记录。

## 建议

1. **保持浏览器负责登录与发送**（自带 Chromium 版已经解决「不依赖系统 Chrome」）；
2. 可以考虑混合模式：**用只读 API 选片**（`general/search/single` 一次请求拿到结构化列表），
   浏览器只在最终分享时打开——能减少搜索页加载次数，降低触发人机验证的概率、也更快；
3. 不要为了省一个浏览器进程去逆向 IM WebSocket：不稳定、容易被风控、属于平台条款限制的自动化访问。

## 复现方式

```bash
# 1) 采集（需要已登录的 Chrome profile，会打开一个最小化的浏览器）
node scripts/poc-api-probe.js --profile <profile-dir> --out /tmp/api-poc --friend <好友名>
# 2) 重放（只重放只读接口与无副作用埋点，不会发送消息）
node scripts/poc-api-replay.js --in /tmp/api-poc
```

注意：

- `/tmp/api-poc` 里包含 cookie/签名，属于登录凭据，**不要提交、用完删除**；
- 仅用于低频只读验证，不要用于批量操作；
- 平台风控对「无浏览器环境的高频请求」更敏感。
