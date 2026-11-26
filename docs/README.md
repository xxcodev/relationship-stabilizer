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
| [api-mode.md](api-mode.md) | 纯 API 发送模式:会话导出、开关、回退与安全说明 |
| [ui.md](ui.md) | 控制台四页(首页/账户/配置/记录)说明与截图 |
| [optimization-plan.md](optimization-plan.md) | 全应用审计后的优化清单：P0 正确性、P1 稳定性、P2 功能、P3 工程化(暂存待执行) |
| [requirements-analysis.md](requirements-analysis.md) | 需求分析：账户级配置与简化、MySQL/PostgreSQL 支持、抖音默认推荐视频源 |
| [ai-integration.md](ai-integration.md) | AI 接入分析：推荐源选片、语义去重、运维助手、自然语言配置、护栏与分阶段计划 |
| [database.md](database.md) | 数据库后端：默认 SQLite，可选 MySQL/PostgreSQL，配置/切换/备份/限制 |

## 快速定位

- 想改**触发计划规则**(固定/范围内随机、秒级间隔、视频时长下限)→ `src/burst.js`
- 想改**旧配置迁移**(0.27 及以前的时间点/时段/总数)→ `src/schedule.js` + `src/burst.js`
- 想改**会话自动刷新**(到期窗口、导出前关闭浏览器)→ `src/session-refresh.js` + `app/main.js`
- 想加**视频来源** → `src/pools.js` + 面板勾选
- 想改**面板/接口** → `src/dashboard.js` + `src/page.html`
- 想改**发送流程** → `src/browser-server.js`(`/send`)+ `src/scheduler.js`
- 想加**数据库字段** → `schema/` 新增迁移 + `src/repos.js`
