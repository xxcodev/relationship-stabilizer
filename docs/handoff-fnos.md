# 交接文档:把 douyin-forwarder 做成飞牛(fnOS)插件

> 写于 2026-11-24,给「新会话」用的上下文。读完这份就能接着干,不必回溯之前的对话。

## 一、现在有什么

程序在 `~/Documents/deepseek-harness/default-workspace/douyin-forwarder`。

| 项 | 现状 |
|---|---|
| 代码 | 15 个模块,2452 行(含测试) |
| 运行时 | Node 24 + `node:sqlite`(零原生依赖)+ `playwright-core` |
| 数据 | `data/app.db`(SQLite,3 个迁移)+ `data/profile-B/`(Chrome 配置,801MB) |
| 界面 | `http://127.0.0.1:9400`,13 个 `/api/*` 接口 |
| 托管 | macOS launchd `com.dsh.douyin-forwarder` |
| 测试 | 25 个单测 + 14 项冒烟(`npm run verify`) |
| 已验证 | 2026-11-24 10:14 真实发送成功到 Hime(`分享成功`,截图在 `data/shots/`) |

设计文档:`docs/architecture.md`;事故记录:`docs/incidents.md`;切换与回滚:`docs/cutover.md`。

## 二、飞牛打包的已知事实(来自公开资料,需在实机上复核)

- 飞牛第三方应用的包格式是 **`.fpk`**,用官方 **`fnpack` CLI** 构建:
  `fnpack create <appname>` 生成骨架 → `fnpack build` 产出 `.fpk`;
  安装方式是「**应用中心 → 手动安装**」上传该文件。
- 安装向导支持让用户设置**端口**和**管理员密码**之类的参数(见 WechatOnCloud 的 fnos 打包说明)。
- 飞牛同时支持 **Docker** 应用,很多第三方能力是直接以容器形式提供的。

参考:
- [fnos-apps 开发者指南](https://github.com/conversun/fnos-apps/blob/main/docs/fnos-developer-guide.md)
- [WechatOnCloud 的 fnos 打包说明](https://github.com/gloridust/wechatoncloud/blob/2cb1d73b59133ce6801e04d903b383684f3bfcea/fnos/README.md)
- [fn-fpk 字段说明](https://skillhub.360.com/skills/fn-fpk)

> 我没有在真实飞牛设备上验证过这些,新会话第一件事应该是:拿一台 fnOS,
> 用 `fnpack` 打个 Hello World 的 fpk,确认打包与安装链路。

## 三、最关键的技术冲突

这套程序的核心是**驱动一个真实登录态的 Chrome**。飞牛是 NAS 系统,**没有桌面环境**。

本会话里有过一次直接证据:

> 2026-11-23,用 **headless** Chrome 打开抖音首页,立刻被判定为机器人,
> 返回「验证码中间页」+ 拼图验证;换成 **headed**(有窗口)就正常加载。
> 之后 2026-11-24 09:44 又因自动化请求量过大,触发了一次「点击两个形状相同的物体」人工验证。

所以「把现在的程序原样塞进 fpk 里跑」大概率不可用——它会在 NAS 上以 headless 身份被拦。

## 四、两种可行的架构

### 方案 A:全部塞进 fpk(NAS 独立运行)

fpk 内含 Node + Chromium + Playwright + **Xvfb(虚拟显示)**,让 Chrome 以 headed 模式跑在虚拟屏上。

- 好处:一台 NAS 搞定,24 小时在线,不依赖 Mac。
- 代价:包体 400MB+;虚拟屏只能骗过一部分 headless 检测,是否有效**必须实测**;
  浏览器指纹是全新的 → 需要重新扫码登录,而且首次登录的二维码要能通过 Web UI 展示出来
  (现有 `browser-server` 可以截图,理论上可行);
  风险仍是账号被判定为自动化。
- 前置验证:POC 只做一件事——在 fnOS 的 Docker 里跑 Xvfb + Chrome,打开抖音搜索页,
  看是否被验证页拦。**这一步不通,方案 A 直接否掉。**

### 方案 B:拆成「调度端」和「执行端」(推荐先评估)

- **NAS 侧插件**:只跑数据库、排班、Web UI、通知;不做浏览器操作。
- **执行端**:留在 Mac(或家里任意一台有桌面的机器)上,继续跑现在的 `browser-server`。
- 两边通过局域网 API 通信,NAS 下发「现在发一条」,执行端回报结果。

- 好处:完全避开 headless 风控问题;NAS 的 7×24 只用来做可靠调度与远程查看。
- 代价:要新增一层 agent 协议(鉴权、重试、离线队列),并且依赖「执行端机器开机」。
  现有代码里 `browser-server` 的 HTTP 契约已经是天然的切分点,改造量可控。

## 五、新会话开工清单

1. 拿一台 fnOS,用 `fnpack` 打通 Hello World 的打包与安装;
2. 跑方案 A 的 POC(Xvfb + Chrome + 抖音搜索页),拿到「拦 / 不拦」的结论;
3. 若 A 被拦,按方案 B 设计 agent 协议(鉴权、心跳、离线补发);
4. 数据与配置迁移:现有 `data/app.db` 与 `data/profile-B/` 如何随安装包落到
   `/var/apps/<app>/...`(飞牛会在安装后分配存储目录);
5. 明确分发范围:只自己用 → 不需要签名;发给别人 → 需要说明风险与许可。

## 六、需要用户先拍板

1. 发给别人还是只自己用?
2. 飞牛那台机器是否长期开机、在哪(家里/机房)?IP 属性直接影响风控。
3. 接受「NAS 上重新扫码登录」吗?
4. 如果方案 A 被拦,是否接受方案 B(执行端仍需一台桌面机)?
