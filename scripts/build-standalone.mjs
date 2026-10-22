// 打包独立版（绿色目录）：把 bridge + standalone 后端 + node.exe + 资源复制到
// 一个目录里，拷到任何 Windows 机器上双击 start.bat 就能跑，不需要 DSH、不需要 npm install。
//
// 用法：
//   node scripts/build-standalone.mjs                 # 输出到 dist\qq-bot
//   node scripts/build-standalone.mjs --out D:\qq-bot
//   node scripts/build-standalone.mjs --no-node       # 不复制 node.exe（目标机自带 node 时用）
//
// 生成物里 config.json 是**模板**：backend=standalone、llm.apiKey 留空，由使用者填。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const outArg = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'dist/qq-bot';
const OUT = path.resolve(ROOT, outArg);
const withNode = !argv.includes('--no-node');

// 安全闸：只允许删 dist/ 下的目标或显式给了 --out 的目录，避免手滑删掉项目。
if (fs.existsSync(OUT)) {
  const underDist = OUT.startsWith(path.join(ROOT, 'dist') + path.sep);
  if (!underDist && !argv.includes('--out')) {
    console.error(`拒绝覆盖 ${OUT}：不在 dist/ 下，且没有显式 --out。`);
    process.exit(1);
  }
  if (!argv.includes('--force')) {
    console.log(`目标已存在，先清空：${OUT}`);
  }
  fs.rmSync(OUT, { recursive: true, force: true });
}
fs.mkdirSync(OUT, { recursive: true });

function copyDir(from, to, { skip = [] } = {}) {
  if (!fs.existsSync(from)) return 0;
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip.includes(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      n += copyDir(src, dst, { skip });
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      try {
        fs.copyFileSync(src, dst);
        n += 1;
      } catch (err) {
        // node_modules 里偶尔有 .package-lock.json 这类链接/占位文件，复制不了也不影响运行。
        console.warn(`  跳过 ${path.relative(ROOT, src)}（${err.code}）`);
      }
    }
  }
  return n;
}

const report = [];
function step(label, fn) {
  const n = fn();
  report.push(`${label}: ${n}`);
}

// 1) 源码
step('src', () => copyDir(path.join(ROOT, 'src'), path.join(OUT, 'src')));

// 1b) 配置向导（app/setup.mjs，start.bat 起不来时先开它）
step('app', () => copyDir(path.join(ROOT, 'app'), path.join(OUT, 'app')));

// 2) 依赖（运行期只需要 dependencies；node_modules 里没有原生模块）
step('node_modules', () => copyDir(path.join(ROOT, 'node_modules'), path.join(OUT, 'node_modules'), { skip: ['.bin', '.cache'] }));

