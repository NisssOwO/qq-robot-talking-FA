# 静默时段（quietHours）— 本地改动说明

> 这是给 `qq-bridge` 本地安装加的功能，不是上游仓库的一部分。上游更新后按本文
> 重放即可。所有改动都有 `*.bak-<时间戳>` 备份。

## 规则

- 时区固定 **UTC+8**，不看机器时区。
- 时段分两套：**工作日** 和 **周末与法定节假日**，各配各的时间窗口
  （面板「角色与行为 → 静默时间」可改）。
- 哪几天算工作日可配（默认周一至周五），**法定节假日自动排除**，**调休补班日算工作日**。
- 某一套留空 = 这一天不静默。默认工作日 09:00–12:00、14:00–18:00；周末与法定节假日留空（全天正常）。
- 静默期：不回复、不唤醒、不主动、不等待、不建 DSH 会话、不产生模型调用；
  消息不补看，只记统计。
- **唯一例外**：管理员 @ 或引用（私聊本身算直接呼叫）→ 只处理这一条，
  发完立即结束（等待与唤醒配置在桥上被拒绝）。
- **临时覆盖**（控制台）：15 分钟 / 跳过本窗口 / 今天不再静默 / 取消。
  覆盖期是**被动模式**：任何人 @ 都回，但依然不主动、不等待、不设唤醒。

## 配置（config.json）

```json
"quietHours": {
  "enabled": true,
  "holidays": "cn",
  "workday": {
    "weekdays": [1, 2, 3, 4, 5],
    "windows": [["09:00", "12:00"], ["14:00", "18:00"]]
  },
  "offday": { "windows": [] }
}
```

`holidays: "cn"` 时每天最多拉一次 `timor.tech/api/holiday/year/<年>`（含调休补班），
缓存到 `state/holidays-cn.json`；拉不到就用缓存，再不行按「周一至周五」兜底，
不会阻塞启动。改成 `"none"` 则完全忽略节假日。

## 代码改动点

| 文件 | 改动 |
|---|---|
| `src/quiet-hours.mjs` | **新增**。状态机：两套时段（工作日 / 周末与法定节假日）、UTC+8 换算、节假日缓存、覆盖状态、一次性回合标记 |
| `src/bridge.js` | ① import + 在 `main()` 里实例化 `quietHours`；② `loadConfig()` 增加 `quietHours` 默认值（含老配置 `migrateQuietHours`）；③ `startQuietTicker()`（每分钟对状态，切换时清/排定时器，启动时调用）；④ `handleIncoming()` 入站闸门（在原「静默模式」判断之前）；⑤ `scheduleWakeV2` / `sendWakePromptV2` 拦截；⑥ `scheduleProactiveCheckV2` / `scheduleReplyCheckV2` / `setupSleepTimerV2` 拦截；⑦ `buildWakePromptV2` 增加「静默时段例外」专用提示；⑧ `/api/socialV2/wait` 拒绝等待、`/api/socialV2/wake-config` 忽略写入；⑨ `/api/status` 增加 `quietHours`；⑩ 新增 `/api/quiet-hours`、`/api/quiet-hours/config`（保存并即时生效）、`/api/quiet-hours/override`、`/api/quiet-hours/clear` |
| `public/console.html` | 「静默」卡：状态行、手动静默、四个覆盖按钮。时段规则改到面板的「静默时间」页配置，卡上不再写死时间 |
| `app/ui.html` + `app/ui.mjs` | 面板自建页「角色与行为 → 静默时间」：两套时段增删、工作日勾选、启用开关、节假日日历；`GET/POST /api/quiet-hours*` 走面板同源代理 |
| `scripts/test-quiet-hours.mjs` | **新增**。纯逻辑回归（`node scripts/test-quiet-hours.mjs`，加 `--with-holidays` 会联网验节假日） |
| `config.json` | 新增 `quietHours` 段（`workday` / `offday` 两套） |

## 与「手动静默」的关系

两者取「或」：手动静默（控制台「开启静默」）或时间段静默，任一成立就静默。

- 手动静默：只有管理员消息能进（旧行为）。
- 时间段静默：只有管理员 **@/引用** 能进。
- 临时覆盖：压过两者，但只放开「被 @ 才回」。

## 验收

```bash
node scripts/test-quiet-hours.mjs            # 逻辑回归，全绿
node scripts/test-quiet-hours.mjs --with-holidays
```

实测记录（2026-10-19 18:20，临时把窗口改成 18:00–19:30）：

```
[quiet] 静默时段已加载：当前 quiet（工作日 18:00-19:30，UTC+8）
[quiet] 主动机会推迟 70 分钟（静默/覆盖中）group:123456789
[quiet] quiet 例外放行 group:123456789（管理员 @/引用），回完即停
[reserved2] 工具统一发送 group:123456789: 成功 1/1 条
[quiet] quiet 忽略消息 group:123456789（来自 1000000001，@=false）
```

## 回滚

```powershell
# 用备份覆盖回去（时间戳换成自己的）
Copy-Item src\bridge.js.bak-<时间戳> src\bridge.js -Force
Copy-Item public\console.html.bak-<时间戳> public\console.html -Force
Copy-Item config.json.bak-<时间戳> config.json -Force
# 重启桥接
```

`src/quiet-hours.mjs` 留着不影响运行（没有引用就只是死文件）。

## 上游更新后重放

1. 对比上游 `src/bridge.js` 与本地的差异（本文档第 3 节的 10 个点）；
2. 把 `src/quiet-hours.mjs` 复制过去；
3. 控制台那张卡的结构可以照抄；
4. 跑一次 `node scripts/test-quiet-hours.mjs` 和上面那组实测。
