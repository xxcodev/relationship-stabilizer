# Docker 部署指南

通过 Docker 可一键在 Linux 服务器、NAS（含飞牛 fnOS、群晖、Unraid 等）或本地 Docker Desktop 上同时运行控制面板（`dashboard`）、调度循环（`schedule`）以及虚拟显示环境下的 Chromium（`Xvfb` + `playwright-core`）。

## 1. 快速开始

```bash
docker compose up -d --build
```

启动后访问控制面板：`http://<服务器IP>:9400`

查看运行日志与健康状态：

```bash
docker compose logs -f
docker compose ps
```

首次启动会自动执行 `node src/index.js init` 初始化 `/app/data/app.db`、默认账户 `A` 以及 20 个内置视频池，并同时拉起控制面板与账户调度进程。

## 2. 首次登录抖音

容器内置 `Xvfb`（虚拟显示 `:99`）与中文字体，默认以 **有头模式（`BROWSER_HEADLESS=false`）** 启动 Playwright Chromium，降低无头环境触发风控的概率：

1. 打开面板 `http://<服务器IP>:9400`；
2. 点击首页的 **「🖥 浏览器画面」**，面板会启动账户对应的 Chromium 并实时显示页面截图；
3. 在截图画面出现抖音二维码后，用手机抖音 App 扫码登录（也可直接点击画面中的元素完成交互或人机验证）；
4. 登录成功后，在 **「配置 → 05 高级与维护」** 点击刷新/导出纯 API 会话（或导入已有会话 JSON），即可使用纯 API 自动选片与发送。

> 登录态与浏览器指纹目录持久化保存在宿主机的 `./data`（容器内 `/app/data`），容器重建或升级镜像后无需重新扫码。

## 3. 数据持久化与目录结构

`docker-compose.yml` 默认将宿主机的 `./data` 挂载到容器内 `/app/data`：

| 路径 | 说明 |
|---|---|
| `./data/app.db` | SQLite 数据库（配置、好友、计划、发送记录、事件流水） |
| `./data/profile-*-chromium/` | Chromium 持久化登录态目录 |
| `./data/api-sessions/` | 导出的纯 API 会话文件 |
| `./data/shots/` | 发送与排错截图 |
| `./data/logs/` | `dashboard` 与各账户 `schedule` 日志 |
| `./data/database.json` / `ai.json` | 在面板中保存的外部数据库 / AI 配置 |

## 4. 常用配置（环境变量）

可在 `docker-compose.yml` 的 `environment` 或宿主机 `.env` 中覆盖：

| 变量 | 默认值（容器内） | 说明 |
|---|---|---|
| `TZ` | `Asia/Shanghai` | 调度排班使用的时区 |
| `DASH_PORT` | `9400` | 控制面板端口 |
| `DASH_HOST` | `0.0.0.0` | 监听地址（容器外访问需保持 `0.0.0.0`） |
| `BROWSER_HEADLESS` | `false` | 是否改为纯无头模式（`false` 时走 Xvfb 虚拟屏） |
| `BROWSER_NO_SANDBOX` | `true` | 容器内启用 `--no-sandbox` |
| `BROWSER_DISABLE_DEV_SHM` | `true` | 启用 `--disable-dev-shm-usage`，配合 `shm_size: 512m` |
| `BROWSER_ARGS` | — | 追加传给 Chromium 的额外启动参数（空格或逗号分隔） |
| `DB_DRIVER` / `DB_HOST` / … | `sqlite` | 可选切换为外部 PostgreSQL 或 MySQL |
| `AI_ENABLED` / `AI_API_KEY` / … | 关闭 | 可选启用 AI 旁路能力 |

## 5. 迁移已有宿主机数据到 Docker

如果你之前在 macOS / Windows / 本机 Linux 上已经运行过 `douyin-forwarder`，可以直接把原有的 `data/` 目录复制到 `docker-compose.yml` 同级的 `./data/`：

1. **纯 API 会话（`api-sessions/`）和 `app.db`**：直接复用即可；
2. **注意 `accounts.profile_dir` 路径**：旧库里可能保存了宿主机绝对路径（如 `/Users/xxx/douyin-forwarder/data/profile-a`），容器内需要改为 `/app/data/...`。可在启动容器前/后执行一次检查或更新，或直接在容器内新开浏览器重新扫码登录；
3. **跨浏览器 profile 注意事项**：macOS/Windows 的系统 Chrome profile 因系统钥匙串加密 Cookie 无法直接在 Linux Chromium 中解密，迁入容器后请在「浏览器画面」重新扫码一次。

## 6. 常用运维命令

```bash
# 查看状态 / 诊断环境
docker compose exec douyin-forwarder node src/index.js status
docker compose exec douyin-forwarder node src/index.js doctor

# 立即执行一次只读冒烟测试
docker compose exec douyin-forwarder node src/index.js verify

# 数据库快照备份到 ./data/backups/
docker compose exec douyin-forwarder node src/backup.js

# 重建并更新容器（保留 ./data）
docker compose up -d --build
```

## 7. 发布到 Docker Hub（GitHub Actions）

仓库已包含多架构（`linux/amd64` + `linux/arm64`）自动发布工作流 [`.github/workflows/docker.yml`](../.github/workflows/docker.yml)：

1. 在 Docker Hub 生成一个具有 `Read & Write` 权限的 Personal Access Token；
2. 在 GitHub 仓库的 **Settings → Secrets and variables → Actions** 中添加两个 Secret：
   - `DOCKERHUB_USERNAME`：Docker Hub 用户名
   - `DOCKERHUB_TOKEN`：Docker Hub Access Token
3. 触发发布：
   - **自动发版**：推送 `v*` 标签（例如 `git tag v0.32.21 && git push origin v0.32.21`），会自动构建并推送 `0.32.21`、`0.32` 和 `latest`；
   - **手动触发**：在 GitHub Actions 页面选择 `docker` 工作流点击 **Run workflow**，可自定义镜像标签（默认 `latest`）。

发布完成后，在目标机器将 `docker-compose.yml` 中的 `build:` 改为 `image: <你的用户名>/douyin-forwarder:latest`，再执行 `docker compose pull && docker compose up -d` 即可运行。

