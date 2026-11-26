# 数据库后端（SQLite / MySQL / PostgreSQL）

> 0.25.0 起：默认仍是 SQLite；MySQL/PostgreSQL 是**单机可选后端**，在面板里配置，重启应用生效。

## 1. 默认：SQLite

- 零安装、零服务，数据在 `DATA_DIR/app.db`（应用默认在用户数据目录的 `data/app.db`）。
- 使用 Node 内置 `node:sqlite`，没有原生编译依赖。
- 备份：`npm run backup` 使用 `VACUUM INTO`，生成一致性快照。
- 不需要任何 `DB_*` 环境变量。

## 2. 可选：MySQL / PostgreSQL

面板 → **配置 → 数据库**：

1. 类型选 `PostgreSQL` 或 `MySQL`；
2. 填主机/端口/库名/用户/密码（密码留空表示不修改；也可以只填连接串）；
3. 点「测试连接」；
4. 点「保存数据库配置」；
5. **重启应用/服务**后生效。

也可以不用面板，写环境变量（覆盖面板配置）：

```bash
DB_DRIVER=postgres
DB_URL=postgres://user:pass@127.0.0.1:5432/douyin_forwarder

# 或者分字段
DB_DRIVER=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=douyin_forwarder
DB_USER=root
DB_PASSWORD=
DB_SSL=false
```

面板配置保存在 `DATA_DIR/database.json`（0600，密码不回显）；环境变量优先。

## 3. 它是怎么工作的

SQLite 是同步 API，MySQL/PG 驱动是异步的。为了不改动上层 290+ 处同步调用，0.25.0 用一个
**worker + 同步门面**：

```
repos.js (同步)
  → db.js
      ├─ SQLite: node:sqlite（原路径，不变）
      └─ MySQL/PG: Worker (src/db-worker.js)
             ↔ pg / mysql2（异步连接）
             ↔ SharedArrayBuffer + Atomics.wait（同步等待）
```

- worker 在独立线程持有连接；主线程每条查询短暂阻塞（局域网通常几毫秒到几十毫秒）。
- 事务（`BEGIN/COMMIT/ROLLBACK`）固定在同一连接，和现有 `persist` 兼容。
- 外部库首次连接会创建最终 schema（`src/external-schema.js`），不重放 SQLite 历史迁移。
- 这只是单机/低频方案，**不适合高并发或大量报表查询**。

## 4. 从 SQLite 迁移数据

当前没有自动的 SQLite → MySQL/PG 数据导入；切换后外部库是空库，`init` 会建默认账户/视频池。
如需保留历史，建议：

1. 先 `npm run backup` 备份 SQLite；
2. 切换到外部库并初始化；
3. 用导出的 JSON/CSV 手工导入 `accounts`、`settings`、`pools`、`bands`、`sends`、`events` 等表。

> 需要自动迁移的话，可以再加一个 `db:import` 命令；注意保留 id、重置自增序列。

## 5. 备份与自检

- SQLite：`npm run backup` 生成 `.db` 快照。
- 外部库：`npm run backup` 生成逻辑 JSON（`.json`）；生产环境的备份仍建议用 `pg_dump` / `mysqldump`。
- `npm run doctor` 新增 database 检查：SQLite 直接检查文件；外部库做一次连接测试。
- `npm run verify` 用「尝试查询每张表」检查 schema，不再依赖 `sqlite_master`。

## 6. 限制与注意事项

- **切换后必须重启**：面板进程已经打开了旧库，不能热切换。
- **连接失败会阻止启动**：外部库不可达时应用会报错而不是静默回退，避免写错库；保存前请先测试连接。
- **单机假设**：同一账户的浏览器 profile 仍然不能多机共享；远程库不会共享登录态。
- **已做的回归**：
  - MySQL：`npm run test:mysql` 用 `mysql-memory-server` 启动真实 MySQL 8.0，跑通 schema/repos；
  - PostgreSQL：`npm test` 内置 `pg-mem` 兼容测试；`npm run test:pg:real` 再用 bundled 真实 PostgreSQL 跑一遍；
  - 以上测试默认不在 `npm test` 里跑真实数据库（避免下载二进制），需要时显式执行。
  这仍不覆盖你的实例版本、SSL、账号权限；第一次配置后请先 `npm run verify`、`npm run doctor`，再观察一轮发送。
- **SQLite 仍是默认**：没有特殊需求时不要切换。
