// 腾讯官方 QQ Bot 通道：把「装插件 / 填凭据 / 起进程 / 切角色」四件事从命令行搬进面板。
//
// 为什么是这一层：
//   官方插件 @tencent-connect/dsh-qqbot 是**纯 dsh 内核插件**（inject agents/llm/session），
//   它必须跑在一个 dsh 进程里，不能塞进本项目自己的 standalone agent loop。
//   所以这里的做法是「项目只当外壳」：用 dsh 的 profile 机制另起一个专用实例
//   （--profile qqbot），面板负责把它的配置、凭据、生命周期全管起来。
//
// 二选一：
//   OneBot（SnowLuma）走你自己的 QQ 号；官方通道走开放平台的机器人身份。
//   两者互斥，由 config.json 的 qqChannel 决定，见 setChannel()。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { selectRoleText } from './role-card.js';

export const CHANNEL_ONEBOT = 'onebot';
export const CHANNEL_OFFICIAL = 'official';

// 插件包名：npm dist-tag 用 latest，装到 profile 里就是最新版。
export const PLUGIN_PACKAGE = '@tencent-connect/dsh-qqbot';
// cordis.patch.yml 里的条目 id，凭据写在这个条目下面。
const PLUGIN_ENTRY_ID = 'im-qqbot';

const DSH_HOME = path.join(os.homedir(), '.dsh');
const PROFILES_DIR = path.join(DSH_HOME, 'profiles');
const PROFILE_NAME = 'qqbot';
const PROFILE_DIR = path.join(PROFILES_DIR, PROFILE_NAME);
const PATCH_FILE = path.join(PROFILE_DIR, 'cordis.patch.yml');

