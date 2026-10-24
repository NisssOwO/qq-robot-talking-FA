# 语音接入（TTS）· 任务清单

> 状态：**待开工**（本文档只记录计划，代码一律未动）
> 目标：让七草日花能在 QQ 里发语音——只念日语段，发完语音紧接着发文字版「日语 + 中文字幕」。

## 已确认的决策

| # | 决策 |
|---|---|
| 1 | 密钥存 `config.json`（控制台填写），同时兼容环境变量 `FISH_AUDIO_API_KEY`（环境变量优先） |
| 2 | Fish Audio **官方** API，`baseUrl` 默认 `https://api.fish.audio`，控制台留可改输入框 |
| 3 | 「试听」默认发到 `ownerQQ` 私聊，卡片里可改目标群号 |
| 4 | 群里任何人都能要求语音，但受限流约束（2 条/分钟、10 条/小时），超额只回文字 |
| 5 | AI 主动用语音的边界：被要求 / 道晚安 / 一句话的短回应，其它情况默认文字 |
| 6 | 音色用 eidolon 里现成的 `voice_id = b3757…0975` |
| 7 | `maxSeconds` 收到 **60** 秒，超时只发文字 |
| 8 | 三种触发并存：@她说句话 / 控制台按钮 / AI 自己判断 |

## 设计要点

```
消息 → AI 调 tts_speak(ja, zh)
          ↓
   桥接 POST {baseUrl}/v1/tts
        headers: Authorization: Bearer <key>, model: <model>
        body: { text: ja, reference_id: <voiceId>, format: "mp3" }
          ↓
   落盘 audio/tts/tts-<ts>.mp3 → 时长检查 ≤ 60s
          ↓
   发语音（record 段，file 传本地路径）
          ↓
   紧接着发一条文字：ja + 空行 + zh
```

- **不需要本机 ffmpeg**：`record` 段传本地路径，SnowLuma 自带 `native/ffmpeg` 转码。
- **失败降级**：TTS 失败 / 超时 / 超 60 秒 → 只发文字，日志记原因，不往群里报错。

## 任务清单

### 阶段 0 · 准备
- [x] 备份 `src/bridge.js`、`public/console.html`、`config.json`（带时间戳）→ `*.bak-20261019-223316`
- [x] 建目录 `audio/tts/`（`voiceCfg().dir` = `path.resolve(ROOT, socialV2.voice.dir)`，默认 `ROOT/audio`；**不是** `state/audio`）

> **落盘位置**：`F:\产出\shiny colors\audio\tts\tts-<时间戳>.mp3`。
> 必须在 `voice.dir` 之内——AI 通道（`/api/socialV2/send-voice`）只允许库内文件，库外路径只有操作者通道能发。
> 命名带 `tts-` 前缀，保留最近 20 个，超出自动删最旧。

### 阶段 1 · 配置与后端
- [x] `config.json` 增加 `tts` 段：`provider` / `baseUrl` / `apiKey` / `model` / `voiceId` / `enabled`（另含 `timeoutMs`、`keepFiles`）
- [x] `socialV2.voice.maxSeconds` 改为 `60`
- [x] `src/bridge.js` 的 `loadConfig()` 给 `tts` 补默认值（`apiKey` 环境变量 `FISH_AUDIO_API_KEY` 优先）
- [x] 新增 `src/tts-fish.mjs`：请求封装、超时（15s）、错误分类（401/429/超时/格式）
- [x] 音频落盘与清理（保留最近 `keepFiles` 个，默认 20）
- [x] 时长检查：优先 `ffprobe`，缺失时按 mp3 帧头码率估算；超限 → 降级
- [x] 桥接端点 `POST /api/socialV2/tts-say`（agent token 鉴权 + 白名单 + 限流；只看 `tts.enabled`，与发语音库的 `socialV2.voice.enabled` 分开）
- [x] 桥接端点 `GET /api/tts/config`（密钥掩码：`b375…0975` 这种）
- [x] 桥接端点 `POST /api/tts/config`（写 config，密钥只进不出）
- [x] 桥接端点 `POST /api/tts/preview`（操作者通道，试听）
- [x] 回归脚本 `scripts/test-tts-fish.mjs`（14 项断言，全部通过）

