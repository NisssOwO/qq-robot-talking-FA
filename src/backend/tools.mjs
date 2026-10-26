// standalone 后端的工具层：把现有的 MCP server 当子进程用，不重写任何工具。
//
// 为什么不进程内重构：`mcp-snowluma-safe.js` 里的 handler 直接依赖 OneBot HTTP 与
// 白名单校验，而且 DSH 后端仍要用它（同一份实现、两种挂载方式）。子进程方案让
// “工具只有一份实现”这件事继续成立，代价只是多一次 stdio 往返（亚毫秒级）。
//
// 现在挂两个 server：
//   - snowluma：35 个 QQ 工具（qq_*）
//   - web-search-safe：web_search / web_fetch
// 工具名在整个 registry 里必须唯一，否则调用会路由错——两个 server 恰好不重名，
// 但仍保留 owner 映射，以后新增 server 时按“先到先得”报错而不是静默覆盖。
//
// 生命周期：第一次 list() 时懒启动，进程退出时 dispose()。某个 server 崩溃后
// 只会重连那一个，不影响另一个。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

/** 要挂的 MCP server 清单。name 只用于日志，script 相对 src/。 */
const SERVERS = [
  { name: 'snowluma', label: 'QQ 工具', script: path.join(ROOT, 'src', 'mcp-snowluma-safe.js') },
  { name: 'web', label: '联网搜索', script: path.join(ROOT, 'src', 'mcp-web-search-safe.js') }
];

/** OpenAI tools[] 形状里的单条。 */
function toOpenAiTool(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      // 没有参数的工具在 OpenAI 侧也必须给 properties，否则部分供应商会 400。
      parameters: tool.inputSchema ?? { type: 'object', properties: {} }
    }
  };
}

/** 从 MCP 的 result 里抽出给模型看的纯文本。 */
function resultText(result) {
  const parts = [];
  for (const block of result?.content ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block?.type === 'image') parts.push('[图片]');
    else if (block?.type === 'audio') parts.push('[音频]');
  }
  const text = parts.join('\n').trim();
  return text || '(工具没有返回内容)';
}

/**
 * 把 MCP 返回的图片块单独抽出来。
 *
 * resultText 只能给模型看文本；OpenAI 兼容接口的 tool 消息内容必须是字符串，
 * 图片得作为**紧随其后的 user 消息**里的 image_url 传下去，模型才真的看得到。
 * 这里只负责搬运，具体怎么塞由调用方决定。
 */
function resultImages(result) {
  const out = [];
  for (const block of result?.content ?? []) {
    if (block?.type === 'image' && typeof block.data === 'string' && block.data && typeof block.mimeType === 'string') {
      out.push({ mimeType: block.mimeType, data: block.data });
    }
  }
  return out;
}

export function createToolRegistry({ log = () => {} } = {}) {
  /** 每个 server 一个连接槽：{ client, connecting, label } */
  const slots = new Map(SERVERS.map((s) => [s.name, { spec: s, client: null, connecting: null, label: s.label }]));
  let cachedTools = null;
  let owner = new Map(); // toolName -> serverName

  async function connectOne(name) {
    const slot = slots.get(name);
    if (!slot) throw new Error(`未知的工具 server：${name}`);
    if (slot.client) return slot.client;
    if (slot.connecting) return slot.connecting;
    slot.connecting = (async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [slot.spec.script],
        cwd: ROOT,
        env: { ...process.env },
        stderr: 'pipe'
      });
      const c = new Client({ name: `qq-standalone-${name}`, version: '0.1.0' });
      await c.connect(transport);
      slot.client = c;
      log(`[standalone] ${slot.label}进程已连接（stdio MCP）`);
      return c;
    })();
    try {
      return await slot.connecting;
    } finally {
      slot.connecting = null;
    }
  }

  async function list() {
    if (cachedTools) return cachedTools;
    const merged = [];
    const seen = new Map();
    for (const name of slots.keys()) {
      let tools = [];
      try {
        const c = await connectOne(name);
        tools = (await c.listTools()).tools ?? [];
      } catch (error) {
        // 单个 server 起不来不该让整轮瘫痪：有 QQ 工具就能跑，搜索只是少一项能力。
        log(`[standalone] ${slots.get(name).label}加载失败：${error?.message ?? error}`);
        continue;
      }
      for (const tool of tools) {
        if (seen.has(tool.name)) {
          log(`[standalone] 工具名冲突，忽略 ${name} 的 ${tool.name}（已被 ${seen.get(tool.name)} 占用）`);
          continue;
        }
        seen.set(tool.name, name);
        merged.push(tool);
      }
      log(`[standalone] 已加载 ${tools.length} 个${slots.get(name).label}`);
    }
    owner = seen;
    cachedTools = merged;
    return cachedTools;
  }

  /** @returns {Promise<{text: string, isError: boolean, images: Array<{mimeType: string, data: string}>}>} */
  async function call(name, args) {
    const serverName = owner.get(name);
    if (!serverName) {
      // list() 还没跑过（或者这是个老模型幻觉出来的名字）：先建索引再判一次。
      try { await list(); } catch {}
    }
    const target = owner.get(name);
    if (!target) return { text: `没有名为 ${name} 的工具`, isError: true, images: [] };
    let c;
    try {
      c = await connectOne(target);
    } catch (error) {
      return { text: `工具进程启动失败：${error?.message ?? error}`, isError: true, images: [] };
    }
    try {
      const result = await c.callTool({ name, arguments: args ?? {} });
      const isError = result?.isError === true;
      return { text: resultText(result), isError, images: resultImages(result) };
    } catch (error) {
      // 子进程崩溃：丢掉这个 server 的句柄，下一次调用重连一次。
      const slot = slots.get(target);
      try { await c.close(); } catch {}
      if (slot) slot.client = null;
      cachedTools = null;
      return { text: `工具调用失败（${name}）：${error?.message ?? error}`, isError: true, images: [] };
    }
  }

  async function dispose() {
    const closing = [];
    for (const slot of slots.values()) {
      const c = slot.client;
      slot.client = null;
      if (c) closing.push(c.close().catch(() => {}));
    }
    cachedTools = null;
    owner = new Map();
    await Promise.all(closing);
  }

  return { list, call, dispose, toOpenAiTool };
}