// dsh CLI 入口：优先用 QQ_BOT_DSH_CLI 覆盖（换机器/换安装位置时只改环境变量），
// 否则用桌面版自带的那个。不要改 PATH，改了会污染用户环境。
function dshCli() {
  const fromEnv = String(process.env.QQ_BOT_DSH_CLI || '').trim();
  if (fromEnv) return fromEnv;
  return path.join('F:', 'Deepseek', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
}

// ── 进程管理 ────────────────────────────────────────────────────────────────
// 只认自己 spawn 的句柄。面板重启后句柄就没了，所以额外把 pid 落到文件，
// 下次打开面板还能把「其实还在跑」的那份认回来。
const child = { proc: null };
let lastError = '';
const output = []; // 最近输出（内存环形），面板日志框直接读它
const OUTPUT_MAX = 400;

export function isRunning() {
  if (child.proc && child.proc.exitCode === null && !child.proc.killed) return true;
  const pid = readPid();
  if (!pid) return false;
  return pidAlive(pid);
}

export function pid() {
  if (child.proc && child.proc.exitCode === null) return child.proc.pid;
  return readPid();
}

function readPid() {
  try {
    const n = Number(fs.readFileSync(path.join(PROFILES_DIR, `.${PROFILE_NAME}.pid`), 'utf8').trim());
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  } catch { return null; }
}

function writePid(value) {
  const file = path.join(PROFILES_DIR, `.${PROFILE_NAME}.pid`);
  try {
    fs.mkdirSync(PROFILES_DIR, { recursive: true });
    if (value) fs.writeFileSync(file, String(value), 'utf8');
    else fs.unlinkSync(file);
  } catch { /* pid 文件只是辅助信息，写不了不影响运行 */ }
}

function pidAlive(pid) {
  try {
    // 0 号信号只探测存活，不真的发信号；Windows 上 Node 也支持。
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

export function pushOutput(line) {
  const text = String(line ?? '').replace(/\r/g, '');
  if (!text) return;
  output.push(text);
  while (output.length > OUTPUT_MAX) output.shift();
}

export function recentOutput(count = 200) {
  return output.slice(-Math.max(1, Math.min(OUTPUT_MAX, count)));
}

// ── 安装状态 ────────────────────────────────────────────────────────────────
export function installState() {
  const installed = fs.existsSync(path.join(PROFILE_DIR, 'node_modules', ...PLUGIN_PACKAGE.split('/')));
  let version = '';
  if (installed) {
    try {
      version = String(JSON.parse(fs.readFileSync(
        path.join(PROFILE_DIR, 'node_modules', ...PLUGIN_PACKAGE.split('/'), 'package.json'), 'utf8'
      )).version ?? '');
    } catch { /* 版本读不到不影响判断"装没装" */ }
  }
  return { installed, version, profileDir: PROFILE_DIR, patchFile: PATCH_FILE };
}

// ── 凭据读写（直接改 cordis.patch.yml，不碰环境变量）──────────────────────
// 为什么不用环境变量：面板 spawn 子进程时能带 env，但用户关机重启后自己点开
// dsh 就不带了，凭据会静默失效。写进 profile 的补丁文件才是持久的。
function readPatch() {
  try { return fs.readFileSync(PATCH_FILE, 'utf8'); } catch { return ''; }
}

export function readCredentials() {
  const text = readPatch();
  return parseCredentials(text);
}

// 抽出来单独一份：写入测试要拿同一套规则读回，不能测一套用另一套。
function parseCredentials(text) {
  const pick = (key) => {
    // 只在 im-qqbot 条目下面找，避免误抓别处的同名键。
    const re = new RegExp(`^\\s*${key}:\\s*['"]?([^'"\\n#]*)['"]?\\s*$`, 'm');
    const m = text.match(re);
    return m ? m[1].trim() : '';
  };
  return { appId: pick('appId'), appSecret: pick('appSecret'), hasSecret: !!pick('appSecret') };
}

// 把 key/value 写进一段 YAML 文本，返回新文本。
// 单独导出是为了能不落盘地验证改写逻辑（见 work/test-official.mjs）。
export function applyPatchKey(text, appId, appSecret) {
  return buildPatch(text, appId, appSecret);
}

// 把一个 key 写进 im-qqbot 条目：有就替换同一缩进下的那一行，没有就插在条目名后面。
// 不用 yaml 库：只改两行标量，正则改比 parse→dump 更安全（dump 会重排整份文件、
// 丢注释，用户手写的其它配置会被"顺手整理"掉）。
function setPatchKey(text, key, value) {
  const lines = text.split(/\r?\n/);
  const entryIdx = lines.findIndex((l) => new RegExp(`^\\s*-?\\s*id:\\s*['"]?${PLUGIN_ENTRY_ID}['"]?\\s*$`).test(l));
  const quoted = `'${String(value).replace(/'/g, "''")}'`;

  if (entryIdx === -1) {
    // 还没有这个条目：追加一个最小条目，只放凭据。
    const block = [
      '',
      'plugins:',
      `  - id: ${PLUGIN_ENTRY_ID}`,
      `    name: '${PLUGIN_PACKAGE}'`,
      '    config:',
      `      appId: ${quoted}`
    ];
    return `${text.replace(/\s*$/, '')}\n${block.join('\n')}\n`;
  }

  // 条目存在：找 config 段，再在段里找 key。
  let configIdx = -1;
  for (let i = entryIdx + 1; i < lines.length; i += 1) {
    if (/^\s*-\s*id:/.test(lines[i])) break; // 下一个条目了
    if (/^\s*config:\s*$/.test(lines[i])) { configIdx = i; break; }
  }

  if (configIdx === -1) {
    // 条目在但没有 config：插在条目下。
    lines.splice(entryIdx + 1, 0, '    config:', `      ${key}: ${quoted}`);
    return lines.join('\n');
  }

  const configIndent = (lines[configIdx].match(/^\s*/) || [''])[0].length;
  let insertAt = configIdx + 1;
  for (let i = configIdx + 1; i < lines.length; i += 1) {
    const indent = (lines[i].match(/^\s*/) || [''])[0].length;
    if (lines[i].trim() && indent <= configIndent) break; // config 段结束
    if (new RegExp(`^\\s{${configIndent + 2}}${key}:`).test(lines[i])) {
      lines[i] = `${' '.repeat(configIndent + 2)}${key}: ${quoted}`;
      return lines.join('\n');
    }
    insertAt = i + 1;
  }
  lines.splice(insertAt, 0, `${' '.repeat(configIndent + 2)}${key}: ${quoted}`);
  return lines.join('\n');
}

export function saveCredentials({ appId, appSecret }) {
  const id = String(appId ?? '').trim();
  const secret = String(appSecret ?? '').trim();
  // 开放平台的 AppID 是纯数字；手抄错一位在启动时只会报「鉴权失败」，很难倒查，这里先拦。
  if (!id) throw new Error('AppID 不能为空');
  if (!/^\d{5,20}$/.test(id)) throw new Error('AppID 应该是纯数字（在 QQ 开放平台「开发设置」里）');
  if (secret && !/^[A-Za-z0-9_-]{10,64}$/.test(secret)) throw new Error('AppSecret 格式不对（应为字母数字，长度 10~64）');

  const next = buildPatch(readPatch(), id, secret);
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.writeFileSync(PATCH_FILE, next, 'utf8');
  return readCredentials();
}

// 纯函数版：给定旧文本 + 凭据，返回写好的新文本（不碰磁盘）。
// 密钥留空 = 只改 AppID 不动旧密钥（用户可能只改错别字）。
function buildPatch(text, appId, appSecret) {
  let out = String(text ?? '');
  if (!out.trim()) {
    out = '# 由面板「官方通道」页写入。这个文件只放真正需要覆盖的配置。\n';
  }
  out = setPatchKey(out, 'appId', appId);
  if (appSecret) out = setPatchKey(out, 'appSecret', appSecret);
  return out;
}

// ── profile 初始化 ────────────────────────────────────────────────────────
// 新机器上 ~/.dsh/profiles/qqbot 根本不存在。这里建一个最小 profile：
// package.json 声明要装的插件，cordis.patch.yml 放凭据。dsh 自己会补其余默认文件。
export function ensureProfile() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const pkgFile = path.join(PROFILE_DIR, 'package.json');
  if (!fs.existsSync(pkgFile)) {
    const pkg = {
      name: `dsh-profile-${PROFILE_NAME}`,
      private: true,
      dependencies: {}
    };
    fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  }
  if (!fs.existsSync(PATCH_FILE)) {
    fs.writeFileSync(PATCH_FILE, '# 由面板「官方通道」页写入。这个文件只放真正需要覆盖的配置。\n', 'utf8');
  }
  return { profileDir: PROFILE_DIR, patchFile: PATCH_FILE };
}

// ── 跑 dsh（装插件 / 启动）────────────────────────────────────────────────
// 统一走 cmd.exe：dsh.cmd 是批处理，Node 在 Windows 上不能直接 spawn .cmd
// （Node 18+ 起对 .cmd 有 CVE-2024-27980 的防护，直接 spawn 会报 EINVAL）。
function runDsh(args, { onLine, timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    const cli = dshCli();
    if (!fs.existsSync(cli)) {
      resolve({ ok: false, code: 'cli-missing', error: `找不到 dsh：${cli}` });
      return;
    }
    const proc = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${cli}" ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`], {
      cwd: PROFILE_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }
    });

    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => { try { proc.kill(); } catch { /* 已经退了 */ } }, timeoutMs);
    }

    const handle = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        pushOutput(line);
        if (onLine) onLine(line);
      }
    };
    proc.stdout?.on('data', handle);
    proc.stderr?.on('data', handle);
    proc.on('error', (error) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: false, code: 'spawn-failed', error: error?.message ?? String(error) });
    });
    proc.on('exit', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: code === 0, code, error: code === 0 ? '' : `dsh 退出码 ${code}` });
    });
  });
}

