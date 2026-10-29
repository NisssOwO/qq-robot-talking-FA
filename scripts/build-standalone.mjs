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
// 打包会把目标目录整个删掉重来，所以「使用者已填好的 config.json」必须在动手之前
// 抢救出来，最后再合并回去。否则不管后面怎么写，文件早就没了——这正是 1.0.8 那次
// 打包把 dist/qq-bot 里模型 Key、群号白名单、QQ 路径全冲掉的原因。
let preservedConfig = null;
const preservedConfigPath = path.join(OUT, 'config.json');
if (fs.existsSync(preservedConfigPath)) {
  try {
    preservedConfig = JSON.parse(fs.readFileSync(preservedConfigPath, 'utf8'));
    console.log(`发现已有配置，打包结束后会合并回去（不会覆盖你填的值）：${preservedConfigPath}`);
  } catch {
    console.warn(`⚠️ 已有 config.json 解析失败，按模板重建：${preservedConfigPath}`);
  }
}

// state/ 里的东西同理，而且更隐蔽：当前角色（current-role.json）、收藏表情库、
// 会话、用量统计全在里面。打包把它清成空目录，使用者一打开就发现「人格卡没了」
// ——角色卡文件还在 roles/，丢的是「当前选的是哪一张」。发布包必须干净，所以
// 只有显式 --keep-state（本机自用构建）才抢救，release/安装包照旧清空。
const keepState = argv.includes('--keep-state');
let preservedStateDir = null;
const preservedStatePath = path.join(OUT, 'state');
if (keepState && fs.existsSync(preservedStatePath)) {
  preservedStateDir = `${OUT}-state-backup`;
  fs.rmSync(preservedStateDir, { recursive: true, force: true });
  fs.cpSync(preservedStatePath, preservedStateDir, { recursive: true });
  console.log(`发现已有 state，打包结束后会原样恢复：${preservedStatePath}`);
}

// roles/ 里的自建卡同理：面板「角色卡」页新建的卡只存在于打包版目录里，源码
// roles/ 没有它，重新打包会把整个目录删掉——1.0.8 那次就是这么丢的。--keep-state
// 时把「源码里没有的文件」先收起来，打完再放回；同名卡仍以源码为准（方便上游更新
// 内置角色），发布包不带任何个人卡。
let preservedRoleFiles = null;
const preservedRolesPath = path.join(OUT, 'roles');
if (keepState && fs.existsSync(preservedRolesPath)) {
  const sourceRolesDir = path.join(ROOT, 'roles');
  const sourceNames = new Set(fs.existsSync(sourceRolesDir) ? fs.readdirSync(sourceRolesDir) : []);
  const extra = fs
    .readdirSync(preservedRolesPath, { withFileTypes: true })
    .filter((e) => e.isFile() && !sourceNames.has(e.name))
    .map((e) => e.name);
  if (extra.length) {
    const backupDir = `${OUT}-roles-backup`;
    preservedRoleFiles = { dir: backupDir, names: extra };
    fs.rmSync(backupDir, { recursive: true, force: true });
    fs.mkdirSync(backupDir, { recursive: true });
    for (const name of extra) fs.copyFileSync(path.join(preservedRolesPath, name), path.join(backupDir, name));
    console.log(`发现 ${extra.length} 张自建角色卡，打包结束后会放回：${extra.join('、')}`);
  }
}

if (fs.existsSync(OUT)) {
  const underDist = OUT.startsWith(path.join(ROOT, 'dist') + path.sep);
  if (!underDist && !argv.includes('--out')) {
    console.error(`拒绝覆盖 ${OUT}：不在 dist/ 下，且没有显式 --out。`);
    process.exit(1);
  }
  if (!argv.includes('--force')) {
    console.log(`目标已存在，先清空：${OUT}`);
  }
  try {
    fs.rmSync(OUT, { recursive: true, force: true });
  } catch (error) {
    // 目录本身被占用（资源管理器开着、杀软扫描中、上一轮进程还没退干净）时，
    // 整棵删会直接抛 EPERM/Permission denied 并把打包停在半路；退化成"就地清空"，
    // 逐个顶层项删，删不掉的留着（反正随后会被同名新文件覆盖）。
    if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'EACCES') throw error;
    console.warn(`目录被占用，改为就地清空：${error.code}`);
    let kept = 0;
    for (const name of fs.readdirSync(OUT)) {
      try {
        fs.rmSync(path.join(OUT, name), { recursive: true, force: true });
      } catch {
        kept++;
      }
    }
    if (kept) console.warn(`有 ${kept} 个顶层项删不掉，会由随后的同名文件覆盖。`);
  }
}
fs.mkdirSync(OUT, { recursive: true });

