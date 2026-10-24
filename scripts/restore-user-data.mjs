// 把源码目录里的真实配置与运行数据补进发布包（dist/qq-bot）。
// 发布包重建会清空 state，所以每次重建都要能一键补回来。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'F:/产出/shiny colors';
const SRC_CFG = path.join(ROOT, 'config.json');
const DST_CFG = path.join(ROOT, 'dist/qq-bot/config.json');
const SRC_STATE = path.join(ROOT, 'state');
const DST_STATE = path.join(ROOT, 'dist/qq-bot/state');

// 这些键属于「用户自己的数据」，带过去；其余保持发布包默认值。
const CARRY = [
  'gateway', 'snowluma',
  'allow', 'deny', 'allowAllWhenEmpty', 'ownerQQ', 'ackMessage',
  'sendDelayMs', 'questionTimeoutMs', 'quietHours',
  'role', 'consolePort', 'consoleToken', 'pricing', 'security',
  'slang', 'social', 'socialV2', 'tts', 'webSearch',
  'agentPreset', 'workspaceTitle', 'sessionCwd'
];

const cfg = JSON.parse(fs.readFileSync(DST_CFG, 'utf8'));
const src = JSON.parse(fs.readFileSync(SRC_CFG, 'utf8'));
const carried = [];
for (const k of CARRY) {
  if (src[k] === undefined) continue;
  cfg[k] = src[k];
  carried.push(k);
}
fs.writeFileSync(DST_CFG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
console.log('config 已补:', carried.join(', '));

// llm 单独处理：发布包模板会清空 apiKey，但本机要能直接用（用户自己的 key 在他自己机器上）。
// 只补这三项，baseUrl/model/apiKey 一起才有意义。
if (src.llm && src.llm.apiKey) {
  cfg.llm = { ...cfg.llm, ...src.llm };
  fs.writeFileSync(DST_CFG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  console.log('  llm 已补:', src.llm.model, '(key', String(src.llm.apiKey).length, '字符)');
}
console.log('  allow:', JSON.stringify(cfg.allow));
console.log('  ownerQQ:', cfg.ownerQQ, '| tts key:', cfg.tts?.apiKey ? '有' : '无');

// 运行数据
const FILES = [
  'social-v2.json', 'slang.json', 'stickers.json', 'current-role.json',
  'mode.json', 'sessions.json', 'holidays-cn.json',
  'token-usage.jsonl', 'tool-calls.jsonl',
  'qq-activity.log', 'qq-activity.log.1',
  'bridge.log', 'bridge.log.1', 'console-token'
];
fs.mkdirSync(DST_STATE, { recursive: true });
const copied = [];
for (const f of FILES) {
  const from = path.join(SRC_STATE, f);
  if (!fs.existsSync(from)) { console.log('  跳过（不存在）:', f); continue; }
  const to = path.join(DST_STATE, f);
  fs.copyFileSync(from, to);
  copied.push(f + '(' + Math.round(fs.statSync(to).size / 1024) + 'KB)');
}
console.log('state 已补:', copied.join(', '));