// 装插件：dsh plugin --profile <name> add <包名>，参数原样转给 profile 目录下的 pnpm。
export async function installPlugin() {
  ensureProfile();
  pushOutput(`$ dsh plugin --profile ${PROFILE_NAME} add ${PLUGIN_PACKAGE}`);
  const result = await runDsh(['plugin', '--profile', PROFILE_NAME, 'add', PLUGIN_PACKAGE], {
    onLine: (line) => { /* 已经 push 过 */ },
    timeoutMs: 5 * 60 * 1000
  });
  return { ...result, ...installState() };
}

// ── 启动 / 停止 ───────────────────────────────────────────────────────────
// 端口要固定：不固定的话 dsh web 会自己挑一个，面板就找不到它了。
const OFFICIAL_PORT = 3180;

// ── 角色卡注入 ───────────────────────────────────────────────────────────
// 官方插件是封闭的纯 dsh 插件，没有"换角色"的钩子；但它有两件正好能用的事：
//   1. 注册了 `system-prompt/assemble` waterfall，每次 turn 都把 config.groupPrompt /
//      config.directPrompt 追加成一段 system prompt（见插件 dist/session/session-manager.js）；
//   2. 自带 HTTP 配置接口 POST /qqbot/im-qqbot/config，白名单里正好有这两个键，
//      保存后插件自动重载 —— 也就是下一条消息就生效，不用重启、不用写插件。
// 所以这里不做命令解析、不给群友入口：面板主人切一次，就把角色卡正文推给插件。
const CONFIG_API_PATH = '/qqbot/im-qqbot/config';
// 插件侧 stringSchema 上限是 20000，留一点余量给开头的说明。
const ROLE_PROMPT_MAX = 19800;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROLE_STATE_FILE = path.join(ROOT, 'state', 'current-role.json');

