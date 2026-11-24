# douyin-forwarder

把「定时从抖音挑视频 → 转发给好友」做成一个可移植、数据落在 SQLite 里的程序。

原型是一堆绑死在这台 Mac 上的脚本;这个版本的目标是:**换台机器、换系统、换账号都能跑,数据可查可改,后续加功能不用改核心。**

## 设计

```
schema/*.sql       编号迁移文件,启动时自动按序应用(记录在 meta 表)
src/db.js          node:sqlite 连接 + 迁移执行器(零原生依赖)
src/repos.js       所有 SQL 集中在这里,别的模块不写 SQL
src/planner.js     纯函数:时段 → 具体时刻(无 IO,可单测)
src/pools.js       视频池种子数据(数据库才是运行期事实来源)
src/picker.js      通过 browser-server 的 HTTP 接口挑片
src/browser-server.js  Playwright 驱动的本地控制服务(开始/关闭窗口、分享、发送)
src/scheduler.js   从数据库读配置 → 排班 → 调 browser-server → 回写数据库
src/dashboard.js   只读+可配置的网页,数据全部来自数据库
src/importer.js    一次性把旧版 JSON/JSONL 导进数据库
src/index.js       命令行入口
```

数据模型:

| 表 | 作用 |
|---|---|
| `accounts` | 发送账号(配置目录、端口、好友、启用状态),天然支持多账号 |
| `settings` | 全局可调参数(总条数、最小间隔、屏蔽词) |
| `pools` | 视频来源(名称 + 搜索词 + 开关) |
| `bands` | 每个账号的时段区间与条数上下限 |
| `plans` | 每天生成的时刻表 + 已发时刻 |
| `sends` | 每次发送的结果(分类、标题、作者、赞、toast、截图、失败原因) |
| `events` | 计划/失败/重排等事件流水 |

## Usage

```bash
cp .env.example .env          # 可选,默认值即可跑
npm install

npm run doctor                # 换机器先跑这个:Node/DB/浏览器/端口/账号 逐项自检
npm run verify                # 整体冒烟:环境 + 表结构 + 排班 + HTTP 接口(15 项,不碰调度和浏览器)
npm run backup                # 用 VACUUM INTO 导出一份一致的数据库快照到 data/backups/

# 多账号(表结构从一开始就按多账号设计)
node src/index.js account list
node src/index.js account add work --port 9335 --friend 某人
node src/index.js account disable work
node src/index.js account remove work --force
node src/index.js account move-profile work --to data/profile-work   # 挪动配置目录(会检查锁)
npm run init                  # 建库、灌入 20 个视频池、建默认账号与时段
npm run migrate -- ../browser-test   # 可选:把旧版数据导进来(可重复执行)

npm run status                # 当前账号/计划/今日已发
npm run plan                  # 今天已排 or 现场生成一份

npm run dashboard             # 网页: http://127.0.0.1:9400
npm run schedule              # 常驻调度(按数据库里的时段发)
node src/index.js send-once --dry   # 完整走一遍挑片+定位好友,不真正发送
```

首次使用某个账号需要在 `browser-server` 打开的窗口里扫码登录一次,登录态留在该账号的
`profile_dir`(Playwright 的 user data dir)。

## 和旧版的差异

- **没有硬编码路径**:`DATA_DIR` / `DB_FILE` / `BROWSER_EXECUTABLE` 都可通过 `.env` 覆盖。
- **没有 macOS-only 调用**:核心代码不再调 `launchctl`;进程托管交给各自平台的 init 系统
  (示例见 `docs/daemon.md`)。
- **状态不再是散落的 JSON**:计划、记录、事件都在 SQLite,事务保证一致性。
- **可测试**:`planner` 是纯函数,`repos` 用临时库,跑 `npm test` 即可,不需要浏览器。

## 架构

见 `docs/architecture.md`:分层、依赖方向、HTTP 契约、扩展点、失败模型、测试策略。

## 已知边界

- `browser-server` 仍然和某个具体浏览器版本绑定,升级 Chrome 后可能需要调整选择器
  (`data-e2e` / `data-userid` 这套定位目前是稳定的)。
- 抖音网页端会变,选片用的 DOM 提取逻辑需要定期验证:长跑失败时先跑 `send-once --dry`。
- 同一台机器多账号 = 多个 profile + 多个端口,但平台侧风控会关联设备,需自行评估。

## 时序与失败策略

抖音搜索结果页是前端渲染的,`goto` 之后**结果要 15–40 秒才出现**。所以 `picker.open()` 不是
「导航 → 立刻找卡片」,而是:

1. 导航后每 1.5 秒轮询一次,最多约 40 秒,直到目标卡片出现;
2. 期间如果页面出现 `Bad Gateway` / `kngx` / `访问过多` 才判定为被限流,重新导航;
3. 找不到卡片就整体重试,最多 3 轮;滚动一屏后再找一次。

发送失败时 **每个时刻最多尝试 2 次**(第二次间隔 90 秒),再失败就跳过该时刻并记
`send-failed`,不会无限重试——早期版本会在失败后每 60 秒重试一次,把站点惹毛了。

## 踩过的坑

见 `docs/incidents.md`。最重要的一条:**不要把页码/备案号之类的内容当成错误码匹配**。
`/50[023]/` 会命中页脚的 `京ICP备…02050006号`,导致页面刚打开就被判定为 502 而放弃。

## 面板上的控制

面板顶部有三个按钮和一条状态条,直接写数据库并重启服务:

| 控件 | 作用 |
|---|---|
| 暂停 / 继续 | 改 `accounts.enabled`,并 `launchctl kickstart` 让调度立刻读到新状态 |
| 重启服务 | 只重启,不改状态 |
| 状态条 | 服务在不在跑、账号是否启用;浏览器停在验证页时会出现红色提示 |
| 安全模式 | 一键把总条数改成 6–8、间隔 ≥15 分钟,风控收紧时用 |

**遇到抖音人机验证时**:窗口里会出现「点击两个形状相同的物体」这类验证,程序检测到后会记录
`captcha-blocked` 并停手(不会反复重试)。你在窗口里完成验证,然后点面板上的「继续」即可。
