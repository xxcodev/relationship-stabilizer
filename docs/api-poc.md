# API 直连验证（POC）

> 2026-11-24。结论：**只读接口和「发给好友」都可以脱离浏览器，用纯 Node + HTTP 完成**。
> 验证过程中的流量/凭据只落在 `/tmp`，已删除；仓库里只有脚本和结论。

## 一、结论

| 能力 | 是否需要浏览器 | 说明 |
|---|---|---|
| 登录 | 需要一次 | 扫码后把 cookie / 会话凭据导出，后续可纯 HTTP |
| 选片 / 搜索 / 热榜 / 个人资料 | ❌ 不需要 | 带 cookie 直接 GET `/aweme/v1/web/...`，实测可重放 |
| 发给好友（视频卡片） | ❌ 不需要 | `POST https://imapi.douyin.com/v1/message/send`，`application/x-protobuf` |

实测结果（纯 Node，无浏览器进程）：

- 只读接口：搜索（`general/search/single`，711KB 数据）、热榜、个人资料等带 cookie 重放成功；
  去掉 cookie 会被拒绝（`status_code 8 / 2483` / `blocked`）；
- 发送接口：**HTTP 200 + `status_code: 0`**，服务端返回了分配的 message id；
- 对照组：去掉 `bd-ticket-guard-*` 请求头仍成功；去掉 URL 上的 `a_bogus` / `msToken` 仍成功——
  至少在当前会话下，鉴权主要靠 cookie，加上请求体里携带的 ticket / identity token。

> 早期探索曾以为「发送走 WebSocket、无法 HTTP 直连」，那是一次误判：第一次只过滤了
> `/aweme/v1/web/`，漏掉了 `imapi.douyin.com`。WebSocket（`frontier-im` 等）是实时消息通道；
> 分享/发送本身有 HTTP 接口。

## 二、发送的实现方式

和社区里的 Java Web SDK 思路一致：**用一条真实抓到的 protobuf 请求当模板**，只改业务字段：

1. 从一次真实分享中抓取 `POST /v1/message/send` 的请求体（protobuf）与 cookies；
2. 解析出 `SendMessageBody → SendMessageContent`，保留 envelope / headers / ticket 等会话字段；
3. 替换：
   - `content`：新的视频卡片 JSON（itemId、标题、封面、作者 uid），数据来自只读搜索接口；
   - `client_message_id`（消息体 + ext 里各一份）、`s:stime`；
4. 用 cookies + `content-type: application/x-protobuf` POST 到 `imapi.douyin.com/v1/message/send`。

关键细节：`conversation_short_id` 是 int64（> 2^53），**不能先解析成 JS Number 再编码**，
否则尾数会被截断，服务端会报「你已不在群聊内」。脚本里的 protobuf 编辑是**逐字节保留**的。

## 三、限制与风险

- **模板有时效**：请求体里的 ticket / identity token 来自浏览器会话，实测抓取后几分钟内可用；
  长期运行需要定期刷新（最简单：定期用一次浏览器登录会话重新导出模板 + cookies）。
- **会话绑定**：模板里的 `conversation_id` / `conversation_short_id` 对应某个好友；
  要发给不同的人，需要先调 `/v2/conversation/create`（或从会话列表接口获取），当前 POC 未实现。
- **风控**：纯 HTTP 请求没有浏览器指纹，短时间高频可能触发验证；建议低频、与真实使用强度一致。
- **平台条款**：这属于对未公开接口的自动化访问，和浏览器自动化一样处于灰色地带；
  只建议在自己的账号上低频使用。
- 发送是真的会送达，测试时**实际给好友发了几条视频**（含重复），这是验证的副作用。

## 四、复现（安全捕获 + 纯 HTTP 发送）

前置：一个已登录的 Chrome profile；本仓库依赖已安装。

```bash
# 1) 启动带 POC 捕获的 browser-server；POC_ABORT_SEND=1 会在抓到请求后中断发送
POC_CAPTURE_DIR=/tmp/api-poc POC_ABORT_SEND=1 \
  node src/browser-server.js --profile <已登录profile> --port 9337

# 2) 另开终端：驱动一次「打开视频 → 分享面板 → 点好友」，发送请求会被捕获并中断
node scripts/poc-drive-send.js --port 9337 --friend <好友名> --bundle /tmp/api-poc/bundle.json

# 3) 纯 Node/HTTP 发送：用步骤 2 的模板 + cookies，从搜索接口选一条新视频发出
node scripts/poc-api-send-pure.js --in /tmp/api-poc
```

脚本：

| 脚本 | 作用 |
|---|---|
| `scripts/poc-drive-send.js` | 通过 browser-server 驱动一次分享流程；配合 `POC_ABORT_SEND=1` 只抓模板不发送 |
| `scripts/poc-api-send-pure.js` | 纯 Node：读取模板/cookies，调用只读接口选片，HTTP 发送视频卡片 |
| `scripts/poc-api-probe.js` | 抓取只读接口流量（搜索等），供重放分析 |
| `scripts/poc-api-replay.js` | 用 Node 重放只读请求，验证 cookie/签名要求 |

> `/tmp/api-poc` 里含 cookie、ticket 等登录凭据：**不要提交、用完删除**。
> browser-server 的捕获钩子只在设置 `POC_CAPTURE_DIR` 时启用，正常运行时完全不参与。

## 五、如果要产品化

推荐分两层：

1. **会话层**：一次性/周期性用浏览器完成扫码登录，导出 cookies + 一条发送模板（或更完整的协议实现）；
2. **执行层**：选片 + 发送全部走 HTTP，不再启动浏览器窗口。

还可以进一步：实现 `/v2/conversation/create` 支持任意好友、实现 cookie/template 的自动刷新、
用只读 API 选片替代搜索页加载。这些都需要单独排期和风控观察。
