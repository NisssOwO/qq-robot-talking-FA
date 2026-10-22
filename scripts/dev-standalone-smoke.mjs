// standalone 后端冒烟测试：不联网、不花 token。
//
// 起一个假的 OpenAI 兼容服务，第一轮返回 tool_calls(qq_status)，第二轮返回纯文本，
// 断言桥接会看到的事件序列：turn/start → tool/call → tool/result → assistant/message → turn/end。
//
// 用法：node scripts/dev-standalone-smoke.mjs

import http from 'node:http';
import { createStandaloneBackend } from '../src/backend/standalone.mjs';

const calls = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const payload = JSON.parse(body || '{}');
    calls.push(payload);
    const hasToolResult = (payload.messages ?? []).some((m) => m.role === 'tool');
    const message = hasToolResult
      ? { role: 'assistant', content: 'いるよ！在呢～' }
      : {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'qq_status', arguments: '{}' } }]
        };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message, finish_reason: hasToolResult ? 'stop' : 'tool_calls' }], usage: { total_tokens: 1 } }));
  });
});

const port = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

const cfg = {
  backend: 'standalone',
  llm: { protocol: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'fake-model', temperature: 0 },
  stateDir: 'state-smoke'
};

const backend = createStandaloneBackend(cfg, { log: (l) => console.log(l) });
const frames = [];
(async () => {
  try {
    const created = await backend.sessions.create({ workspaceId: 'ws-1', agentPreset: 'qq-chat-v2' });
    const sessionId = created.result.value.sessionId;
    backend.events.follow(sessionId);
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待 turn/end 超时')), 20000);
      (async () => {
        for await (const envelope of backend.events.mux({})) {
          const frame = envelope.payload;
          if (frame.sessionId !== sessionId) continue;
          frames.push(frame);
          if (frame.type === 'session/event' && frame.event.type === 'turn/end') {
            clearTimeout(timer);
            resolve();
            return;
          }
        }
      })().catch(reject);
    });
    await backend.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: '在吗？' }] });
    await done;

    const seq = frames.filter((f) => f.type === 'session/event').map((f) => f.event.type);
    console.log('事件序列:', seq.join(' → '));
    const text = frames
      .filter((f) => f.type === 'session/event' && f.event.type === 'assistant/message')
      .map((f) => f.event.data.message.content.map((b) => b.text).join(''))
      .join('');
    console.log('assistant 文本:', JSON.stringify(text));
    console.log('模型调用次数:', calls.length);
    console.log('工具结果回填:', calls[1]?.messages?.some((m) => m.role === 'tool'));
    const system = calls[0]?.messages?.find((m) => m.role === 'system')?.content ?? '';
    console.log('系统提示词:', system.length, '字 / 含工具名替换:', system.includes('qq_send_message') && !system.includes('mcp__snowluma__'));
    console.log('工具定义数:', calls[0]?.tools?.length ?? 0);

    const ok = seq.includes('turn/start') && seq.includes('tool/call') && seq.includes('tool/result')
      && seq.includes('assistant/message') && seq.at(-1) === 'turn/end'
      && text.includes('いるよ') && calls.length === 2
      && system.length > 2000 && !system.includes('mcp__snowluma__') && (calls[0]?.tools?.length ?? 0) > 0;

    // ── 第二步：模拟进程重启（新 backend 指向同一个 stateDir），验证会话能恢复、人设不丢 ──
    await backend.dispose();
    const backend2 = createStandaloneBackend(cfg, { log: (l) => console.log(l) });
    const before = calls.length;
    const r2 = await backend2.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: '还在吗？' }] });
    const resumed = r2?.result?.ok === true;
    // 等第二轮真正打完（假 server 收到新请求）
    for (let i = 0; i < 100 && calls.length < before + 2; i += 1) await new Promise((r) => setTimeout(r, 100));
    const systemAfter = calls[calls.length - 1]?.messages?.find((m) => m.role === 'system')?.content ?? '';
    const historyRestored = (calls[calls.length - 1]?.messages ?? []).some((m) => m.content === '在吗？');
    console.log('重启恢复: prompt 受理=' + resumed + ' / 系统提示词=' + systemAfter.length + ' 字 / 旧消息=' + historyRestored);
    await backend2.dispose();

    const okAll = ok && resumed && systemAfter.length > 2000 && historyRestored;
    console.log(okAll ? 'SMOKE OK' : 'SMOKE FAILED');
    process.exitCode = okAll ? 0 : 1;
  } finally {
    await backend.dispose();
    server.close();
  }
})();
