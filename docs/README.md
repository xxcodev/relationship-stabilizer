# 文档索引

| 文档 | 内容 |
|---|---|
| [architecture.md](architecture.md) | 分层与依赖方向、browser-server 的 HTTP 契约、扩展点、失败模型、测试策略 |
| [daemon.md](daemon.md) | 用 launchd / systemd / Windows 任务计划托管 |
| [cutover.md](cutover.md) | 从旧脚本切换到本程序,以及回滚步骤 |
| [incidents.md](incidents.md) | 真实事故记录:定时失败、人机验证 |
| [handoff-fnos.md](handoff-fnos.md) | 打包成飞牛(fnOS)应用的可行性分析(未实施的调研) |
| [app.md](app.md) | 桌面应用(Electron)的进程模型、开发运行方式与 P1/P2 计划 |
| [api-poc.md](api-poc.md) | API 直连验证(2026-11-24):只读与纯 HTTP 发送都已跑通 |

## 快速定位

- 想改**排班规则**(时段、条数、随机分布)→ `src/planner.js`
- 想加**视频来源** → `src/pools.js` + 面板勾选
- 想改**面板/接口** → `src/dashboard.js` + `src/page.html`
- 想改**发送流程** → `src/browser-server.js`(`/send`)+ `src/scheduler.js`
- 想加**数据库字段** → `schema/` 新增迁移 + `src/repos.js`
