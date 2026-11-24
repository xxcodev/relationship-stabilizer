# 从旧脚本切到新程序的步骤

> **状态:已于 2026-11-23 23:00 完成切换。**
> 当前运行:`com.dsh.douyin-forwarder` → `douyin-forwarder/src/index.js schedule`。
> 旧任务 `com.dsh.douyin-forward` 已 bootout,plist 保留在 `~/Library/LaunchAgents/`,可用于回滚。


旧系统:`browser-test/scheduler.js`(launchd label `com.dsh.douyin-forward`)。
新系统:`douyin-forwarder`(label `com.dsh.douyin-forwarder`)。

**两台不要同时跑**:它们共用同一个浏览器配置目录,Chrome 的 profile 锁会互相打架。

## 顺序

1. **确认旧系统当前没有在发送**
   ```bash
   curl -s --max-time 2 http://127.0.0.1:9334/state >/dev/null && echo "正在发送,稍等" || echo "空闲"
   ```

2. **把旧系统的最终状态再导入一次**(会先清空该账号的 plans/sends,可重复执行)
   ```bash
   cd douyin-forwarder
   node src/index.js migrate ../browser-test
   node src/index.js status        # 核对 planTimes / doneToday / sendsTotal
   ```

3. **停掉旧服务**
   ```bash
   launchctl bootout gui/$(id -u)/com.dsh.douyin-forward
   # 旧 plist 留在原地,回滚时再 bootstrap 即可
   ```

4. **装新服务**
   ```bash
   sed -e "s|__PROJECT__|$PWD|g" -e "s|__NODE__|$(which node)|g" -e "s|__HOME__|$HOME|g" \
     deploy/com.dsh.douyin-forwarder.plist > ~/Library/LaunchAgents/com.dsh.douyin-forwarder.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dsh.douyin-forwarder.plist
   launchctl print gui/$(id -u)/com.dsh.douyin-forwarder | head -12
   tail -5 data/service.log
   ```

5. **验证**
   ```bash
   node src/index.js doctor
   node src/index.js status
   curl -s http://127.0.0.1:9400/api/data | head -c 200   # 新面板
   ```

## 回滚

```bash
launchctl bootout gui/$(id -u)/com.dsh.douyin-forwarder
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dsh.douyin-forward.plist
```

旧脚本和它的 `scheduler-state.json` 在切换后保持原样,回滚不需要重新扫码。

## 切换后的第一晚要注意

- 新程序按 `bands` 表生成计划,和旧的 `config.json` 数值一致(已在迁移时导入);
- 旧的 `picked-history.json`、`send-log.jsonl` 不再被写入,历史记录以数据库 `sends` 表为准;
- 面板端口建议统一到 9400:先停掉旧的 `dashboard.js` 进程再启动新的。