// 个人角色卡（.gitignore 里点名排除的，如 roles/芹泽朝日.*）只属于本机：本机构建
// （--keep-state）照旧带上，发布构建（dist/release，安装包）必须剔除。判定交给
// git check-ignore，免得在脚本里硬编码名字。
function personalRoleNames() {
  const dir = path.join(ROOT, 'roles');
  if (!fs.existsSync(dir)) return new Set();
  const names = fs.readdirSync(dir).filter((n) => /\.(md|pack\.json)$/i.test(n));
  if (!names.length) return new Set();
  try {
    // -z：NUL 分隔、不转义非 ASCII 路径，否则中文卡名会变成 "roles/\350\212..." 这种转义串。
    const out = execFileSync('git', ['-C', ROOT, 'check-ignore', '--no-index', '-z', '--stdin'], {
      input: names.map((n) => `roles/${n}`).join('\0') + '\0',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return new Set(out.split('\0').map((l) => path.basename(l.trim())).filter(Boolean));
  } catch {
    // 退出码 1 = 没有被忽略的文件；git 不在 PATH 时也一样，按「没有个人卡」处理。
    return new Set();
  }
}

function copyDir(from, to, { skip = [], filter = null } = {}) {
  if (!fs.existsSync(from)) return 0;
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip.includes(entry.name)) continue;
    if (filter && !filter(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      n += copyDir(src, dst, { skip, filter });
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

// 目标目录里原本就有一份 config.json（使用者自己填过 Key/群号）时置 true。
// 一旦为 true，净化环节不许再改它的内容——那是别人的真实配置，不是发布模板。
let configPreserved = false;

// 发布内容净化：把作者本机特有的「行为偏好」从输出里去掉，让发布包保持通用
// （不把某个人的私人设定当成所有使用者的默认）。只改 OUT 里的副本，绝不修改本机源码。
function sanitizeReleaseOutput() {
  const hits = [];

  // 1) 「问候一律发语音」现在是 socialV2.greetingVoice 开关（发布版默认 false），
  //    代码本身变成通用功能，不能再删那行——删了会留下一个空的 if 块。这里什么都不做。

  // 2) preset / 提示词里的第 19 条，并把后面的编号顺延
  for (const file of [
    path.join(OUT, 'dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml'),
    path.join(OUT, 'resources', 'prompts', 'qq-chat-v2.md'),
  ]) {
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, 'utf8');
    let text = before.replace(/[ \t]*19\. 【问候一律发语音】[\s\S]*?(?=20\. 【同一话题只回一次】)/, '');
    text = text
      .replace(/([ \t]*)20\. 【同一话题只回一次】/, (_m, pad) => pad + '19. 【同一话题只回一次】')
      .replace(/([ \t]*)21\. 【被叫就直接回】/, (_m, pad) => pad + '20. 【被叫就直接回】');
    if (text !== before) {
      fs.writeFileSync(file, text, 'utf8');
      hits.push(`${path.relative(OUT, file)} 去掉第 19 条`);
    }
  }

  // 3) 角色卡里的同一条
  const rolePath = path.join(OUT, 'roles', '七草はづき.md');
  if (fs.existsSync(rolePath)) {
    const src = fs.readFileSync(rolePath, 'utf8');
    const next = src.replace(/[ \t]*- \*\*问候一律发语音\*\*[^\n]*\r?\n/g, '');
    if (next !== src) {
      fs.writeFileSync(rolePath, next, 'utf8');
      hits.push('roles/七草はづき.md 去掉问候语音规则');
    }
  }

  // 4) 配置模板里的催睡示例文案清空（保留字段，不写具体句子）
  //    ⚠️ 只在「这份 config.json 是本次刚生成的模板」时做。已有配置是使用者的真实
  //    数据，清掉他的自定义文案属于破坏，不是净化。
  const cfgPath = path.join(OUT, 'config.json');
  if (!configPreserved && fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const ns = cfg?.socialV2?.nightSticker;
    if (ns && (ns.text?.ja || ns.text?.zh)) {
      ns.text = { ja: '', zh: '' };
      fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
      hits.push('config.json 催睡示例文案清空');
    }
  }

  report.push(`净化：${hits.length ? hits.join('；') : '无需处理'}`);
}

const report = [];
function step(label, fn) {
  const n = fn();
  report.push(`${label}: ${n}`);
}

// 1) 源码
step('src', () => copyDir(path.join(ROOT, 'src'), path.join(OUT, 'src'), { filter: (name) => !/[.]bak-|[.]orig$|^[.]DS_Store$/.test(name) }));

// 1a) 版本号写进发布包（面板「版本与更新」读它；发布包里没有 package.json）
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(OUT, 'VERSION'), `${pkg.version || ''}\n`, 'utf8');
  report.push(`VERSION: ${pkg.version}`);
}

// 1b) 配置向导（app/setup.mjs，start.bat 起不来时先开它）
step('app', () => copyDir(path.join(ROOT, 'app'), path.join(OUT, 'app'), { filter: (name) => !/[.]bak-|[.]orig$|^[.]DS_Store$/.test(name) }));

// 1b) WebView2 的三个原生 dll 必须和 exe 同一层，否则双击 exe 起不来。
step('app/lib → 根目录', () => {
  const libDir = path.join(ROOT, 'app', 'lib');
  const names = fs.existsSync(libDir) ? fs.readdirSync(libDir).filter((n) => n.toLowerCase().endsWith('.dll')) : [];
  if (!names.length) return report.push('WebView2 dll: 跳过（app/lib 里没有 dll）');
  for (const name of names) fs.copyFileSync(path.join(libDir, name), path.join(OUT, name));
  report.push(`WebView2 dll: ${names.length} 个已放到根目录`);
});

// 1c) 面板会调用的运维脚本：DSH 端口检测（只有把 backend 切成 dsh 时才用得上）
step('scripts', () => {
  const from = path.join(ROOT, 'scripts', 'dsh-endpoint.mjs');
  const to = path.join(OUT, 'scripts');
  fs.mkdirSync(to, { recursive: true });
  fs.copyFileSync(from, path.join(to, 'dsh-endpoint.mjs'));
  return 'dsh-endpoint.mjs';
});

// 2) 依赖（运行期只需要 dependencies；node_modules 里没有原生模块）
step('node_modules', () => copyDir(path.join(ROOT, 'node_modules'), path.join(OUT, 'node_modules'), { skip: ['.bin', '.cache'] }));

// 2b) SnowLuma（QQ 网关）：默认整包带上，启动器负责拉起它。
//     --no-gateway 时不带：SnowLuma 有自己的非商业许可，公开分发时把网关留给使用者自己装更稳。
const withGateway = !argv.includes('--no-gateway');
const SNOWLUMA_OUT = path.join(OUT, 'snowluma');
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
if (withGateway) {
  step('snowluma', () => copyDir(path.join(ROOT, 'SnowLuma-v2.0.3-win-x64'), SNOWLUMA_OUT, { skip: ['logs'] }));
  if (fs.existsSync(SNOWLUMA_OUT)) {
    report.push(`snowluma: 已清理账号数据 ${pruneSnowLumaAccount()} 项（首次运行需扫码登录）`);
  }
} else {
  report.push('snowluma: 跳过（--no-gateway），使用者需按 README 自行下载网关');
}

// 3) 资源：角色卡 / 世界观 / 提示词 / 静态资源 / 音频
const personalRoles = keepState ? new Set() : personalRoleNames();
if (personalRoles.size) console.log(`   跳过个人角色卡（不进发布包）：${[...personalRoles].join('、')}`);
step('roles', () => copyDir(path.join(ROOT, 'roles'), path.join(OUT, 'roles'), {
  skip: ['.backup', '.refs', '.git'],
  filter: (name) => !personalRoles.has(name) && !/\.bak-|\.orig$|^\.DS_Store$/.test(name),
}));
step('resources', () => copyDir(path.join(ROOT, 'resources'), path.join(OUT, 'resources')));
step('dsh/agent-presets', () => copyDir(path.join(ROOT, 'dsh', 'agent-presets'), path.join(OUT, 'dsh', 'agent-presets'), { filter: (name) => !/[.]bak-|[.]orig$|^[.]DS_Store$/.test(name) }));
for (const name of ['world.json', 'assets', 'audio', 'public']) {
  const from = path.join(ROOT, name);
  if (!fs.existsSync(from)) continue;
  const dst = path.join(OUT, name);
  if (fs.statSync(from).isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    step(name, () => copyDir(from, dst, { skip: ["logs"], filter: name === "audio" ? () => false : name === "public" ? (n) => !/\.bak-/.test(n) : undefined }));
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
//    ⚠️ 目标目录里已经有 config.json 时**绝不覆盖**——那是使用者填好的真实配置
//       （模型 Key、接口地址、群号白名单、QQ 路径…），打包一次就冲掉等于毁数据。
//       做法：新模板打底，旧配置的值覆盖上去。这样新版本新增的字段会自动补进来，
//       而使用者填过的值一个不动；数组整体替换，不做拼接（否则群号会越并越多）。
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

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
// 以 base 为骨架，把 user 里有的值盖上去；对象递归，数组/标量整体替换。
function mergeKeepUser(base, user) {
  if (!isPlainObject(user)) return user;
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(user)) {
    out[key] = isPlainObject(value) ? mergeKeepUser(out[key], value) : value;
  }
  return out;
}

const cfgPath = path.join(OUT, 'config.json');
const existing = preservedConfig ?? (fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : null);
if (existing) {
  const merged = mergeKeepUser(standaloneCfg, existing);
  fs.writeFileSync(cfgPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  configPreserved = true;
  const added = Object.keys(standaloneCfg).filter((k) => !(k in existing));
  report.push(`config.json: 已存在，保留原配置（新增顶层字段：${added.length ? added.join('/') : '无'}）`);
} else {
  fs.writeFileSync(cfgPath, `${JSON.stringify(standaloneCfg, null, 2)}\n`, 'utf8');
  report.push('config.json: 模板（backend=standalone，llm.apiKey 留空）');
}

// 5b) 净化：作者本机的个性化行为规则不进发布内容（只改输出，不动源码）
step('净化个性化内容', () => sanitizeReleaseOutput());

// 5c) 放回自建角色卡（--keep-state，且只放源码里没有的那些）
if (preservedRoleFiles) {
  const destRoles = path.join(OUT, 'roles');
  fs.mkdirSync(destRoles, { recursive: true });
  for (const name of preservedRoleFiles.names) {
    fs.copyFileSync(path.join(preservedRoleFiles.dir, name), path.join(destRoles, name));
  }
  fs.rmSync(preservedRoleFiles.dir, { recursive: true, force: true });
  report.push(`roles/: 放回 ${preservedRoleFiles.names.length} 张自建卡（--keep-state）：${preservedRoleFiles.names.join('、')}`);
  preservedRoleFiles = null;
}

// 6) state 目录（默认空；--keep-state 时把本机原有的数据搬回来）
// 唯一例外是 mode.json：新装用户必须默认进二代仿真模式（reserved2），否则
// 桥接的兜底值是 chat —— chat 模式完全不做拟人节奏（不延迟、不分条、不抖动），
// 装完就像个"打字机器人"。这条默认值写在这里，用户之后可以随时在面板/DSH 设置里改。
const DEFAULT_MODE = { mode: 'reserved2', closedAgentPreset: '' };
function writeDefaultMode() {
  const file = path.join(OUT, 'state', 'mode.json');
  if (fs.existsSync(file)) return false;
  fs.writeFileSync(file, `${JSON.stringify(DEFAULT_MODE, null, 2)}\n`, 'utf8');
  report.push('state/mode.json: 写入默认 reserved2（拟人节奏）');
  return true;
}

if (preservedStateDir) {
  fs.rmSync(path.join(OUT, 'state'), { recursive: true, force: true });
  fs.cpSync(preservedStateDir, path.join(OUT, 'state'), { recursive: true });
  fs.rmSync(preservedStateDir, { recursive: true, force: true });
  const kept = fs.readdirSync(path.join(OUT, 'state')).filter((n) => !n.startsWith('webview2')).length;
  report.push(`state/: 保留原有数据（--keep-state，${kept} 项）`);
  writeDefaultMode();
} else {
  fs.mkdirSync(path.join(OUT, 'state'), { recursive: true });
  writeDefaultMode();
  report.push('state/: 空目录');
}

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
  'if not exist app\\hide.vbs (',
  '  echo [错误] 缺少 app\\hide.vbs，无法后台启动面板。',
  '  pause',
  '  exit /b 1',
  ')',
  'rem 用 wscript 隐藏启动面板：不留下黑窗口，面板日志在界面里看。',
  'wscript.exe //nologo "app\\hide.vbs"',
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
// 程序图标：app/icon.ico 存在就编进 exe（托盘、任务栏、Alt+Tab、资源管理器全都跟它走）
const launcherIcon = path.join(ROOT, 'app', 'icon.ico');
if (csc && fs.existsSync(launcherSrc)) {
  try {
    execFileSync(csc, [
      '-nologo', '-target:winexe', '-platform:x64', '-codepage:65001',
      `-out:${launcherExe}`,
      `-win32manifest:${path.join(ROOT, 'app', 'app.manifest')}`,
      ...(fs.existsSync(launcherIcon) ? [`-win32icon:${launcherIcon}`] : []),
      '-reference:System.Windows.Forms.dll',
      '-reference:System.Drawing.dll',
      '-reference:System.Web.Extensions.dll',
      `-reference:${path.join(ROOT, 'app', 'lib', 'Microsoft.Web.WebView2.Core.dll')}`,
      `-reference:${path.join(ROOT, 'app', 'lib', 'Microsoft.Web.WebView2.WinForms.dll')}`,
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
const gatewayBlock = withGateway ? [] : [
  '【先装网关（本包不含）】',
  '本包为了遵守 SnowLuma 的许可，没有把 QQ 网关打进来。它免费，两分钟就能装好：',
  '1. 装好桌面版 QQ（NTQQ），能正常打开登录。',
  '2. 打开 https://github.com/SnowLuma/SnowLuma ，进 Releases 下载 Windows x64 压缩包。',
  '3. 解压，把解出来的文件夹改名为 snowluma。',
  '4. 放到本目录，和 QQ聊天机器人.exe、node.exe 同一层。',
  '5. 网关首次启动后，面板会把它自己的端口自动改成 38000/38001（默认 3000/3001 被 Windows 占了），',
  '   不用你手动改；如果面板显示 38000/38001 不绿，重启一次网关即可。',
  '6. 再继续下面的「第一次使用」。',
  ''
];
fs.writeFileSync(path.join(OUT, 'README.txt'), [
  'QQ 聊天机器人 · 独立版',
  '================================',
  '',
  `版本：${pkg.version ?? 'unknown'}`,
  '不用装 Node、不用装 DSH、不用 npm install。双击「QQ聊天机器人.exe」就能用。',
  withGateway
    ? 'QQ 网关（SnowLuma）已经在本目录的 snowluma\\ 里。'
    : '注意：本包不含 QQ 网关，先按下面【先装网关】做一遍。',
  '',
  ...gatewayBlock,
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
  '  如果这个地址打不开：3199 被别的程序占用、或被 Windows 的动态端口排除范围划走了，',
  '  程序会自己换一个端口。实际地址在 state\\ports.json 的 panel 里，双击 exe 时窗口会自动跟过去。',
  '- start.bat 是备用入口：双击后同样在后台启动面板（不留黑窗口）。',
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