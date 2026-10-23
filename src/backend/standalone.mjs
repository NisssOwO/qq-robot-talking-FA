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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const MAX_STEPS = 12;            // 单回合最多“模型→工具”往返次数
const DEFAULT_HISTORY_CHARS = 120000; // 触发裁剪的历史字符预算（约 60K token）
const KEEP_RECENT_MESSAGES = 24;      // 裁剪时最少保留的最近消息条数

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

export function createStandaloneBackend(cfg, { log = () => {} } = {}) {
  const llm = cfg?.llm ?? {};
  const stateDir = path.join(ROOT, cfg?.stateDir ? String(cfg.stateDir) : 'state', 'standalone');
  const sessionsDir = path.join(stateDir, 'sessions');
  const metaFile = path.join(stateDir, 'meta.json');
  const settingsFile = path.join(stateDir, 'settings.json');

  const tools = createToolRegistry({ log });

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

  function saveSession(s) {
    try {
      writeJsonFile(sessionFile(s.id), {
        id: s.id,
        workspaceId: s.workspaceId,
        preset: s.preset,
        model: s.model,
        messages: s.messages,
        summary: s.summary ?? '',
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

  async function callOpenAiCompletions({ messages, tools: toolDefs, signal }) {
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
        throw new Error(`模型接口 ${response.status}：${textBody.slice(0, 500)}`);
      }
      let json;
      try {
        json = JSON.parse(textBody);
      } catch {
        throw new Error(`模型接口返回非 JSON：${textBody.slice(0, 300)}`);
      }
      const message = json?.choices?.[0]?.message ?? {};
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      return {
        content: typeof message.content === 'string' ? message.content : '',
        toolCalls,
        usage: json?.usage ?? null,
        finishReason: json?.choices?.[0]?.finish_reason ?? null
      };
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
  function buildRequestMessages(s) {
    const systemParts = [];
    if (s.systemPrompt) {
      // preset 里会写 {{model}}（DSH 侧由 prompt 变量机制替换）；standalone 在这里补上。
      const modelName = (s.model ?? '').split('/').pop() || llmConfig().model || 'DeepSeek';
      systemParts.push(s.systemPrompt.replace(/\{\{model\}\}/g, modelName));
    }
    if (s.summary) systemParts.push(`【更早的对话摘要】\n${s.summary}`);
    const messages = [];
    if (systemParts.length) messages.push({ role: 'system', content: systemParts.join('\n\n') });
    let total = messages.reduce((n, m) => n + String(m.content ?? '').length, 0);
    // 从最近往前挑，超过预算就停；保证最近 KEEP_RECENT_MESSAGES 条一定在。
    const picked = [];
    for (let i = s.messages.length - 1; i >= 0; i -= 1) {
      const m = s.messages[i];
      const len = String(m.content ?? '').length + JSON.stringify(m.tool_calls ?? '').length;
      if (picked.length >= KEEP_RECENT_MESSAGES && total + len > DEFAULT_HISTORY_CHARS) break;
      total += len;
      picked.unshift(m);
    }
    return { messages: messages.concat(picked), dropped: s.messages.length - picked.length };
  }

  /** 被裁掉的消息压成一段摘要（先做抽取式，避免多一次模型调用；以后可换 LLM 摘要）。 */
  function absorbDropped(s, droppedCount) {
    if (droppedCount <= 0) return;
    const head = s.messages.slice(0, droppedCount);
    const lines = [];
    for (const m of head) {
      const text = String(m.content ?? '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const who = m.role === 'user' ? '对方' : m.role === 'assistant' ? '自己' : m.role;
      lines.push(`${who}：${text.slice(0, 160)}`);
    }
    const merged = [s.summary, ...lines].filter(Boolean).join('\n');
    // 摘要本身也有上限，超了就从最老的截掉。
    s.summary = merged.length > 4000 ? merged.slice(merged.length - 4000) : merged;
    s.messages.splice(0, droppedCount);
  }

  // ── 一个回合：模型 ↔ 工具 循环 ─────────────────────────────────────────────
  async function runTurn(s, userText) {
    const turn = ++s.turnSeq;
    meta.turnSeq = (meta.turnSeq ?? 0) + 1;
    s.messages.push({ role: 'user', content: userText });
    emit(s.id, { type: 'turn/start', data: { turn } });

    let finalText = '';
    try {
      const toolDefs = (await tools.list()).map((t) => tools.toOpenAiTool(t));
      for (let step = 0; step < MAX_STEPS; step += 1) {
        const { messages, dropped } = buildRequestMessages(s);
        absorbDropped(s, dropped);
        // 调试用：把实际发给模型的请求落盘，方便核对 system/角色卡是否真的进去了。
        try {
          if (process.env.STANDALONE_DEBUG_PROMPT === '1') {
            const dir = path.join(ROOT, 'state', 'standalone');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'last-request.json'), JSON.stringify({
              at: nowIso(),
              systemChars: String(messages[0]?.content ?? '').length,
              userChars: String(messages[messages.length - 1]?.content ?? '').length,
              messages
            }, null, 1));
          }
        } catch {}
        const reply = await chat({ messages, tools: toolDefs, signal: s.abort?.signal });
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

        for (let i = 0; i < reply.toolCalls.length; i += 1) {
          const tc = reply.toolCalls[i];
          const callId = callIds[i];
          const name = tc.function?.name ?? '';
          const args = parseToolArgs(tc.function?.arguments);
          emit(s.id, { type: 'tool/call', data: { name, callId, arguments: args } });
          const result = await tools.call(name, args);
          emit(s.id, {
            type: 'tool/result',
            data: {
              message: {
                role: 'tool',
                source: { callId, name },
                content: [{ type: 'text', text: result.text, isError: result.isError }],
                isError: result.isError
              }
            }
          });
          s.messages.push({ role: 'tool', tool_call_id: callId, content: result.text });
        }
      }
    } catch (error) {
      const message = String(error?.message ?? error);
      log(`[standalone] 回合失败（${s.id}）：${message}`);
      emit(s.id, { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text: `（回合失败：${message}）` }] } } });
    } finally {
      s.abort = null;
      log(`[standalone] 回合结束（${s.id}）：messages=${s.messages.length}`);
      saveSession(s);
      emit(s.id, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
    }
    return finalText;
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

      async prompt({ sessionId, content } = {}) {
        // 进程重启后内存里没有这个会话，但磁盘上有：先恢复再跑，别让重启等于失忆。
        const s = sessions.get(sessionId) ?? loadSession(sessionId);
        if (!s) return rpcFail('not-found', `session ${sessionId} 不存在`);
        const textBlocks = (content ?? [])
          .filter((b) => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text);
        const userText = textBlocks.join('\n').trim();
        if (!userText) return rpcFail('invalid', 'prompt 内容为空');
        s.abort = new AbortController();
        // 串行：同一个会话上的多个 prompt 排队，不并发打模型。
        s.chain = s.chain.then(() => runTurn(s, userText)).catch(() => {});
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