### 阶段 2 · MCP 工具
- [x] `src/mcp-snowluma-safe.js` 增加 `qq_tts_say(key, token, ja, zh)`，调 `/api/socialV2/tts-say`
- [x] 工具说明写清：只传日语原文 + 中文字幕，不要传整段回复；失败不重试、改发文字
- [x] `socialV2.tools.ttsSay` 开关（默认开）；总闸用 `tts.enabled`（与发语音库的 `socialV2.voice.enabled` 分开）

### 阶段 3 · 控制台
- [ ] 新增「语音」卡（放在「静默」卡下方）：
  - [ ] 启用开关、服务商、Base URL
  - [ ] API Key 密码框（保存后显示掩码）
  - [ ] 模型下拉（`s2.1-pro-free` 默认 / `s2.1-pro` / `s2-pro` / `drama-3` / `s1`）
  - [ ] 音色 ID（预填 `b3757a5a…`）
  - [ ] 试听文本 + 目标（默认 owner 私聊）+「试听并发送」
  - [ ] 状态行：已启用 · 模型 · 限流 · 时长上限 60s
- [ ] 前端只读状态渲染（不回显密钥）

### 阶段 4 · 提示词与触发
- [x] `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 增加「用声音说话（qq_tts_say）」小节
- [x] 重新生成 preset patch（`node scripts/build-agent-preset-patches.mjs`）
- [x] `handleIncoming` 里识别「语音 / 说句话 / 读一下 / 念一下 / 用声音」+ 被 @ → 本轮提示要求用 `qq_tts_say`（一次性，2 分钟有效）
- [ ] 改完 preset + 启用 TTS 后**需要重启 DSH**（MCP 工具与 preset 都在 DSH 启动时加载）

### 阶段 5 · 验收
- [x] 控制台填 key → 保存 → 显示掩码，重开页面仍显示掩码
- [x] 试听：输入 1 句日语 → 私聊收到语音（实测 8.05 秒），文字版随行
- [ ] @她说「说句话」→ 语音 + 文字（触发逻辑已接，待群里真人实测）
- [ ] 让她自主判断一次（道晚安）→ 语音 + 文字（同上，取决于模型判断）
- [x] 超 60 秒 → 降级：`maxSeconds=2` 时返回 `400 too-long`（10.6 秒 > 2 秒）；700 字长文本先撞 15 秒合成超时 → `502 timeout`，同样只发文字
- [x] 连续刷 3 条 → 第 3 条 `429 语音发送频率超限（每分钟最多 2 条）`
- [x] 错误 key → `400 auth`，群里无报错，config 自动复原

> 2026-10-19 实测通过；TTS 走**仅限本请求**的代理隧道（Clash 7897），桥接其它出站请求不受影响。

### 阶段 6 · 文档
- [ ] `docs/TTS-VOICE.md`：配置项、密钥存储与风险、降级规则、限流、回滚方式

## 风险

| 风险 | 处理 |
|---|---|
| 免费模型排队/限流 | 15 秒超时，超时降级为文字 |
| 密钥明文落盘 | 掩码显示、不写日志、不回显；建议顺手收紧 `config.json` 权限 |
| 群里被刷语音 | 2 条/分钟、10 条/小时，超额转文字 |
| preset 改动要重启 DSH | 提前告知，重启期 QQ 消息入队不丢 |
| 日语语音群里没人点 | 保留文字版兜底（已确认要做） |

## 不在本次范围

- 实时语音通话（eidolon 的 WebRTC 那套）
- 语音识别（听群友的语音消息）
- 情绪标签 `[shyly]` 传给 TTS（免费模型未必支持，先剥掉）
- 音量归一化（需要本机 ffmpeg，先不做）

## 估时

约半天：后端 2h、工具与 preset 1h、前端 1h、联调 1h。