// 2b) SnowLuma（QQ 网关）：整包带上，启动器负责拉起它
const SNOWLUMA_OUT = path.join(OUT, 'snowluma');
step('snowluma', () => copyDir(path.join(ROOT, 'SnowLuma-v2.0.3-win-x64'), SNOWLUMA_OUT, { skip: ['logs'] }));
// 账号隐私不外带：删掉已登录账号的配置与会话数据，使用者首次运行时扫码登录。
function pruneSnowLumaAccount() {
  let removed = 0;
  const cfgDir = path.join(SNOWLUMA_OUT, 'config');
  const dataDir = path.join(SNOWLUMA_OUT, 'data');
  if (fs.existsSync(cfgDir)) {
    for (const name of fs.readdirSync(cfgDir)) {
      if (/^onebot_\d+\.json$/.test(name)) {
        fs.rmSync(path.join(cfgDir, name), { force: true });
        removed += 1;
      }
    }
  }
  if (fs.existsSync(dataDir)) {
    for (const name of fs.readdirSync(dataDir)) {
      fs.rmSync(path.join(dataDir, name), { recursive: true, force: true });
      removed += 1;
    }
  }
  fs.mkdirSync(path.join(SNOWLUMA_OUT, 'logs'), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  return removed;
}
if (fs.existsSync(SNOWLUMA_OUT)) {
  report.push(`snowluma: 已清理账号数据 ${pruneSnowLumaAccount()} 项（首次运行需扫码登录）`);
}

// 3) 资源：角色卡 / 世界观 / 提示词 / 静态资源 / 音频
step('roles', () => copyDir(path.join(ROOT, 'roles'), path.join(OUT, 'roles')));
step('resources', () => copyDir(path.join(ROOT, 'resources'), path.join(OUT, 'resources')));
step('dsh/agent-presets', () => copyDir(path.join(ROOT, 'dsh', 'agent-presets'), path.join(OUT, 'dsh', 'agent-presets')));
for (const name of ['world.json', 'assets', 'audio', 'public']) {
  const from = path.join(ROOT, name);
  if (!fs.existsSync(from)) continue;
  const dst = path.join(OUT, name);
  if (fs.statSync(from).isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    step(name, () => copyDir(from, dst));
  } else {
    fs.copyFileSync(from, dst);
    report.push(`${name}: 1`);
  }
}

// 4) node.exe
if (withNode) {
  const exe = process.execPath;
  if (!/node(\.exe)?$/i.test(exe)) {
    console.warn(`⚠️ process.execPath 是 ${exe}，不是 node.exe；跳过（用 --no-node 显式跳过）`);
  } else {
    fs.copyFileSync(exe, path.join(OUT, 'node.exe'));
    report.push(`node.exe: ${path.basename(exe)} (${(fs.statSync(exe).size / 1048576).toFixed(1)} MB)`);
  }
}

// 5) 配置模板：backend=standalone，apiKey 留空
const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
const standaloneCfg = {
  ...example,
  backend: 'standalone',
  llm: {
    ...(example.llm ?? {}),
    protocol: 'openai-completions',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat'
  }
};
fs.writeFileSync(path.join(OUT, 'config.json'), `${JSON.stringify(standaloneCfg, null, 2)}\n`, 'utf8');
report.push('config.json: 模板（backend=standalone，llm.apiKey 留空）');

// 6) state 目录（空）
fs.mkdirSync(path.join(OUT, 'state'), { recursive: true });
report.push('state/: 空目录');

// 7) 启动脚本（面板版：一个窗口里配置 + 起网关 + 起机器人 + 看日志）
const panelBat = [
  '@echo off',
  'chcp 65001 >nul',
  'cd /d "%~dp0"',
  'if not exist node.exe (',
  '  echo [错误] 找不到 node.exe。请把 node.exe 放到本目录。',
  '  pause',
  '  exit /b 1',
  ')',
  'echo 正在打开控制面板……',
  'node.exe app\\ui.mjs',
  'echo.',
  'echo 面板已关闭（本窗口启动的网关/机器人已一并停止）。按任意键退出。',
  'pause >nul',
  ''
].join('\r\n');
fs.writeFileSync(path.join(OUT, 'start.bat'), panelBat, 'utf8');
report.push('start.bat: 已生成（打开控制面板）');

fs.writeFileSync(path.join(OUT, 'setup.bat'), panelBat, 'utf8');
report.push('setup.bat: 已生成（同名面板，改配置用）');

// 7b) 双击入口 exe：把 app/launcher.cs 用系统自带的 csc 编成「QQ聊天机器人.exe」。
// 它只是在后台把 node.exe app\ui.mjs 拉起来（没有黑窗口），找不到编译器就跳过，start.bat 仍能跑。
const CSC_CANDIDATES = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe'
];
const csc = CSC_CANDIDATES.find((p) => fs.existsSync(p));
const launcherSrc = path.join(ROOT, 'app', 'launcher.cs');
const launcherExe = path.join(OUT, 'QQ聊天机器人.exe');
if (csc && fs.existsSync(launcherSrc)) {
  try {
    execFileSync(csc, [
      '-nologo', '-target:winexe', '-codepage:65001',
      `-out:${launcherExe}`,
      '-reference:System.Windows.Forms.dll',
      launcherSrc
    ], { stdio: 'pipe' });
    report.push(`QQ聊天机器人.exe: 已生成（${(fs.statSync(launcherExe).size / 1024).toFixed(0)} KB，双击即用）`);
  } catch (error) {
    report.push(`QQ聊天机器人.exe: 编译失败（${error?.message?.split('\n')[0] ?? error}），用 start.bat 启动`);
  }
} else {
  report.push('QQ聊天机器人.exe: 跳过（本机没有 .NET 编译器），用 start.bat 启动');
}

