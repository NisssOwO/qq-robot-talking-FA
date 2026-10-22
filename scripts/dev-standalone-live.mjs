// standalone 真实模型联调：用 config.json 里的 llm 段（或 CLI 参数）跑一轮完整回合，
// 验证“真模型能按系统提示词正确调用 QQ 工具、结果能回填、最终文本能产出”。
//
// 只做只读工具，不会往 QQ 发消息（prompt 里硬性禁止）。
//
// 用法：
//   node scripts/dev-standalone-live.mjs --config dist/qq-bot/config.json
//   node scripts/dev-standalone-live.mjs grok-4.6            # 走 GROK_BASE + GROK_API_KEY
//
// key 来源：--config 指定文件的 llm.apiKey；否则环境变量 GROK_API_KEY，
//           再否则读 ~/.dsh/.credentials.yaml 里的 GROK_API_KEY 行。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStandaloneBackend } from '../src/backend/standalone.mjs';

const argv = process.argv.slice(2);
const configPath = argv.includes('--config') ? argv[argv.indexOf('--config') + 1] : '';
const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--config');

function readGrokKey() {
  if (process.env.GROK_API_KEY) return process.env.GROK_API_KEY;
  const file = path.join(os.homedir(), '.dsh', '.credentials.yaml');
  try {
    const text = fs.readFileSync(file, 'utf8');
    const m = text.match(/GROK_API_KEY:\s*["']?([^"'\s]+)/);
    return m?.[1] ?? '';
  } catch {
    return '';
  }
}

let llm;
if (configPath) {
  const cfgFile = JSON.parse(fs.readFileSync(path.resolve(configPath), 'utf8'));
  llm = { ...(cfgFile.llm ?? {}) };
  llm.model = positional[0] || llm.model;
  console.log(`[live] 使用配置 ${configPath}：${llm.baseUrl} / ${llm.model}`);
} else {
  const model = positional[0] || 'grok-4.6';
  const apiKey = readGrokKey();
  if (!apiKey) {
    console.log('NO_KEY: 没找到 GROK_API_KEY');
    process.exit(1);
  }
  llm = { protocol: 'openai-completions', baseUrl: process.env.GROK_BASE || 'https://ai.beimo.cc/v1', apiKey, model, maxTokens: 4000, temperature: 0.3, timeoutMs: 180000 };
}
if (!llm.apiKey) {
  console.log('NO_KEY: 配置里 llm.apiKey 是空的');
  process.exit(1);
}
llm.maxTokens ||= 4000;
llm.timeoutMs ||= 180000;

const cfg = {
  backend: 'standalone',
  llm,
  stateDir: 'state-live'
};

const backend = createStandaloneBackend(cfg, { log: (l) => console.log(l) });
const frames = [];
const started = Date.now();

(async () => {
  try {
    const created = await backend.sessions.create({ workspaceId: 'ws-live', agentPreset: 'qq-chat-v2' });
    const sessionId = created.result.value.sessionId;
    backend.events.follow(sessionId);
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待 turn/end 超时（180s）')), 180000);
      (async () => {
        for await (const envelope of backend.events.mux({})) {
          const frame = envelope.payload;
          if (frame.sessionId !== sessionId || frame.type !== 'session/event') continue;
          frames.push(frame);
          if (frame.event.type === 'turn/end') {
            clearTimeout(timer);
            resolve();
            return;
          }
        }
      })().catch(reject);
    });

    await backend.sessions.prompt({
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: '只调用只读工具确认一下当前登录状态（qq_status），然后用一句日语+中文字幕告诉我结果。绝对不要调用任何发送类工具。' }]
    });
    await done;

    const events = frames.map((f) => f.event);
    const toolCalls = events.filter((e) => e.type === 'tool/call').map((e) => e.data.name);
    const toolResults = events.filter((e) => e.type === 'tool/result');
    const text = events
      .filter((e) => e.type === 'assistant/message')
      .map((e) => e.data.message.content.map((b) => b.text).join(''))
      .join('');
    console.log('\n--- 结果 ---');
    console.log('耗时:', ((Date.now() - started) / 1000).toFixed(1), 's');
    console.log('工具调用:', toolCalls.join(', ') || '(无)');
    console.log('工具错误数:', toolResults.filter((e) => e.data.message.content.some((b) => b.isError)).length);
    console.log('最终文本:', JSON.stringify(text.slice(0, 400)));
    const ok = toolCalls.includes('qq_status') && text.trim().length > 0;
    console.log(ok ? 'LIVE OK' : 'LIVE FAILED');
    process.exitCode = ok ? 0 : 1;
  } catch (err) {
    console.error('LIVE ERROR:', err.message);
    process.exitCode = 1;
  } finally {
    await backend.dispose();
  }
})();
