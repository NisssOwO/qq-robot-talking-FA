// standalone 后端：不依赖 DeepSeek Harness，自己跑 agent 循环。
//
// 形状刻意对齐 dsh-client.js 的 NodeApiClient（workspace / sessions / events / respond …），
// 因为 bridge.js 的 pumpMux 直接消费 DSH 的 session/event 帧。这里做的事就是：
//   prompt → 调模型（带 tools）→ 有 tool_calls 就执行 → 回填 → 再调 → 直到纯文本 → turn/end
// 同时把每一步发成与 DSH 同形的事件帧，桥接侧一行不改就能工作。
//
// 模型接入按 eidolon-sc 的路子：baseUrl + apiKey + model 三件套，走 OpenAI Chat Completions。
// 另外两种协议（Responses / Anthropic Messages）留了适配器位置，先只实现 openai-completions。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rpcOk, rpcFail } from './contract.mjs';
import { createToolRegistry } from './tools.mjs';
import { requestMetadata, modelFailure, safeFailure } from './model-diagnostics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const MAX_STEPS = 12;            // 单回合最多“模型→工具”往返次数
// 触发裁剪的历史字符预算（含 system）。
// 字符预算控制请求体积与成本，不代表服务商内容审核的阈值。
// data_inspection_failed 是内容审核错误，不能仅凭长度推断原因。
// 装不下的旧消息由 absorbDropped 压成摘要。
const DEFAULT_HISTORY_CHARS = 28000;
const KEEP_RECENT_MESSAGES = 24;      // 裁剪时最少保留的最近消息条数
const MIN_KEEP_MESSAGES = 4;          // 预算优先：即使超预算，也至少留最近 4 条
const MAX_TOOL_IMAGES = 2;            // 一次工具返回最多补几张图给模型（每张几十 KB，会明显涨 token）

/** 消息内容可能是字符串，也可能是多模态数组（image_url）。取「文本长度」用于预算。 */
function contentLength(m) {
  const c = m?.content;
  if (typeof c === 'string') return c.length;
  if (Array.isArray(c)) {
    return c.reduce((n, b) => n + (typeof b?.text === 'string' ? b.text.length : 64), 0);
  }
  return 0;
}

/** 同上的文本版：把多模态数组压成可读文本（图片位置留占位），用于摘要与日志。 */
function contentText(m) {
  const c = m?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return c == null ? '' : String(c);
  return c.map((b) => (typeof b?.text === 'string' ? b.text : (b?.type === 'image_url' ? '[图片]' : ''))).join(' ').trim();
}

function nowIso() {
  return new Date().toISOString();
}

/** `${VAR}` / `${VAR:-默认}` 形式的环境变量展开；没有引用时原样返回。 */
export function resolveSecret(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  return raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name, fallback) => {
    const value = process.env[name];
    if (value !== undefined && value !== '') return value;
    return fallback ?? '';
  });
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

/** 把 OpenAI 的 tool_calls 参数（字符串）安全解析成对象。 */
function parseToolArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

