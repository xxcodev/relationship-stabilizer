# 贡献指南

## 本地开发

```bash
npm install
npm run init          # 首次:建库
npm run doctor        # 环境自检
npm test              # 单元测试
npm run verify        # 跨层冒烟
```

## 代码约定

- 依赖方向只能自上而下:`index → dashboard/scheduler → picker/browser-server → planner → repos → db`。
- **SQL 只写在 `src/repos.js`**,其他模块不得直接执行 SQL。
- `src/planner.js` 必须保持纯函数(无 IO、无全局状态),任何改动都要补单测。
- 新增持久化字段必须写新的 `schema/00N_*.sql`,**不要修改已应用的迁移**。
- 新增 HTTP 接口放在 `src/dashboard.js`,写操作集中在 `/api/control` 与 `/api/send-now`。
- 提交前跑 `npm test`;涉及浏览器层时在本地跑 `node --test test/picker.test.js`。

## 提交信息

```
<scope>: <一句话说明>

<可选:为什么这么改>
```

`scope` 取 `db` / `planner` / `picker` / `scheduler` / `dashboard` / `docs` / `ci`。

## 改动数据库结构时

1. 新增迁移文件(不要改旧文件);
2. 在 `test/db.test.js` 里补一条往返断言;
3. 在 `CHANGELOG.md` 里记一笔。
