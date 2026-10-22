// 把 dsh/agent-presets/<preset>/agent.cordis.yml 的 persona.prefix 抽成纯文本
// resources/prompts/<preset>.md，供 standalone 后端直接读取（node:fs 动态加载）。
//
// 单一事实源仍然是 preset YAML（DSH 与 standalone 共用一套规则），这里只是把它
// 导出成运行期不需要 YAML 解析的形态。工具名保持 DSH 全名不动，standalone 加载时
// 会去掉 mcp__ 前缀。
//
// 用法：node scripts/sync-standalone-prompts.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const presetsDir = path.join(ROOT, 'dsh', 'agent-presets');
const outDir = path.join(ROOT, 'resources', 'prompts');

fs.mkdirSync(outDir, { recursive: true });

let count = 0;
for (const name of fs.readdirSync(presetsDir)) {
  const ymlFile = path.join(presetsDir, name, 'agent.cordis.yml');
  if (!fs.existsSync(ymlFile)) continue;
  let prefix = '';
  try {
    const loaded = yaml.load(fs.readFileSync(ymlFile, 'utf8'));
    const entry = Array.isArray(loaded) ? loaded.find((item) => item?.id === 'persona') : null;
    prefix = typeof entry?.config?.prefix === 'string' ? entry.config.prefix : '';
  } catch (err) {
    console.error(`[prompts] ${name}: YAML 解析失败 - ${err.message}`);
    continue;
  }
  if (!prefix.trim()) {
    console.warn(`[prompts] ${name}: 没有 persona.prefix，跳过`);
    continue;
  }
  const outFile = path.join(outDir, `${name}.md`);
  fs.writeFileSync(outFile, `${prefix.trim()}\n`, 'utf8');
  console.log(`[prompts] ${name}.md  ${prefix.trim().length} 字`);
  count += 1;
}
console.log(`[prompts] 完成，共 ${count} 个预设`);