export function createStandaloneBackend(cfg, { log = () => {}, toolRegistry } = {}) {
  const llm = cfg?.llm ?? {};
  const stateDir = path.join(ROOT, cfg?.stateDir ? String(cfg.stateDir) : 'state', 'standalone');
  const sessionsDir = path.join(stateDir, 'sessions');
  const metaFile = path.join(stateDir, 'meta.json');
  const settingsFile = path.join(stateDir, 'settings.json');

  const tools = toolRegistry ?? createToolRegistry({ log });
  const diagnosticFile = path.join(stateDir, 'model-diagnostics.json');
  const diagnostics = [];
  function diagnose(record) {
    const next = [...diagnostics, { at: nowIso(), ...record }].slice(-50);
    try { writeJsonFile(diagnosticFile, next); diagnostics.splice(0, diagnostics.length, ...next); }
    catch { log('[standalone] 脱敏诊断保存失败（不影响模型调用）'); }
  }

  /** @type {Map<string, any>} */
  const sessions = new Map();
  let meta = readJsonFile(metaFile, { workspaces: {}, sessionSeq: 0, turnSeq: 0 });
  let settings = readJsonFile(settingsFile, {});
  const followed = new Set();

  // ── 事件总线：mux() 是一个永不结束的 async generator ──────────────────────
  const bus = {
    queue: [],
    waiters: [],
    push(frame) {
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.queue.push(frame);
    },
    async *stream(signal) {
      for (;;) {
        if (signal?.aborted) return;
        if (this.queue.length) {
          yield { payload: this.queue.shift() };
          continue;
        }
        const frame = await new Promise((resolve) => {
          this.waiters.push(resolve);
          signal?.addEventListener?.('abort', () => resolve(null), { once: true });
        });
        if (!frame) return;
        yield { payload: frame };
      }
    }
  };

  function emit(sessionId, event, { snapshot = false } = {}) {
    if (!followed.has(sessionId)) return;
    bus.push(snapshot
      ? { type: 'session/snapshot', sessionId, snapshot: event }
      : { type: 'session/event', sessionId, event });
  }

  // ── 会话持久化 ────────────────────────────────────────────────────────────
  function sessionFile(sessionId) {
    return path.join(sessionsDir, `${sessionId}.json`);
  }

  /** 服务商内容审核拦下的失败长这样：apiCode 或正文里带 data_inspection_failed。 */
  function isAuditRejection(info) {
    const code = String(info?.apiCode || '');
    const msg = String(info?.message || '');
    return code === 'data_inspection_failed' || /Input text data may contain inappropriate content/i.test(msg);
  }

  /** 审核拦截前先把会话原样备份，出事能翻回来。 */
  function backupSessionFile(sessionId) {
    const file = sessionFile(sessionId);
    const target = file + '.bak-' + Date.now();
    try { fs.copyFileSync(file, target); return path.basename(target); } catch { return ''; }
  }

  /**
   * 收缩到能过审的体量：只留最近几条、摘要清空。
   * 不试着「让模型判断哪句该删」——那次请求自己也会被拦。
   */
  function shrinkForAuditRetry(s) {
    const from = s.messages.length;
    const keep = Math.max(4, Math.min(from, 6));
    const msgs = s.messages.slice(-keep);
    while (msgs.length > 1 && msgs[0].role === 'tool') msgs.shift();
    s.messages = msgs;
    s.summary = '';
    return { from, to: s.messages.length };
  }

  function saveSession(s) {
    try {
      writeJsonFile(sessionFile(s.id), {
        id: s.id,
        workspaceId: s.workspaceId,
        preset: s.preset,
        model: s.model,
        messages: s.messages,
        summary: s.summary ?? '',
        auditBlocked: s.auditBlocked ?? null,
        createdAt: s.createdAt,
        updatedAt: nowIso()
      });
      meta.sessions ??= {};
      meta.sessions[s.id] = { workspaceId: s.workspaceId, preset: s.preset, updatedAt: nowIso() };
      writeJsonFile(metaFile, meta);
    } catch (error) {
      // 以前这里没有 try：Windows 上 renameSync 偶发 EPERM 会把整个回合静默吞掉，
      // 表现出来就是“消息发出去了，但重启后历史全没了”。
      log(`[standalone] 保存会话失败（${s.id}）：${error?.message ?? error}`);
    }
  }

  function loadSession(sessionId) {
    if (sessions.has(sessionId)) return sessions.get(sessionId);
    const data = readJsonFile(sessionFile(sessionId), null);
    if (!data) return null;
    const s = {
      id: data.id ?? sessionId,
      workspaceId: data.workspaceId,
      preset: data.preset ?? null,
      model: data.model ?? null,
      // 重启恢复时必须重新装载系统提示词：不恢复的话这一轮就没有人设，等于失忆换人。
      systemPrompt: loadSystemPrompt(data.preset ?? null),
      messages: Array.isArray(data.messages) ? data.messages : [],
      summary: data.summary ?? '',
      auditBlocked: data.auditBlocked ?? null,
      createdAt: data.createdAt ?? nowIso(),
      turnSeq: 0,
      abort: null,
      chain: Promise.resolve()
    };
    sessions.set(s.id, s);
    return s;
  }

  // ── 系统提示词 ────────────────────────────────────────────────────────────
  // 单一事实源仍是 dsh/agent-presets/<preset>/agent.cordis.yml（DSH 后端共用同一份）；
  // 打包时 build-standalone.mjs 会把它抽成 resources/prompts/<preset>.md，
  // 运行期优先读那份纯文本，读不到再回退到现场解析 YAML。
  //
  // 工具名要做一次替换：preset 里写的是 DSH 的 `mcp__snowluma__qq_send_message`，
  // 而 standalone 暴露给模型的名字是纯 `qq_send_message`。不替换的话模型会照着
  // 调用一个不存在的工具名。
  function loadSystemPrompt(preset) {
    if (!preset) return '';
    const mdFile = path.join(ROOT, 'resources', 'prompts', `${preset}.md`);
    let text = '';
    try {
      text = fs.readFileSync(mdFile, 'utf8');
    } catch {
      const ymlFile = path.join(ROOT, 'dsh', 'agent-presets', preset, 'agent.cordis.yml');
      try {
        const loaded = yaml.load(fs.readFileSync(ymlFile, 'utf8'));
        const entry = Array.isArray(loaded) ? loaded.find((item) => item?.id === 'persona') : null;
        text = typeof entry?.config?.prefix === 'string' ? entry.config.prefix : '';
      } catch {
        text = '';
      }
    }
    return text.replace(/mcp__snowluma__/g, '').replace(/mcp__snowluma-host__/g, '').replace(/mcp__web-search-safe__/g, '');
  }

  // ── 模型接入 ──────────────────────────────────────────────────────────────
  function llmConfig() {
    const apiKey = resolveSecret(llm.apiKey ?? '');
    const baseUrl = String(llm.baseUrl ?? 'https://api.deepseek.com/v1').replace(/\/+$/, '');
    return {
      protocol: String(llm.protocol ?? 'openai-completions'),
      baseUrl,
      apiKey,
      model: String(llm.model ?? 'deepseek-chat'),
      maxTokens: Number(llm.maxTokens ?? 4096),
      temperature: llm.temperature === undefined ? 1.0 : Number(llm.temperature),
      timeoutMs: Number(llm.timeoutMs ?? 180000),
      extraHeaders: llm.extraHeaders ?? {}
    };
  }

  async function callOpenAiCompletions({ messages, tools: toolDefs, signal, diagnosticContext }) {
    const c = llmConfig();
    if (!c.apiKey) {
      throw new Error('standalone 未配置模型 apiKey：请在 config.json 的 llm.apiKey 填入（支持 ${DEEPSEEK_API_KEY} 环境变量）');
    }
    const url = `${c.baseUrl}/chat/completions`;
    const body = {
      model: c.model,
      messages,
      temperature: c.temperature,
      max_tokens: c.maxTokens,
      stream: false
    };
    if (toolDefs?.length) {
      body.tools = toolDefs;
      body.tool_choice = 'auto';
    }
    const timer = setTimeout(() => {}, 1);
    clearTimeout(timer);
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    const timeout = setTimeout(() => ac.abort(), c.timeoutMs);
    const metadata = requestMetadata(messages, toolDefs, diagnosticContext);
    const context = { sessionId: diagnosticContext?.sessionId, turn: diagnosticContext?.turn, step: diagnosticContext?.step };
    const attemptStarted = Date.now();
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${c.apiKey}`,
          ...c.extraHeaders
        },
        body: JSON.stringify(body),
        signal: ac.signal
      });
      const textBody = await response.text();
      if (!response.ok) {
        throw modelFailure(response.status, textBody, response.headers.get('x-request-id') ?? response.headers.get('x-dashscope-request-id'));
      }
      let json;
      try {
        json = JSON.parse(textBody);
      } catch {
        throw new Error('模型接口返回非 JSON（响应正文未记录）');
      }
      diagnose({ ...context, ...metadata, model: /^[A-Za-z0-9_./:-]{1,128}$/.test(c.model) ? c.model : '[hidden]', outcome: 'success', httpStatus: response.status, elapsedMs: Date.now() - attemptStarted });
      const message = json?.choices?.[0]?.message ?? {};
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      return {
        content: typeof message.content === 'string' ? message.content : '',
        toolCalls,
        usage: json?.usage ?? null,
        finishReason: json?.choices?.[0]?.finish_reason ?? null
      };
    } catch (error) {
      diagnose({ ...context, ...metadata, model: /^[A-Za-z0-9_./:-]{1,128}$/.test(c.model) ? c.model : '[hidden]', outcome: 'failed', ...safeFailure(error), elapsedMs: Date.now() - attemptStarted });
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  /** 三种协议的统一入口；目前只有 openai-completions 是实装的。 */
  async function chat(request) {
    const { protocol } = llmConfig();
    if (protocol === 'openai-completions') return callOpenAiCompletions(request);
    if (protocol === 'responses') throw new Error('standalone 暂未实现 protocol=responses，请先用 openai-completions');
    if (protocol === 'anthropic') throw new Error('standalone 暂未实现 protocol=anthropic，请先用 openai-completions');
    throw new Error(`standalone 未知的 llm.protocol：${protocol}`);
  }

  /**
   * OpenAI 兼容接口的 usage 字段名和账本不一致：这边是 prompt_tokens/completion_tokens，
   * 账本（src/model-prices.js 的 normalizeUsage）认 cacheMiss/cacheHit/output/reasoning。
   * 不转的话 totals 永远是 0——「令牌与花费」页整页显示 ¥0，就是这个原因。
   */
  function ledgerUsageOf(usage) {
    if (!usage || typeof usage !== 'object') return null;
    const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
    const cached = Number(usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens ?? 0);
    const output = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
    const reasoning = Number(usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens ?? 0);
    if (!prompt && !output) return null;
    return {
      cacheMiss: Math.max(0, prompt - cached),
      cacheHit: Math.max(0, cached),
      cacheWrite: 0,
      output: Math.max(0, output),
      reasoning: Math.max(0, reasoning)
    };
  }

  // ── 上下文管理：固定 system + 最近原文 + 旧段落丢弃 ────────────────────────
  /**
   * 历史里还留着「角色卡拼在 user 消息里」的老记录（那套写法已经改成走 system 了）。
   * 重复角色卡会浪费上下文预算。内容审核另行判断，不能靠去重保证通过。
   * 发请求前把旧卡剥掉只留正文，
   * 存量记录不用删，磁盘上原样保留。
   */
  const LEGACY_ROLE_CARD_MARK = '（上面是你的完整角色卡';
  // 更早的格式里角色卡是直接拼在唤醒提示正文里的，标题就是这一行。
  const ORIGINAL_ROLE_CARD_HEAD = '# 角色卡：';
  function slimHistoryMessage(m) {
    if (m.role !== 'user' || typeof m.content !== 'string') return m;
    if (!m.content.includes(LEGACY_ROLE_CARD_MARK) && !m.content.includes(ORIGINAL_ROLE_CARD_HEAD)) return m;
    // 老记录是一个大杂烩：整张角色卡 + 一长串每轮都一样的固定规则 + 这一轮的快照。
    // 卡现在走 system，规则每轮重复到没有信息量，所以只留快照（谁说了什么）。
    const snap = m.content.match(/【(?:本次)?消息快照】[\s\S]*$/);
    if (snap) return { ...m, content: snap[0] };
    const trimmed = m.content.replace(/^[\s\S]*?（上面是你的完整角色卡[^\n]*\n\n/, '');
    return { ...m, content: trimmed || '（这一轮只剩唤醒提示，正文已省略）' };
  }

  /**
   * 历史里的工具交互只留摘要。assistant 的 tool_calls 参数和 tool 的返回内容都是完整报文，
   * 几十条叠起来能占三万多字，但对「现在该说什么」几乎没有信息量——模型只需要知道
   * 刚才调过什么工具、大体结果是什么。
   * 最近几条不动，否则正办到一半的事会断线。
   */
  const SLIM_TOOL_CONTENT = 300;
  const SLIM_TOOL_ARGS = 120;
  function slimToolMessage(m, isRecent) {
    if (isRecent) return m;
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > SLIM_TOOL_CONTENT) {
      return { ...m, content: `${m.content.slice(0, SLIM_TOOL_CONTENT)}…（更早的工具返回已截断）` };
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      return {
        ...m,
        tool_calls: m.tool_calls.map((tc) => {
          const args = String(tc.function?.arguments ?? '');
          if (args.length <= SLIM_TOOL_ARGS) return tc;
          return { ...tc, function: { ...tc.function, arguments: `${args.slice(0, SLIM_TOOL_ARGS)}…` } };
        })
      };
    }
    return m;
  }

  function buildRequestMessages(s) {
    const systemParts = [];
    if (s.systemPrompt) {
      // preset 里会写 {{model}}（DSH 侧由 prompt 变量机制替换）；standalone 在这里补上。
      const modelName = (s.model ?? '').split('/').pop() || llmConfig().model || 'DeepSeek';
      systemParts.push(s.systemPrompt.replace(/\{\{model\}\}/g, modelName));
    }
    // 角色卡排在仿真提示词之后、对话摘要之前：仿真提示词讲「怎么做事」，
    // 角色卡讲「你是谁」，摘要属于历史，顺序上刚好衔接。
    if (s.roleCard) systemParts.push(s.roleCard);
    if (s.summary) systemParts.push(`【更早的对话摘要】\n${s.summary}`);
    const messages = [];
    if (systemParts.length) messages.push({ role: 'system', content: systemParts.join('\n\n') });
    let total = messages.reduce((n, m) => n + contentLength(m), 0);
    // 历史里可能残留孤儿 tool 消息（assistant 那条丢了、或者被裁剪切在中间）。
    // 阿里云百炼对这类历史是硬报错：
    //   The tool_call_id in the response message does not match the tool_call_id in the tool_call
    // 所以先按「assistant 声明过的 id」筛一遍，只保留成对的 tool 消息。
    const declaredCalls = new Set();
    for (const m of s.messages) {
      if (Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) declaredCalls.add(tc.id);
    }
    const usable = s.messages
      .filter((m) => m.role !== 'tool' || declaredCalls.has(m.tool_call_id))
      .map(slimHistoryMessage);
    // 从最近往前挑，超过预算就停；保证最近 KEEP_RECENT_MESSAGES 条一定在。
    const picked = [];
    for (let i = usable.length - 1; i >= 0; i -= 1) {
      const m = usable[i];
      const len = contentLength(m) + JSON.stringify(m.tool_calls ?? '').length;
      if (picked.length >= MIN_KEEP_MESSAGES && total + len > DEFAULT_HISTORY_CHARS) break;
      total += len;
      picked.unshift(m);
    }
    // 裁剪点可能正落在一对 assistant(tool_calls) → tool 中间，留下没有 assistant 的孤儿
    // tool 消息。开头连续、找不到对应 assistant 的一律丢掉。
    while (picked.length && picked[0].role === 'tool') picked.shift();
    // 挑出来的历史里，越早的工具记录越没有价值：只留摘要，最近 4 条保持原样。
    const recentFloor = picked.length - 4;
    const slimmed = picked.map((m, i) => slimToolMessage(m, i >= recentFloor));
    return { messages: messages.concat(slimmed), dropped: s.messages.length - picked.length };
  }

  /** 被裁掉的消息压成一段摘要（先做抽取式，避免多一次模型调用；以后可换 LLM 摘要）。 */
  function absorbDropped(s, droppedCount) {
    if (droppedCount <= 0) return;
    const head = s.messages.slice(0, droppedCount);
    const lines = [];
    for (const m of head) {
      const text = contentText(m).replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const who = m.role === 'user' ? '对方' : m.role === 'assistant' ? '自己' : m.role;
      lines.push(`${who}：${text.slice(0, 160)}`);
    }
    const merged = [s.summary, ...lines].filter(Boolean).join('\n');
    // 摘要本身也有上限，超了就从最老的截掉。
    s.summary = merged.length > 2000 ? merged.slice(merged.length - 2000) : merged;
    s.messages.splice(0, droppedCount);
    // 切点可能正好落在 assistant(tool_calls) → tool 中间：assistant 被切走、tool 留下，
    // 变成永远配不上对的孤儿，下次请求就被接口 400 掉。这里把孤儿一并清掉。
    const stillDeclared = new Set();
    for (const m of s.messages) {
      if (Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) stillDeclared.add(tc.id);
    }
    s.messages = s.messages.filter((m) => m.role !== 'tool' || stillDeclared.has(m.tool_call_id));
  }

  // ── 一个回合：模型 ↔ 工具 循环 ─────────────────────────────────────────────
  async function runTurnOnce(s, userText) {
    const turn = ++s.turnSeq;
    meta.turnSeq = (meta.turnSeq ?? 0) + 1;
    // 重试时 userText 是 null：不再往历史里塞空消息，只把已有上下文再发一次。
    if (userText != null) s.messages.push({ role: 'user', content: userText });
    emit(s.id, { type: 'turn/start', data: { turn } });
    s._auditHit = false;

    let finalText = '';
    let failure = null;
    try {
      const toolDefs = (await tools.list()).map((t) => tools.toOpenAiTool(t));
      for (let step = 0; step < MAX_STEPS; step += 1) {
        const { messages, dropped } = buildRequestMessages(s);
        absorbDropped(s, dropped);
        const reply = await chat({ messages, tools: toolDefs, signal: s.abort?.signal,
          diagnosticContext: { sessionId: s.id, turn, step, preset: s.systemPrompt, roleCard: s.roleCard, summary: s.summary } });
        const text = String(reply.content ?? '').trim();
        if (text) {
          s.messages.push({ role: 'assistant', content: text });
          const usageBuckets = ledgerUsageOf(reply.usage);
          emit(s.id, {
            type: 'assistant/message',
            data: {
              turn,
              step,
              model: llmConfig().model,
              provider: 'standalone',
              ...(usageBuckets ? { usage: usageBuckets } : {}),
              message: { role: 'assistant', content: [{ type: 'text', text }] }
            }
          });
          finalText += text;
        }
        if (!reply.toolCalls.length) break;

        // 模型给的 tool_call id 每轮都从 call_0 重新数，跨轮会重复。
        // 历史里堆着多轮相同的 id 时，接口会报 "tool_call_id does not match"，
        // 所以这里自己发号，assistant 的 tool_calls 和 tool 结果用同一个新 id。
        const callIds = reply.toolCalls.map((_tc, i) => `call_${turn}_${i}_${Math.random().toString(16).slice(2, 8)}`);
        const assistantMsg = { role: 'assistant', content: reply.content ?? '' };
        assistantMsg.tool_calls = reply.toolCalls.map((tc, i) => ({
          id: callIds[i],
          type: 'function',
          function: { name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '{}' }
        }));
        s.messages.push(assistantMsg);

        // 工具返回的图片不能塞进 tool 消息（OpenAI 兼容接口那边只收字符串），
        // 必须等这一批 tool 消息都排完，再补一条 user 消息把图带上，模型才真的看得到。
        const pendingImages = [];
        for (let i = 0; i < reply.toolCalls.length; i += 1) {
          const tc = reply.toolCalls[i];
          const callId = callIds[i];
          const name = tc.function?.name ?? '';
          const args = parseToolArgs(tc.function?.arguments);
          emit(s.id, { type: 'tool/call', data: { name, callId, arguments: args } });
          const result = await tools.call(name, args);
          const images = Array.isArray(result.images) ? result.images : [];
          emit(s.id, {
            type: 'tool/result',
            data: {
              message: {
                role: 'tool',
                source: { callId, name },
                content: [
                  { type: 'text', text: result.text, isError: result.isError },
                  ...images.map((im) => ({ type: 'image', mimeType: im.mimeType, data: im.data }))
                ],
                isError: result.isError
              }
            }
          });
          s.messages.push({ role: 'tool', tool_call_id: callId, content: result.text });
          for (const im of images) pendingImages.push({ name, ...im });
        }
        if (pendingImages.length) {
          // 一次最多补两张：再多既撑上下文也烧 token，够模型认图了。
          const picked = pendingImages.slice(0, MAX_TOOL_IMAGES);
          s.messages.push({
            role: 'user',
            content: [
              { type: 'text', text: `（上面工具返回的图片，共 ${pendingImages.length} 张${pendingImages.length > picked.length ? `，只附前 ${picked.length} 张` : ''}）` },
              ...picked.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mimeType};base64,${im.data}` } }))
            ]
          });
        }
      }
    } catch (error) {
      failure = safeFailure(error);
      s._auditHit = isAuditRejection(failure);
      s._lastAudit = s._auditHit ? failure : null;
      if (!s._auditHit) log(`[standalone] 回合失败（${s.id}）：${JSON.stringify(failure)}`);
      // Errors are control events, never assistant speech or QQ fallback text.
    } finally {
      s.abort = null;
      log(`[standalone] 回合结束（${s.id}）：messages=${s.messages.length}，status=${failure ? 'failed' : 'completed'}`);
      saveSession(s);
      emit(s.id, {
        type: 'turn/end',
        data: {
          turn,
          reason: failure
            ? { kind: 'failed', ...failure, ...(s._auditHit ? { audit: true, blocked: !!s.auditNoRetry, notify: !!s.auditNoRetry } : {}) }
            : { kind: 'completed' }
        }
      });
    }
    return finalText;
  }

  /**
   * 一轮对话。只对「内容审核拦截」做一次「备份 → 收缩 → 重试」；
   * 其他失败（tool_call_id 配对、参数、配额）原样报错，不动历史。
   */
  async function runTurn(s, userText) {
    if (s.auditBlocked) {
      log(`[standalone] 会话因审核拦截暂停中，跳过本轮（${s.id}）`);
      emit(s.id, {
        type: 'turn/end',
        data: {
          turn: s.turnSeq,
          reason: {
            kind: 'failed',
            code: 'audit_blocked',
            apiCode: 'data_inspection_failed',
            message: '会话因内容审核暂停，等人工处理',
            audit: true,
            blocked: true,
            notify: false
          }
        }
      });
      return '';
    }
    s.auditNoRetry = false;
    const first = await runTurnOnce(s, userText);
    if (!s._auditHit) return first;
    const backup = backupSessionFile(s.id);
    const shrunk = shrinkForAuditRetry(s);
    log(`[standalone] 内容审核拦截（${s.id}）：已备份 ${backup || '(备份失败)'}，历史 ${shrunk.from}→${shrunk.to}，重试一次`);
    s.auditNoRetry = true;
    const second = await runTurnOnce(s, null);
    if (s._auditHit) {
      s.auditBlocked = { at: nowIso(), tries: 2, lastError: s._lastAudit, backup, notified: true };
      saveSession(s);
      log(`[standalone] 收缩后仍被拦，会话已暂停（${s.id}），等人工处理`);
    }
    return second;
  }

  // ── Backend 契约实现 ──────────────────────────────────────────────────────
  const backend = {
    kind: 'standalone',

    workspace: {
      async create({ path: dir } = {}) {
        const id = newId('ws');
        meta.workspaces ??= {};
        meta.workspaces[id] = { path: dir ?? path.join(stateDir, 'workspace'), createdAt: nowIso() };
        writeJsonFile(metaFile, meta);
        return rpcOk({ workspace: { workspaceId: id, path: meta.workspaces[id].path }, created: true });
      },
      async rename({ workspaceId, title } = {}) {
        meta.workspaces ??= {};
        if (meta.workspaces[workspaceId]) {
          meta.workspaces[workspaceId].title = title;
          writeJsonFile(metaFile, meta);
        }
        return rpcOk({ ok: true });
      },
      async archiveSession({ sessionId } = {}) {
        const s = sessions.get(sessionId);
        if (s) {
          sessions.delete(sessionId);
          followed.delete(sessionId);
        }
        return rpcOk({ ok: true });
      }
    },

    sessions: {
      async create({ workspaceId, agentPreset } = {}) {
        const id = newId('sess');
        const s = {
          id,
          workspaceId,
          preset: agentPreset ?? null,
          model: null,
          systemPrompt: loadSystemPrompt(agentPreset),
          messages: [],
          summary: '',
          createdAt: nowIso(),
          turnSeq: 0,
          abort: null,
          chain: Promise.resolve()
        };
        sessions.set(id, s);
        saveSession(s);
        log(`[standalone] 会话 ${id} 已创建（preset=${agentPreset ?? '无'}，系统提示词 ${s.systemPrompt.length} 字）`);
        return rpcOk({ sessionId: id });
      },

      async prompt({ sessionId, content, system } = {}) {
        // 进程重启后内存里没有这个会话，但磁盘上有：先恢复再跑，别让重启等于失忆。
        const s = sessions.get(sessionId) ?? loadSession(sessionId);
        if (!s) return rpcFail('not-found', `session ${sessionId} 不存在`);
        const blocks = Array.isArray(content) ? content : [];
        const textBlocks = blocks
          .filter((b) => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text);
        // bridge 内联进来的图片是 { mimeType, data } 形状（没有 type 字段），
        // 以前这里只挑 text 块，图就被丢在了门口。转成 image_url 一起带过去。
        const imageBlocks = blocks
          .filter((b) => b && typeof b.mimeType === 'string' && typeof b.data === 'string' && b.data)
          .slice(0, MAX_TOOL_IMAGES);
        // 角色卡走 system、不进历史：它每轮都该在，但不该被存进对话里。
        // 存进去的话，历史里会堆出重复卡片，浪费上下文预算。
        // 只放内存：进程重启后内存里没有，下一轮 bridge 会重新带过来。
        if (typeof system === 'string' && system.trim()) s.roleCard = system.trim();
        const userText = textBlocks.join('\n').trim();
        if (!userText && !imageBlocks.length) return rpcFail('invalid', 'prompt 内容为空');
        s.abort = new AbortController();
        const userContent = imageBlocks.length
          ? [
              { type: 'text', text: userText || '（对方发来一张图片）' },
              ...imageBlocks.map((b) => ({ type: 'image_url', image_url: { url: `data:${b.mimeType};base64,${b.data}` } }))
            ]
          : userText;
        // 串行：同一个会话上的多个 prompt 排队，不并发打模型。
        s.chain = s.chain.then(() => runTurn(s, userContent)).catch(() => {});
        return rpcOk({ accepted: true });
      },

      async selectModel({ sessionId, provider, model } = {}) {
        const s = sessions.get(sessionId) ?? loadSession(sessionId);
        if (!s) return rpcFail('not-found', `session ${sessionId} 不存在`);
        s.model = model ? `${provider ?? ''}/${model}` : null;
        saveSession(s);
        return rpcOk({ selected: { provider: provider ?? null, model: model ?? null } });
      },

      async list() {
        return rpcOk({ sessions: [...sessions.values()].map((s) => ({ sessionId: s.id, workspaceId: s.workspaceId, preset: s.preset })) });
      }
    },

    settings: {
      async describe() {
        // bridge 的 refreshMode 会去 namespaces 里找 qq-mode / agent-presets。
        // standalone 没有 DSH 设置页，给空数组让它回退到 state/mode.json 与 config.json。
        return rpcOk({ namespaces: [], ...settings });
      },
      async update({ ns, patch } = {}) {
        settings = { ...settings, [ns]: { ...(settings[ns] ?? {}), ...(patch ?? {}) } };
        writeJsonFile(settingsFile, settings);
        return rpcOk({ ok: true });
      }
    },

    agentPresets: {
      async list() {
        // bridge 用这个清单做 fail-closed 校验；standalone 下 preset 只是名字，
        // 真正生效的是 system prompt 文件，所以这里把磁盘上的 preset 目录原名报回去。
        const dir = path.join(ROOT, 'dsh', 'agent-presets');
        let names = [];
        try {
          names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
        } catch {}
        return rpcOk({ presets: names.map((name) => ({ id: name, name })) });
      }
    },

    events: {
      follow(sessionId) {
        followed.add(sessionId);
        const s = loadSession(sessionId);
        if (!s) return;
        // 开场快照：给 token 账本用，含历史 turn/end（bridge 会把它和实时事件分开处理）。
        emit(sessionId, {
          sessionId,
          messages: s.messages.slice(-50).map((m) => ({ role: m.role, content: m.content })),
          projections: {}
        }, { snapshot: true });
      },
      forget(sessionId) {
        followed.delete(sessionId);
      },
      mux({ signal } = {}) {
        return bus.stream(signal);
      }
    },

    async respond() {
      // standalone 的工具在进程内直接跑，不存在“等客户端执行工具”的链路；保持成功让调用方继续。
      return rpcOk({ ok: true });
    },

    async stopSessionWork(sessionId) {
      const s = sessions.get(sessionId);
      if (s?.abort) s.abort.abort();
      return rpcOk({ ok: true });
    },
    async callUnary(method) {
      const c = llmConfig();
      if (method === 'session.modelCatalog' || method === 'session.models') {
        return rpcOk({
          providers: [{
            id: 'standalone',
            name: 'Standalone',
            models: [{ id: c.model, name: c.model, contextWindow: 128000 }]
          }]
        });
      }
      return rpcFail('unsupported', `standalone 不支持 ${method}`);
    },

    /** bridge.js 退出时调用，关掉工具子进程。 */
    async dispose() {
      await tools.dispose();
    }
  };

  log(`[standalone] backend 就绪：${llmConfig().baseUrl} / ${llmConfig().model}`);
  return backend;
}