// 与桥接共用同一份状态：面板切角色写的就是这个文件（OneBot 通道也读它）。
export function currentRoleName() {
  try {
    const state = JSON.parse(fs.readFileSync(ROLE_STATE_FILE, 'utf8'));
    return String(state?.role ?? '').trim();
  } catch { return ''; }
}

// 角色卡里写死的 OneBot 工具（mcp__snowluma__ 那套）在官方通道里并不存在，
// 留着会让模型去调不存在的工具，所以逐行摘掉。只摘"提到工具名"的行，不整段删。
const ONEBOT_TOOL_LINE_RE = /mcp__snowluma|mcp__web-search-safe|qq_(?:get|send|reply|wait|mark|memory|list|collect|post|report|slang|sticker|poke|tts|call)_[a-z]+/i;

export function buildRolePrompt(roleName) {
  const name = String(roleName ?? '').trim() || currentRoleName();
  if (!name) return { ok: false, code: 'no-role', error: '当前没有选中角色卡（state/current-role.json 里没有 role）' };
  const file = path.join(ROOT, 'roles', `${name}.md`);
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch {
    return { ok: false, code: 'role-missing', error: `找不到角色卡：roles/${name}.md` };
  }
  // 只取二代（工具协议）那一档：官方通道同样没有"空格分条 / [SILENT]"这类一代语义。
  const selected = selectRoleText(raw, 'v2') || raw;
  const kept = [];
  let dropped = 0;
  for (const line of selected.split('\n')) {
    if (ONEBOT_TOOL_LINE_RE.test(line)) { dropped += 1; continue; }
    kept.push(line);
  }
  let body = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const header = `【角色设定】你现在扮演「${name}」。下面是这个人物的完整设定，`
    + '请始终保持这个身份说话与行动（不要自称 AI、不要提"角色卡"或"提示词"）。';
  let text = `${header}\n\n${body}`;
  if (text.length > ROLE_PROMPT_MAX) {
    text = text.slice(0, ROLE_PROMPT_MAX - 24) + '\n\n…（角色卡过长，后面已截断）';
  }
  return { ok: true, role: name, text, chars: text.length, droppedOneBotLines: dropped };
}