// 8) README
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(OUT, 'README.txt'), [
  'QQ 聊天机器人 · 独立版',
  '================================',
  '',
  `版本：${pkg.version ?? 'unknown'}`,
  '不用装 Node、不用装 DSH、不用 npm install。双击「QQ聊天机器人.exe」就能用。QQ 网关（SnowLuma）已经在本目录里。',
  '',
  '【第一次使用】',
  '1. 双击「QQ聊天机器人.exe」，等几秒，会弹出「QQ 聊天机器人控制台」窗口（Edge 应用模式，没有地址栏）。',
  '2. 左边选「模型与密钥」，填这几样，点「保存配置」：',
  '   - 语言模型：接口地址（默认 https://api.deepseek.com/v1）、模型名、API Key',
  '   - 语音合成（可选）：Fish Audio 的地址和 key；不填就只有文字',
  '   - 网关接入：默认连本机自带网关，一般不用动',
  '3. 左边选「对话范围」，填群号（或好友 QQ）和管理员 QQ，保存。不填群号，机器人什么都不回。',
  '4. 回到「启动与状态」：',
  '   - 点「QQ 网关」那行的「启动」；第一次点「登录页」在弹出的页面扫码登录 QQ',
  '   - 网关变绿、QQ 上线后，点「机器人」那行的「启动」',
  '   - 最上面那张卡显示它现在在干什么：待命 / 思考中 / 观察中 / 潜水 / 静默中',
  '5. 之后每次双击「QQ聊天机器人.exe」都会自动把网关和机器人拉起来，不用再点。',
  '   如果面板已经在后台跑着，双击只会把窗口重新打开，不会起第二个进程。',
  '',
  '【关掉窗口会怎样】',
  '「启动与状态」页 → 左侧「关窗行为」，两种选择，选完会记住（下次打开还是这个）：',
  '  - 继续在后台运行（默认）：窗口关掉，机器人和网关继续跑；再双击 exe 只是把窗口重新打开。',
  '  - 一并停止机器人和网关：关窗口等于全部关掉。',
  '',
  '【改配置】',
  '- 双击「QQ聊天机器人.exe」再改也行（面板里的「模型与密钥」「对话范围」）。setup.bat 是同一个面板。',
  '- 也可以直接编辑 config.json。',
  '- 面板地址 http://127.0.0.1:3199/ ，只在本机可访问。',
  '- start.bat 是备用入口：比起 exe 多一个控制台窗口，方便看报错。',
  '',
  '【常用】',
  `- 桥接控制台：http://127.0.0.1:<consolePort>?token=<consoleToken>（默认端口 ${3100}）`,
  '- QQ 网关控制台：http://127.0.0.1:5099/',
  '- 桥接日志：state/bridge.log    网关日志：state/snowluma.log',
  '- 角色卡：roles/ 下的 .md；音色、唤醒别名、注音字典在 roles/<角色>.pack.json（面板「角色包」页改）',
  '- 登录状态保留在 snowluma\\data\\ 里，之后不用再扫码',
  '',
  '【可选：用 DSH 跑】',
  '把 config.json 的 backend 改成 "dsh"，并配好 dsh.baseUrl（默认 http://127.0.0.1:3080），',
  '就会回到连 DeepSeek Harness 的模式；两个模式共享同一份源码，随时可以切回来对照。',
  ''
].join('\r\n'), 'utf8');
report.push('README.txt: 已生成');

const sizeMb = execFileSync(process.execPath, ['-e', `
  const fs=require('fs'),path=require('path');
  let total=0;
  (function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);
    if(e.isDirectory())walk(p);else total+=fs.statSync(p).size;}})(process.argv[1]);
  console.log((total/1048576).toFixed(1));
`, OUT], { encoding: 'utf8' }).trim();

console.log('打包完成 →', OUT);
for (const line of report) console.log('  ', line);
console.log(`   合计: ${sizeMb} MB`);