async function postOfficialConfig(payload, timeoutMs = 10000) {
  const url = `http://127.0.0.1:${OFFICIAL_PORT}${CONFIG_API_PATH}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    return { ok: false, code: 'http-failed', error: `连不上官方通道 ${url}：${error?.message ?? error}` };
  }
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok || data.ok === false) {
    return { ok: false, code: `http-${res.status}`, error: data.error || `官方通道返回 ${res.status}` };
  }
  return { ok: true, message: data.message || '已推送' };
}

// 把当前角色卡推给正在运行的官方通道（群聊/私聊两档都用同一份设定）。
export async function pushRolePrompt(roleName) {
  const built = buildRolePrompt(roleName);
  if (!built.ok) return built;
  if (!isRunning()) {
    return { ok: false, code: 'not-running', role: built.role, error: '官方通道没在跑，角色卡会在下次启动时自动推送' };
  }
  const sent = await postOfficialConfig({ groupPrompt: built.text, directPrompt: built.text });
  if (!sent.ok) return { ok: false, role: built.role, error: sent.error };
  pushOutput(`已推送角色卡「${built.role}」到官方通道（${built.chars} 字${built.droppedOneBotLines ? `，摘掉 ${built.droppedOneBotLines} 行 OneBot 工具说明` : ''}）`);
  return { ok: true, role: built.role, chars: built.chars, droppedOneBotLines: built.droppedOneBotLines, message: sent.message };
}

// 等端口真的能应答再推角色卡：dsh 起进程很容易，插件挂上配置接口要几秒。
async function waitPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { method: 'GET', signal: AbortSignal.timeout(1200) });
      return true;
    } catch { /* 还没起来 */ }
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  return false;
}

export async function start() {
  if (isRunning()) return { ok: true, already: true, pid: pid() };

  const st = installState();
  if (!st.installed) return { ok: false, code: 'not-installed', error: '插件还没装，先点「安装插件」' };
  const cred = readCredentials();
  if (!cred.appId || !cred.appSecret) return { ok: false, code: 'no-credentials', error: 'AppID 或 AppSecret 还没填' };

  ensureProfile();
  const cli = dshCli();
  if (!fs.existsSync(cli)) return { ok: false, code: 'cli-missing', error: `找不到 dsh：${cli}` };

  pushOutput(`$ dsh --profile ${PROFILE_NAME} --web --port ${OFFICIAL_PORT}`);
  const proc = spawn(process.env.ComSpec || 'cmd.exe', [
    '/d', '/s', '/c',
    `"${cli}" --profile ${PROFILE_NAME} --web --port ${OFFICIAL_PORT}`
  ], {
    cwd: PROFILE_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }
  });
  child.proc = proc;
  lastError = '';
  writePid(proc.pid);

  const handle = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) pushOutput(line);
  };
  proc.stdout?.on('data', handle);
  proc.stderr?.on('data', handle);
  proc.on('error', (error) => {
    lastError = error?.message ?? String(error);
    pushOutput(`启动失败：${lastError}`);
  });
  proc.on('exit', (code) => {
    pushOutput(`官方通道进程退出（code=${code}）`);
    if (child.proc === proc) child.proc = null;
    writePid(0);
  });

  // 起进程之后自动把当前角色卡推给插件：这样"先起通道、再改角色"的顺序也能用，
  // 而"先改角色、后起通道"则由面板在下一次启动时补上。
  void (async () => {
    const up = await waitPort(OFFICIAL_PORT, 90000);
    if (!up) {
      pushOutput('官方通道：90 秒内没等到 3180 应答，角色卡未推送（起来后可点「推送角色卡」）');
      return;
    }
    const pushed = await pushRolePrompt();
    if (!pushed.ok) pushOutput(`官方通道：角色卡未推送 —— ${pushed.error}`);
  })();

  return { ok: true, pid: proc.pid, port: OFFICIAL_PORT };
}

export async function stop() {
  const target = pid();
  if (!target) return { ok: true, already: true };
  try {
    // taskkill /T 连子进程一起收（cmd.exe → node 两层）。
    spawn('taskkill', ['/PID', String(target), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } catch { /* 杀不掉就等它自己退 */ }
  if (child.proc) { try { child.proc.kill(); } catch { /* 已经退了 */ } child.proc = null; }
  writePid(0);
  pushOutput(`已请求停止（pid ${target}）`);
  return { ok: true, stopped: target };
}

export async function restart() {
  await stop();
  // 给 taskkill 一点时间落下去，立刻 spawn 会撞同一个端口。
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return start();
}

// ── 二选一开关 ───────────────────────────────────────────────────────────
// 只写 config.json，不碰任何进程：真正的启停由面板在保存后统一做，
// 这样用户改了又改回来不会反复重启。
export function setChannel(configPath, channel) {
  const want = channel === CHANNEL_OFFICIAL ? CHANNEL_OFFICIAL : CHANNEL_ONEBOT;
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { cfg = {}; }
  cfg.qqChannel = want;
  fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  return want;
}

export function readChannel(configPath) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return cfg.qqChannel === CHANNEL_OFFICIAL ? CHANNEL_OFFICIAL : CHANNEL_ONEBOT;
  } catch {
    return CHANNEL_ONEBOT;
  }
}

export function status(configPath) {
  const st = installState();
  const cred = readCredentials();
  return {
    ok: true,
    channel: readChannel(configPath),
    running: isRunning(),
    pid: pid(),
    port: OFFICIAL_PORT,
    installed: st.installed,
    version: st.version,
    profileDir: st.profileDir,
    patchFile: st.patchFile,
    cliPath: dshCli(),
    cliExists: fs.existsSync(dshCli()),
    appId: cred.appId,
    hasSecret: cred.hasSecret,
    lastError,
    output: recentOutput(120)
  };
}