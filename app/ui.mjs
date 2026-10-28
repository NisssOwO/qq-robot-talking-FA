// 桌面控制面板：一个窗口里管完 QQ 网关、模型配置、机器人启停和日志。
//
// 它不是 Electron：窗口由 Edge 的 --app 模式打开（无地址栏、独立任务栏图标），
// 服务本身是这里的 node:http。这样不需要额外 180MB 的运行时。
//
// 用法：
//   node app/ui.mjs               # 自动开窗口
//   node app/ui.mjs --no-open     # 只起服务
//
// 环境变量：
//   QQ_BOT_CONFIG   配置文件路径
//   QQ_BOT_UI_PORT  面板端口（默认 3199）
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(APP_DIR, '..');
const CONFIG_PATH = process.env.QQ_BOT_CONFIG || path.join(ROOT, 'config.json');
const STATE_DIR = path.join(ROOT, 'state');
const BRIDGE_LOG = path.join(STATE_DIR, 'bridge.log');
const UI_LOG = path.join(STATE_DIR, 'ui.log');
const SNOWLUMA_LOG = path.join(STATE_DIR, 'snowluma.log');
const SNOWLUMA_DIR = path.join(ROOT, 'snowluma');
const PIDS_FILE = path.join(STATE_DIR, 'ui-pids.json');
const ROLES_DIR = path.join(ROOT, 'roles');
const HTML_PATH = path.join(APP_DIR, 'ui.html');
// 桥接控制台（完整功能页）由面板同源提供，这样它能和外面的导航拼成同一个界面，
// 而不是跨源 iframe 塞进来（跨源既不能改样式，也会出现两套导航）。
const CONSOLE_PATH = path.join(ROOT, 'public', 'console.html');

const WEBUI_PORT = 5099;
const ONEBOT_HTTP_PORT = 38000;
const ONEBOT_WS_PORT = 38001;
// 被 QQ聊天机器人.exe（WebView2 宿主）拉起来时，窗口由宿主自己提供，
// 这里绝对不能再开一个 Edge --app 窗口，否则用户会看到两个长得一样的窗口。
const HOSTED_BY_LAUNCHER = process.env.QQBOT_HOST === 'webview' || process.env.QQ_BOT_NO_BROWSER === '1';
// 只有在明确要求时才用浏览器开窗：默认不开。
// 原因：面板已经由 QQ聊天机器人.exe（WebView2）提供窗口；再让浏览器开一个
// --app 窗口，用户就会看到两个一模一样的界面，而且 Edge 单实例会把 --app
// 转交给已运行的浏览器主进程，关都关不干净（残留窗口会一直挂在屏幕上）。
// 想用浏览器看：面板里点「在浏览器打开」，或手动 `node app\ui.mjs --open`。
const OPEN_WINDOW = process.argv.includes('--open') && !HOSTED_BY_LAUNCHER;

const DEFAULTS = {
  llm: {
    protocol: 'openai-completions',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKey: '',
    maxTokens: 8000,
    temperature: 0.7,
    timeoutMs: 180000
  },
  snowluma: { wsUrl: 'ws://127.0.0.1:38001', httpUrl: 'http://127.0.0.1:38000', accessToken: '' },
  tts: { enabled: true, baseUrl: 'https://api.fish.audio', apiKey: '', model: 's2.1-pro-free' },
  webSearch: { apiKey: '', apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: '' },
  // 白名单分启用/停用两摞：bridge 只读 groups/private（启用集合），
  // 停用的号挪到 disabled 里，网关侧判断逻辑一行都不用改。
  allow: { groups: [], private: [], disabled: { groups: [], private: [] }, names: {} },
  // QQ 本体：网关要注入到一个正在运行的 QQ 上，所以这里记住它装在哪、要不要顺手拉起来。
  qq: { path: '', uin: '', autoLaunch: true },
  // 协议端：只支持 SnowLuma（内置 NapCat 那条路已回滚，代码留着但不启用）。
  gateway: 'snowluma',
  backend: 'standalone',
  consolePort: 3100
};

const children = {};
// 最近一次「网关起来了但 OneBot 没开」的提示，status() 会带出去给前端显示
let gatewayHint = '';
const logs = { bot: [], snowluma: [] };

function log(line) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const text = `${ts} ${line}`;
  console.log(text);
  // 双击 exe 启动时没有控制台，日志只能落盘；超过 2MB 就从头覆盖，避免无限长。
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const file = path.join(STATE_DIR, 'ui.log');
    try {
      if (fs.statSync(file).size > 2 * 1024 * 1024) fs.writeFileSync(file, '', 'utf8');
    } catch { /* 文件还不存在 */ }
    fs.appendFileSync(file, text + '\n', 'utf8');
  } catch { /* 写不了也不影响运行 */ }
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeConfig(cfg) {
  const before = String(readConfig()?.snowluma?.accessToken || '').trim();
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  // OneBot token 是网关进程**启动时读一次**就存进内存的。改配置却不重启网关的话，
  // 桥接下一次断线重连会一直撞 "rejected unauthorized"，表现成「机器人在线但发不出文字」。
  // 所以 token 一变就顺手对齐并重启网关，让两边立刻一致。
  const after = String(cfg?.snowluma?.accessToken || '').trim();
  if (after && after !== before) {
    const fixed = normalizeGatewayPorts();
    if (fixed.tokenFixed.length && children.snowluma) {
      log('网关 token 变了，正在重启网关让它读到新值…');
      void (async () => {
        try {
          await stopGateway();
          await new Promise((resolve) => setTimeout(resolve, 900));
          await startGateway();
          log('网关已用新 token 重启');
        } catch (error) {
          log(`网关重启失败（新 token 要等下次手动启动才生效）：${error?.message ?? error}`);
        }
      })();
    }
  }
}

function probePort(port, timeoutMs = 700) {
  return new Promise((resolve) => {
    let settled = false;
    const sock = net.connect({ port, host: '127.0.0.1' });
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {}
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

// 轮询等端口起来（网关进程起了不等于服务已经可用）
async function waitPort(port, totalMs = 20000, stepMs = 1000) {
  const deadline = Date.now() + totalMs;
  do {
    if (await probePort(port, 500)) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  } while (Date.now() < deadline);
  return false;
}

// ── QQ 本体 ─────────────────────────────────────────────
// 网关的做法是 hook 注入到正在运行的 QQ 进程里，所以 QQ 得先开着（否则注入器只能干等）。
// QQ 自己是多进程的，一台机器上出现好几个 QQ.exe 属正常，所以只看「有没有」，不看数量。
let qqCache = { at: 0, list: [] };

function listQQProcessesFresh() {
  return new Promise((resolve) => {
    const script = `Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" | ForEach-Object { $_.ProcessId.ToString() + '|' + $_.ExecutablePath }`;
    execFile('powershell', ['-NoProfile', '-Command', script], { windowsHide: true }, (error, stdout) => {
      if (error) return resolve([]);
      resolve(String(stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
        const [pid, exe] = line.split('|');
        return { pid: Number(pid) || 0, path: String(exe ?? '').trim() };
      }));
    });
  });
}

// 面板状态每 5 秒刷一次，每次都起一个 powershell 太浪费；2 秒内的结果直接复用。
async function listQQProcesses() {
  if (Date.now() - qqCache.at < 2000) return qqCache.list;
  const list = await listQQProcessesFresh();
  qqCache = { at: Date.now(), list };
  return list;
}

// 注册表里 QQ 的 DisplayIcon 形如 `D:\QQ\QQ.exe,0`，去掉末尾的图标序号才是路径。
function cleanDisplayIcon(raw) {
  return String(raw ?? '').trim().replace(/^"|"$/g, '').replace(/,\s*-?\d+$/, '').trim();
}

// 注册表有时候给的是卸载器（Uninstall.exe）或图标文件，不是主程序。
// 一律落回「同一目录下的 QQ.exe」；实在没有才退回原值，交给上层再判存在性。
function normalizeQQExe(raw) {
  const exe = cleanDisplayIcon(raw);
  if (!exe) return '';
  if (/[\\/]qq\.exe$/i.test(exe) && fs.existsSync(exe)) return exe;
  const sibling = path.join(path.dirname(exe), 'QQ.exe');
  if (fs.existsSync(sibling)) return sibling;
  return exe;
}

function readQQFromRegistry() {
  return new Promise((resolve) => {
    const script = `foreach ($k in @('HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ','HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ')) { if (Test-Path $k) { $p = Get-ItemProperty $k -ErrorAction SilentlyContinue; if ($p.DisplayIcon) { $p.DisplayIcon; break }; if ($p.UninstallString) { $p.UninstallString; break } } }`;
    execFile('powershell', ['-NoProfile', '-Command', script], { windowsHide: true }, (error, stdout) => {
      if (error) return resolve('');
      resolve(normalizeQQExe(String(stdout ?? '').split(/\r?\n/)[0]));
    });
  });
}

// 探测顺序：正在跑的 QQ → 配置里存的 → 注册表。用户自定义安装（比如 D:\QQ）只能靠前两者。
async function detectQQPath(cfg, procs) {
  const list = procs ?? (await listQQProcesses());
  // 只认真正的主程序：QQ 还会起 QQProtect 之类的进程，路径判错就会去注入错的目标。
  const running = list.find((p) => p.path && /[\\/]QQ\.exe$/i.test(p.path) && fs.existsSync(p.path));
  if (running) return running.path;
  const configured = String(cfg?.qq?.path ?? '').trim();
  if (configured && fs.existsSync(configured)) return configured;
  const fromReg = await readQQFromRegistry();
  if (fromReg && fs.existsSync(fromReg)) return fromReg;
  return '';
}

async function startQQ() {
  const cfg = readConfig();
  const before = await listQQProcesses();
  if (before.length) return { ok: true, already: true, count: before.length };
  const exe = await detectQQPath(cfg, before);
  if (!exe) {
    return {
      ok: false,
      code: 'qq-missing',
      error: '没有找到 QQ.exe：请在「QQ 启动」里填好 QQ 的路径'
    };
  }
  if (!fs.existsSync(exe)) {
    return { ok: false, code: 'qq-path-invalid', error: `找不到 QQ.exe：${exe}` };
  }
  try {
    const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
  } catch (error) {
    return { ok: false, code: 'qq-spawn-failed', error: `启动 QQ 失败：${error?.message ?? error}` };
  }
  log(`QQ 已拉起：${exe}`);
  // 等进程真正出现再往下走：网关要先看到 QQ 才能注入，抢跑只会白等。
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    const now = await listQQProcessesFresh();
    if (now.length) {
      qqCache = { at: Date.now(), list: now };
      return { ok: true, started: true, path: exe, count: now.length };
    }
  }
  return { ok: false, code: 'qq-timeout', error: 'QQ 启动了，但 30 秒内没等到进程' };
}

// 让用户直接挑文件，省得手打 D:\QQ\QQ.exe 这种路径。
// WinForms 的对话框必须在 STA 线程里开，所以带 -STA。
function pickQQPath() {
  return new Promise((resolve) => {
    const script = `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; $d.Title = '选择 QQ.exe'; $d.Filter = 'QQ.exe|QQ.exe|可执行文件 (*.exe)|*.exe'; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileName }`;
    execFile('powershell', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true }, (error, stdout) => {
      if (error) return resolve({ ok: false, error: `打开文件选择框失败：${error.message}` });
      const picked = String(stdout ?? '').trim();
      resolve(picked ? { ok: true, path: picked } : { ok: true, canceled: true });
    });
  });
}

// 「运行总览」要的今日计数：主动搭话用了几次、上限多少。数据在桥接的 state/social-v2.json。
function readSocialToday(cfg) {
  let proactive = 0;
  let spoken = 0;
  let conversations = 0;
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const dayOf = (ms) => new Date(Number(ms) + 8 * 3600 * 1000).toISOString().slice(0, 10);
  try {
    const st = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'social-v2.json'), 'utf8'));
    const list = st && st.conversations ? Object.values(st.conversations) : [];
    for (const it of list) {
      if (it && it.proactiveDay && String(it.proactiveDay) === today) {
        proactive += Number(it.proactiveCountToday ?? 0) || 0;
      }
      // 「今天说了多少次话」直接数它自己发的消息。
      // 之前用 token 账本的 turns，那个只在模型真的跑过回合时 +1、重启就清零，
      // 所以页面上常年是 0——口径错了，不是数据没到。
      const msgs = Array.isArray(it?.recentMessages) ? it.recentMessages : [];
      let touched = false;
      for (const m of msgs) {
        const t = Number(m?.time ?? 0);
        if (!t || dayOf(t) !== today) continue;
        touched = true;
        if (m.isSelf) spoken += 1;
      }
      if (touched) conversations += 1;
    }
  } catch { /* 没有状态文件就是 0 */ }
  return {
    proactive,
    proactiveMax: Number(cfg?.socialV2?.proactive?.maxPerDay ?? 0) || 0,
    spoken,
    conversations
  };
}


// ── NapCat（QQ 协议端）──────────────────────────────────────────
// NapCat 是注入 QQ 客户端的 hook，靠 QQ 本身登录，所以 QQ 必须装、必须开。
// 许可允许随本程序分发 NapCat，但 QQ 是腾讯的商业软件，不能带 —— 缺 QQ 时给官网链接。
const NAPCAT_DIR = path.join(ROOT, 'napcat');
const NAPCAT_WEBCONFIG = path.join(NAPCAT_DIR, 'config', 'webui.json');
const NAPCAT_QRCODE = path.join(NAPCAT_DIR, 'cache', 'qrcode.png');
const NAPCAT_WEBUI_PORT = 6099;
const QQ_DOWNLOAD_URL = 'https://im.qq.com/pcqq';
const NAPCAT_BOOT = path.join(NAPCAT_DIR, 'NapCatWinBootMain.exe');
const NAPCAT_HOOK = path.join(NAPCAT_DIR, 'NapCatWinBootHook.dll');

let qqPathCache = { at: 0, path: '' };

// 找 QQ 装在哪：先看配置，再看注册表（QQ 安装器会写 UninstallString）。
async function findQQPath() {
  if (Date.now() - qqPathCache.at < 60000) return qqPathCache.path;
  // 顺序交给 detectQQPath：正在跑的 QQ → 配置 → 注册表。
  // 这里以前自己再查一次 UninstallString，拿到的是 Uninstall.exe，注入器直接跑错。
  const found = await detectQQPath(readConfig());
  qqPathCache = { at: Date.now(), path: found };
  return found;
}

function napcatInstalled() {
  return fs.existsSync(NAPCAT_BOOT) && fs.existsSync(NAPCAT_HOOK);
}

// 二维码：NapCat 无头运行，码打在控制台里同时落盘。读出 base64 给面板显示。
function readQrcode() {
  try {
    const st = fs.statSync(NAPCAT_QRCODE);
    if (Date.now() - st.mtimeMs > 180000) return null; // 3 分钟前的码不给了
    return { base64: fs.readFileSync(NAPCAT_QRCODE).toString('base64'), at: st.mtimeMs };
  } catch {
    return null;
  }
}

// 读 WebUI 的 token，用它换算登录凭证（sha256(token + ".napcat")）。
function napcatToken() {
  try {
    const j = JSON.parse(fs.readFileSync(NAPCAT_WEBCONFIG, 'utf8'));
    return String(j.token ?? '').trim();
  } catch {
    return '';
  }
}

async function napcatLoginStatus() {
  const token = napcatToken();
  const webui = await probePort(NAPCAT_WEBUI_PORT);
  if (!token || !webui) return { webui, isLogin: false, loginPhase: '', loginError: '' };
  const key = crypto.createHash('sha256').update(token + '.napcat').digest('hex');
  const call = (p, body) =>
    fetch('http://127.0.0.1:' + NAPCAT_WEBUI_PORT + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(body.__cred ? { authorization: 'Bearer ' + body.__cred } : {}) },
      body: JSON.stringify(body.data ?? {}),
      signal: AbortSignal.timeout(6000)
    }).then((r) => r.json());
  try {
    const login = await call('/api/auth/login', { data: { hash: key } });
    const cred = login?.data?.Credential;
    if (!cred) return { webui, isLogin: false, loginPhase: '', loginError: '登录 WebUI 失败' };
    const st = await call('/api/QQLogin/CheckLoginStatus', { __cred: cred, data: {} });
    const d = st?.data ?? {};
    return { webui, isLogin: !!d.isLogin, loginPhase: String(d.loginPhase ?? ''), loginError: String(d.loginError ?? '') };
  } catch (error) {
    return { webui, isLogin: false, loginPhase: '', loginError: String(error?.message ?? error) };
  }
}

async function gatewayInfo() {
  const cfg = readConfig();
  const gateway = cfg?.gateway === 'snowluma' ? 'snowluma' : 'napcat';
  const qqPath = await findQQPath();
  const [onebotWs, onebotHttp] = await Promise.all([probePort(ONEBOT_WS_PORT), probePort(ONEBOT_HTTP_PORT)]);
  const login = gateway === 'napcat' ? await napcatLoginStatus() : { webui: false, isLogin: false, loginPhase: '', loginError: '' };
  // NapCat 的登录态要过 WebUI 认证才查得到，token 一变就查不出来；
  // 但 OneBot 服务只有在 QQ 登录成功后才会起来，所以 ws 通就等于登录成功——
  // 否则界面会一直显示「正在出二维码」，而实际上 QQ 早在线上。
  const loggedIn = login.isLogin || onebotWs;
  return {
    ok: true,
    gateway,
    qq: { installed: !!qqPath, path: qqPath, downloadUrl: QQ_DOWNLOAD_URL },
    napcat: {
      installed: napcatInstalled(),
      running: onebotWs || login.webui,
      webui: login.webui,
      isLogin: loggedIn,
      loginPhase: login.loginPhase,
      loginError: login.loginError,
      qrcode: loggedIn ? null : readQrcode()
    },
    onebot: { http: onebotHttp, ws: onebotWs }
  };
}

// ── 版本与兼容性 ────────────────────────────────────────
// NapCat 不是通用协议端：它是按某个 QQ 版本做的 hook（napcat\qqnt.json 里的 version）。
// QQ 客户端一升级，hook 就可能对不上，表现是扫码不弹、连上就断、或者 QQ 起不来。
// 面板把「内置 NapCat 版本 / 它适配的 QQ 版本 / 本机 QQ 版本 / 最新 NapCat」摆在一起，
// 出问题时用户能直接看出是不是版本错位，而不是对着黑窗猜。
const NAPCAT_QQNT_FILE = path.join(NAPCAT_DIR, 'qqnt.json');
const NAPCAT_UPDATE_CACHE = path.join(STATE_DIR, 'napcat-update.json');
const NAPCAT_RELEASE_API = 'https://api.github.com/repos/NapNeko/NapCatQQ/releases/latest';
const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000;

// 版本号比较。允许出现非数字段（比如 1.0.6.fix）：两边都是数字就比数值，
// 一边数字一边不是就把带数字的那个算小，都不是就比字符串。缺位按空串处理，
// 于是 1.0.6.fix > 1.0.6，9.9.36-53644 > 9.9.36。
function cmpVersion(a, b) {
  const pa = String(a ?? '').split(/[.\-+]/);
  const pb = String(b ?? '').split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? '';
    const y = pb[i] ?? '';
    if (x === y) continue;
    // 缺段算最小：9.9.36-53644 > 9.9.36，1.0.6.fix.1 > 1.0.6.fix，1.0.6.fix > 1.0.6
    if (x === '') return -1;
    if (y === '') return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d) return d;
    } else if (nx !== ny) {
      return nx ? 1 : -1;
    } else {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// 内置 NapCat 的版本号：优先 VERSION 文件（构建时写），否则从 bundle 里取那个常量。
function napcatVersion() {
  try {
    const file = path.join(NAPCAT_DIR, 'VERSION');
    if (fs.existsSync(file)) {
      const v = String(fs.readFileSync(file, 'utf8')).trim().split(/\r?\n/)[0].trim();
      if (/^\d+\.\d+\.\d+/.test(v)) return v;
    }
  } catch { /* 落到下面用 bundle 兜底 */ }
  try {
    // bundle 里是 `typeof x < "u" && "4.18.41" || "1.0.0-dev"` 这种形态，只命中一次。
    const s = fs.readFileSync(path.join(NAPCAT_DIR, 'napcat.mjs'), 'utf8');
    const m = s.match(/&&\s*"(\d+\.\d+\.\d+)"/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

// ── 版本与更新 ────────────────────────────────────────────────────────────
// 两条线各查各的：本程序自己（GitHub Release）和协议端 SnowLuma（GitHub Release）。
// 都带 6 小时缓存，查不到不算失败——国内网络连不上 GitHub 是常态，不能因此让面板报错。
const APP_MANIFEST = path.join(ROOT, 'package.json');
const UPDATE_CACHE = path.join(STATE_DIR, 'update-cache.json');
const UPDATE_RELEASES = {
  app: 'https://api.github.com/repos/NisssOwO/qq-robot-talking-FA/releases/latest',
  snowluma: 'https://api.github.com/repos/SnowLuma/SnowLuma/releases/latest'
};

function appVersion() {
  // 发布包里没有 package.json（构建只拷运行需要的东西），所以版本号放一个 VERSION 文件；
  // 源码目录则直接读 package.json。
  try {
    const v = String(fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8')).trim().split(/\r?\n/)[0].trim();
    if (v) return v;
  } catch { /* 没有 VERSION 就退回 package.json */ }
  try {
    return String(JSON.parse(fs.readFileSync(APP_MANIFEST, 'utf8')).version ?? '').trim();
  } catch {
    return '';
  }
}

function readUpdateCache() {
  try {
    return JSON.parse(fs.readFileSync(UPDATE_CACHE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeUpdateCache(cache) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(UPDATE_CACHE, JSON.stringify(cache, null, 2), 'utf8');
  } catch { /* 缓存写不了不影响功能，下次再查 */ }
}

async function cachedRelease(key, force = false) {
  const url = UPDATE_RELEASES[key];
  if (!url) return { version: '', url: '', error: 'unknown' };
  const cache = readUpdateCache();
  const hit = cache[key];
  if (!force && hit && Date.now() - (hit.checkedAt || 0) < UPDATE_CHECK_INTERVAL) return hit;
  // GitHub 在国内时通时不通，失败一次不算数，隔 400ms 再试一遍。
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt) await new Promise((r) => setTimeout(r, 400));
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'qq-bridge', accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(8000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const body_assets = Array.isArray(body.assets) ? body.assets : [];
      // 发布时挂的两个文件：安装包和绿色版 zip。这里顺手存下地址，
      // 自动更新时就不用再查一次 API。
      const setupAsset = body_assets.find((a) => /setup\.exe$/i.test(String(a.name || '')));
      const zipAsset = body_assets.find((a) => /\.zip$/i.test(String(a.name || '')));
      const entry = {
        version: String(body.tag_name ?? '').replace(/^v/i, '').trim(),
        url: String(body.html_url ?? ''),
        checkedAt: Date.now(),
        error: '',
        setupUrl: String(setupAsset?.browser_download_url ?? ''),
        setupSize: Number(setupAsset?.size ?? 0),
        zipUrl: String(zipAsset?.browser_download_url ?? ''),
        zipSize: Number(zipAsset?.size ?? 0)
      };
      cache[key] = entry;
      writeUpdateCache(cache);
      return entry;
    } catch (error) {
      lastError = error;
    }
  }
  // 失败时保留上次成功的版本号，只把错误记下来，免得界面从「已是最新」突然变成空白。
  const entry = { ...(hit || { version: '', url: '' }), error: String(lastError?.message ?? lastError), checkedAt: hit?.checkedAt || 0 };
  cache[key] = entry;
  writeUpdateCache(cache);
  return entry;
}

function snowlumaVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(SNOWLUMA_DIR, 'package.json'), 'utf8')).version ?? '').trim();
  } catch {
    return '';
  }
}

// QQ 升级后 SnowLuma 的 hook 可能跟不上，这是这套方案最常见的静默失效。
// 记下每次看到的 QQ 版本，变过就告诉用户「升级过，出问题时先怀疑 hook」。
const QQ_BASELINE = path.join(STATE_DIR, 'qq-baseline.json');

function readQQBaseline() {
  try {
    return JSON.parse(fs.readFileSync(QQ_BASELINE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function rememberQQVersion(version) {
  const cur = readQQBaseline();
  if (!version || cur.version === version) return cur;
  const next = { version, previous: String(cur.version ?? ''), changedAt: Date.now() };
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(QQ_BASELINE, JSON.stringify(next, null, 2), 'utf8');
  } catch { /* 记不下来就只是少一个提示 */ }
  return next;
}

async function updateInfo({ force = false } = {}) {
  const cfg = readConfig();
  const qqPath = await detectQQPath(cfg);
  const qqNow = installedQQVersion(qqPath);
  const baseline = rememberQQVersion(qqNow);
  const [appRelease, snowRelease] = await Promise.all([cachedRelease('app', force), cachedRelease('snowluma', force)]);

  const now = appVersion();
  const sl = snowlumaVersion();
  return {
    ok: true,
    app: {
      version: now,
      latest: appRelease.version || '',
      url: appRelease.url || 'https://github.com/NisssOwO/qq-robot-talking-FA/releases',
      checkedAt: appRelease.checkedAt || 0,
      error: appRelease.error || '',
      updateAvailable: !!(now && appRelease.version && cmpVersion(now, appRelease.version) < 0)
    },
    snowluma: {
      version: sl,
      installed: !!sl,
      latest: snowRelease.version || '',
      url: snowRelease.url || 'https://github.com/SnowLuma/SnowLuma/releases',
      error: snowRelease.error || '',
      updateAvailable: !!(sl && snowRelease.version && cmpVersion(sl, snowRelease.version) < 0)
    },
    qq: {
      version: qqNow,
      path: qqPath,
      previous: String(baseline.previous ?? ''),
      changed: !!(baseline.previous && qqNow && baseline.previous !== qqNow)
    }
  };
}

// NapCat 这一版是按哪个 QQ 版本适配的（qqnt.json 就是喂给 Electron 的伪 package.json）。
function napcatTargetQQ() {
  try {
    const j = JSON.parse(fs.readFileSync(NAPCAT_QQNT_FILE, 'utf8'));
    return { version: String(j.version ?? ''), buildVersion: String(j.buildVersion ?? ''), verHash: String(j.verHash ?? '') };
  } catch {
    return { version: '', buildVersion: '', verHash: '' };
  }
}

// 本机 QQ 的版本：NTQQ 把每个版本放在 `<QQ 目录>\versions\<版本号>\`，取最新那个。
// 只比对主版本段（9.9.36-53644 → 9.9.36），后面那段是构建号。
function installedQQVersion(qqPath) {
  const base = path.dirname(String(qqPath || ''));
  if (!base || base === '.') return '';
  const candidates = [];
  const vdir = path.join(base, 'versions');
  try {
    for (const name of fs.readdirSync(vdir)) {
      if (/^\d+\.\d+\.\d+/.test(name)) candidates.push(name);
    }
  } catch { /* 不是标准安装布局就看下面的 */ }
  if (!candidates.length) return '';
  candidates.sort(cmpVersion);
  return candidates[candidates.length - 1];
}

// 查最新版：6 小时内用缓存；查不到就退回旧缓存，绝不让面板卡住。
async function latestNapcatRelease(force = false) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(NAPCAT_UPDATE_CACHE, 'utf8')) || {}; } catch { cache = {}; }
  if (!force && cache.at && Date.now() - cache.at < UPDATE_CHECK_INTERVAL) return cache;
  try {
    const res = await fetch(NAPCAT_RELEASE_API, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'qq-bot-panel' },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const assets = Array.isArray(j.assets) ? j.assets : [];
    const out = {
      at: Date.now(),
      tag: String(j.tag_name ?? ''),
      version: String(j.tag_name ?? '').replace(/^v/i, ''),
      name: String(j.name ?? ''),
      url: String(j.html_url ?? ''),
      // 面板只做「提示 + 给链接」，不自动替换 23MB 的目录：换目录要停进程，出错代价太大。
      downloadUrl: assets.find((a) => a.name === 'NapCat.Shell.zip')?.browser_download_url ?? ''
    };
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(NAPCAT_UPDATE_CACHE, JSON.stringify(out, null, 2), 'utf8');
    return out;
  } catch (error) {
    const message = String(error?.message ?? error);
    return { ...cache, error: message, checkedAt: cache.at ?? null };
  }
}

async function versionInfo({ force = false } = {}) {
  const qqPath = await findQQPath();
  const local = napcatVersion();
  const target = napcatTargetQQ();
  const qqFull = installedQQVersion(qqPath);
  const qq = qqFull.split('-')[0];
  const latest = await latestNapcatRelease(force);
  // compat 只说「QQ 和 NapCat 适配的版本对不对得上」，running 与否另算。
  let compat = 'unknown';
  if (qq && target.version) {
    const d = cmpVersion(qq, target.version);
    compat = d === 0 ? 'match' : d > 0 ? 'newer' : 'older';
  }
  return {
    ok: true,
    napcat: { version: local, dir: NAPCAT_DIR, targetQQ: target.version, targetBuild: target.buildVersion, targetHash: target.verHash },
    qq: { version: qq, full: qqFull, path: qqPath },
    latest: {
      version: String(latest.version ?? ''),
      url: String(latest.url ?? ''),
      downloadUrl: String(latest.downloadUrl ?? ''),
      checkedAt: latest.at ?? latest.checkedAt ?? null,
      error: String(latest.error ?? '')
    },
    updateAvailable: Boolean(latest.version && local && cmpVersion(latest.version, local) > 0),
    compat
  };
}

// ── 一键更新 NapCat ───────────────────────────────────────────────
// 换的是「程序」，保留 config\（登录态），所以换完不用重新扫码。
// 但 hook 的 dll 是注入进 QQ 进程的：QQ 不退就删不掉旧目录，必须先全退。
const NAPCAT_UPDATE_DIR = path.join(STATE_DIR, 'napcat-update');

function countProcess(name) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command', `(Get-Process -Name '${name}' -ErrorAction SilentlyContinue | Measure-Object).Count`], { windowsHide: true }, (error, stdout) => {
      if (error) return resolve(0);
      resolve(Number(String(stdout ?? '').trim()) || 0);
    });
  });
}

function killByImage(name) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/IM', name, '/T', '/F'], { windowsHide: true }, () => resolve());
  });
}

function runPwsh(script, timeout = 240000) {
  return new Promise((resolve, reject) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || stdout || error.message).trim().slice(0, 400)));
      else resolve(String(stdout ?? ''));
    });
  });
}

function psq(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

// 面板自己是不是管理员。NapCat 的启动器一开始就查这个（launcher.bat 里的 net session），
// 不是管理员它会自己提权重开，就是因为它必须提权才能干活。
async function isElevated() {
  try {
    const out = await runPwsh(
      '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
      15000
    );
    return String(out).trim().toLowerCase() === 'true';
  } catch {
    return false;
  }
}

// 提权跑注入器：Start-Process -Verb RunAs 会弹一次 UAC，用户点「是」之后
// 新进程继承这里的环境变量（Start-Process 默认继承），所以五个 NAPCAT_* 照样带过去。
async function elevateBoot(qqPath, uin) {
  const env = [
    ['NAPCAT_PATCH_PACKAGE', path.join(NAPCAT_DIR, 'qqnt.json')],
    ['NAPCAT_LOAD_PATH', path.join(NAPCAT_DIR, 'loadNapCat.js')],
    ['NAPCAT_INJECT_PATH', NAPCAT_HOOK],
    ['NAPCAT_LAUNCHER_PATH', NAPCAT_BOOT],
    ['NAPCAT_MAIN_PATH', path.join(NAPCAT_DIR, 'napcat.mjs')]
  ]
    .map(([key, value]) => `$env:${key}=${psq(value)}`)
    .join('; ');

  const bootArgs = [qqPath, NAPCAT_HOOK, uin].filter(Boolean).map(psq).join(' ');
  const inner = env + `; & ${psq(NAPCAT_BOOT)} ${bootArgs} *> ${psq(path.join(STATE_DIR, 'napcat.log'))}`;
  const encoded = Buffer.from(inner, 'utf16le').toString('base64');
  const script =
    "Start-Process -FilePath 'powershell.exe' -Verb RunAs -PassThru " +
    `-ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand',${psq(encoded)}) ` +
    '| ForEach-Object { $_.Id }';
  return String(await runPwsh(script, 90000)).trim();
}

// ── 缺网关时一键装 ─────────────────────────────────────
// 按 SnowLuma 的 EULA，公开分发的包不能把网关打进来（构建时 --no-gateway），
// 所以别人的包里 snowluma\ 是空的，面板上只有一段「自己去 GitHub 下载解压」的说明。
// 对不熟电脑的人是道坎，这里直接代下代装：下完整版（自带 node.exe，不用先装 Node）。
const SNOWLUMA_RELEASE_API = 'https://api.github.com/repos/SnowLuma/SnowLuma/releases/latest';

async function installGateway({ force = false } = {}) {
  const installed = fs.existsSync(path.join(SNOWLUMA_DIR, 'index.mjs'));
  if (installed && !force) {
    return { ok: true, already: true, version: snowlumaVersion() };
  }
  // force = 升级：先把自己拉起来的网关停掉，外部拉起来的就报错让用户自己关，
  // 不然文件被占用会覆盖一半。
  if (children.snowluma) {
    await stopSnowLuma();
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  if (await probePort(ONEBOT_WS_PORT, 800)) {
    throw new Error('网关还在运行，而且不是面板启动的。请先手动关掉它再更新。');
  }

  const res = await fetch(SNOWLUMA_RELEASE_API, {
    headers: { 'user-agent': 'qq-bot-panel', accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`查 SnowLuma 最新版失败：HTTP ${res.status}`);
  const rel = await res.json();
  const asset = (rel.assets || []).find((a) => /win-x64\.zip$/i.test(a.name) && !/lite/i.test(a.name));
  if (!asset) throw new Error('这个版本没有 Windows x64 完整包，只能去 Releases 手动下载');

  const dir = path.join(STATE_DIR, 'snowluma-setup');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(dir, 'snowluma.zip');
  const bytes = await fetchToFile(asset.browser_download_url, zip);
  log(`网关下载完成：${(bytes / 1048576).toFixed(1)} MB，开始解压…`);

  const stage = path.join(dir, 'unpacked');
  const q = (s) => s.replace(/'/g, "''");
  await runPwsh(`Expand-Archive -LiteralPath '${q(zip)}' -DestinationPath '${q(stage)}' -Force`);
  // 压缩包根目录可能多套一层。
  let root = stage;
  if (!fs.existsSync(path.join(root, 'index.mjs'))) {
    for (const d of fs.readdirSync(stage, { withFileTypes: true })) {
      if (d.isDirectory() && fs.existsSync(path.join(stage, d.name, 'index.mjs'))) {
        root = path.join(stage, d.name);
        break;
      }
    }
  }
  if (!fs.existsSync(path.join(root, 'index.mjs'))) throw new Error('解压后没找到 index.mjs，可能不是 SnowLuma 包');

  // 旧目录里的 config/ data/ logs/ 是登录态和设置，换版本时留着。
  const keep = ['config', 'data', 'logs'];
  const saved = [];
  if (fs.existsSync(SNOWLUMA_DIR)) {
    for (const name of keep) {
      const p = path.join(SNOWLUMA_DIR, name);
      if (fs.existsSync(p)) saved.push([name, p]);
    }
    const backup = `${SNOWLUMA_DIR}.old-${Date.now()}`;
    fs.renameSync(SNOWLUMA_DIR, backup);
    fs.rmSync(backup, { recursive: true, force: true });
  }
  fs.cpSync(root, SNOWLUMA_DIR, { recursive: true });
  for (const [name, from] of saved) {
    const to = path.join(SNOWLUMA_DIR, name);
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  try { fs.rmSync(UPDATE_CACHE, { force: true }); } catch { /* 缓存删不掉不影响 */ }

  const version = snowlumaVersion();
  log(`SnowLuma 装好了：${version || rel.tag_name}`);
  // 升级时是把旧网关停掉才换的文件，换完顺手拉起来，用户不用再点一次。
  let restarted = false;
  if (force) {
    try {
      await startSnowLuma();
      restarted = true;
      log('网关已按新版本重新启动');
    } catch (error) {
      log(`网关没起来：${error?.message ?? error}`);
    }
  }
  return { ok: true, version, tag: rel.tag_name, sizeMB: Math.round(bytes / 1048576), restarted };
}

// 面板自己更新。只有 Inno 装的版本能就地覆盖（目录里有 unins000.exe），
// 解压版给不了可靠的替换路径，只能让用户手动换。
// 流程：下载安装包 → 写一个接管脚本 → 停机器人 → 脚本等本进程退出后静默装到原目录 → 拉新版本
async function updateApp() {
  if (!fs.existsSync(path.join(ROOT, 'unins000.exe'))) {
    throw new Error('这个目录是解压版，没有安装记录，没法自动覆盖。去 Releases 下 zip 手动替换吧。');
  }
  const release = await cachedRelease('app', true);
  if (!release?.version) {
    throw new Error(`查最新版本失败：${release?.error || '拿不到版本号'}`);
  }
  const current = appVersion();
  if (cmpVersion(current, release.version) >= 0) {
    return { ok: true, already: true, version: current };
  }
  if (!release.setupUrl) throw new Error('最新版没挂 setup.exe，只能去 Releases 手动下载');

  const dir = path.join(STATE_DIR, 'app-update');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const setup = path.join(dir, 'setup.exe');
  const bytes = await fetchToFile(release.setupUrl, setup);
  log(`新版本下载完成：${(bytes / 1048576).toFixed(1)} MB（${current} → ${release.version}），准备替换…`);

  // Inno 的静默安装会覆盖 {app} 下的所有文件，config.json 与 state\ 用
  // onlyifdoesntexist / uninsneveruninstall 保护，不会被清掉。
  const q = (s) => String(s).replace(/'/g, "''");
  const launcher = path.join(ROOT, 'QQ聊天机器人.exe');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$oldPid = ${process.pid}`,
    '$deadline = (Get-Date).AddSeconds(30)',
    'while ((Get-Date) -lt $deadline) {',
    '  if (-not (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) { break }',
    '  Start-Sleep -Milliseconds 300',
    '}',
    'Start-Sleep -Milliseconds 600',
    `Start-Process -FilePath '${q(setup)}' -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/CLOSEAPPLICATIONS','/DIR="${q(ROOT)}"' -Wait`,
    'Start-Sleep -Milliseconds 800',
    `if (Test-Path '${q(launcher)}') { Start-Process -FilePath '${q(launcher)}' }`,
    ''
  ].join('\r\n');
  const scriptPath = path.join(dir, 'apply.ps1');
  // 带 BOM，PowerShell 5.1 才不会把中文路径按 GBK 读错。
  fs.writeFileSync(scriptPath, `\ufeff${script}`, 'utf8');

  try {
    await stopBot();
  } catch (error) {
    log(`停机器人时出错（继续更新）：${error?.message ?? error}`);
  }
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
  log('接管脚本已启动，面板即将退出并重装…');
  setTimeout(() => process.exit(0), 1500);
  return { ok: true, updating: true, from: current, to: release.version, sizeMB: Math.round(bytes / 1048576) };
}

async function fetchToFile(url, file) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(240000) });
  if (!res.ok) throw new Error('下载失败 HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return buf.length;
}

async function updateNapCat() {
  const rel = await latestNapcatRelease(true);
  if (!rel?.version) throw new Error(rel?.error || '查不到最新版本');
  if (!rel.downloadUrl) throw new Error('最新版没有 Windows 的 Shell 包');
  const from = napcatVersion();
  if (from && cmpVersion(rel.version, from) <= 0) return { ok: true, changed: false, from, to: rel.version };

  try { await stopGateway(); } catch { /* 本来就没在跑 */ }
  for (let i = 0; i < 12; i += 1) {
    if (!(await countProcess('QQ'))) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (await countProcess('QQ')) {
    throw new Error('QQ 还开着。NapCat 的 dll 被 QQ 进程占着，替换一定失败——请先完全退出 QQ（含右下角托盘图标）再点更新。');
  }

  const dir = NAPCAT_UPDATE_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(dir, 'napcat.zip');
  const bytes = await fetchToFile(rel.downloadUrl, zip);

  const stage = path.join(dir, 'unpacked');
  const q = (s) => s.replace(/'/g, "''");
  await runPwsh(`Expand-Archive -LiteralPath '${q(zip)}' -DestinationPath '${q(stage)}' -Force`);
  // 不同版本的压缩包，根目录可能多一层。
  let root = stage;
  if (!fs.existsSync(path.join(root, 'napcat.mjs'))) {
    for (const d of fs.readdirSync(stage, { withFileTypes: true })) {
      if (d.isDirectory() && fs.existsSync(path.join(stage, d.name, 'napcat.mjs'))) {
        root = path.join(stage, d.name);
        break;
      }
    }
  }
  if (!fs.existsSync(path.join(root, 'napcat.mjs'))) throw new Error('包里没找到 napcat.mjs，这可能不是 Windows Shell 包');

  const cfgDir = path.join(NAPCAT_DIR, 'config');
  const backup = path.join(dir, 'config-backup');
  if (fs.existsSync(cfgDir)) fs.cpSync(cfgDir, backup, { recursive: true });

  const old = path.join(dir, 'old');
  try {
    if (fs.existsSync(NAPCAT_DIR)) fs.renameSync(NAPCAT_DIR, old);
  } catch (error) {
    throw new Error('换不掉：旧 napcat 目录被占用（' + String(error?.message ?? error) + '）。确认 QQ 和网关都退干净了再试。');
  }
  fs.cpSync(root, NAPCAT_DIR, { recursive: true });
  if (fs.existsSync(backup)) fs.cpSync(backup, cfgDir, { recursive: true });
  fs.writeFileSync(path.join(NAPCAT_DIR, 'VERSION'), String(rel.version) + '\n', 'utf8');
  fs.rmSync(old, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, changed: true, from, to: rel.version, bytes };
}

// 启动 NapCat：先确认 NapCat 与 QQ 都在，再拉起注入器（它会启动 QQ 并挂 hook）。
async function startNapCat() {
  if (!napcatInstalled()) {
    return { ok: false, code: 'napcat-missing', error: '没有找到 napcat：' + NAPCAT_DIR, hint: '安装包应当自带 napcat 目录' };
  }
  if (await probePort(ONEBOT_WS_PORT)) return { ok: true, already: true, external: true };
  const qqPath = await findQQPath();
  if (!qqPath) {
    return {
      ok: false,
      code: 'qq-missing',
      error: '没有找到 QQ：NapCat 要先把 hook 注入 QQ 才能工作',
      hint: QQ_DOWNLOAD_URL
    };
  }
  const cfg = readConfig();
  const uin = String(cfg?.qq?.uin ?? '').trim();

  // 残留的注入器要先清掉：点多次「启动网关」会堆出好几个 NapCatWinBootMain，
  // 它们各自去拉 QQ，两个实例抢同一批文件时 QQ 就会弹「文件已损坏」。
  if (await countProcess('NapCatWinBootMain')) {
    await killByImage('NapCatWinBootMain.exe');
    await new Promise((r) => setTimeout(r, 600));
  }

  // QQ 自己已经开着时也不能再让注入器拉一个：NapCat 的用法是「它来启动 QQ」，
  // 已运行的实例会占着 dll，新实例起来就在校验阶段报文件损坏。
  const qqRunning = await countProcess('QQ');
  if (qqRunning) {
    log('启动前先关掉正在运行的 QQ（' + qqRunning + ' 个进程）');
    await killByImage('QQ.exe');
    for (let i = 0; i < 12; i += 1) {
      if (!(await countProcess('QQ'))) break;
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  // NapCat 官方要求管理员：launcher.bat 一上来就 net session 检查，不是管理员就自己提权重跑。
  // 原因是它要往 QQ 的 resources\app 里写 package.json、还要把 dll 注入到高完整性进程；
  // 普通权限下注入器能把 QQ 拉起来，hook dll 也注得进去，但 patch 写不进去 ——
  // 现象就是 QQ 起来了（进程还起不全），38000/38001/6099 一个都不开。
  if (!(await isElevated())) {
    const pid = await elevateBoot(qqPath, uin);
    children.napcat = null;
    log('NapCat 需要管理员权限，已请求提权（pid ' + pid + '，QQ: ' + qqPath + '）');
    return { ok: true, pid: Number(pid) || null, qq: qqPath, restartedQQ: qqRunning > 0, elevated: true };
  }

  const args = [qqPath, NAPCAT_HOOK];
  if (uin) args.push(uin); // 传了账号才会走快速登录，否则每次都要扫码
  // 这五个环境变量是 NapCat 的启动器认路用的：少了它们，注入器照样能把 QQ 拉起来，
  // 但不知道该在 QQ 里塞哪个 loadNapCat.js、用哪个 patch 包，结果就是 QQ 起来了、端口一个都不开。
  // 官方 launcher.bat 里也是这么一组，照抄。
  const env = {
    ...process.env,
    NAPCAT_PATCH_PACKAGE: path.join(NAPCAT_DIR, 'qqnt.json'),
    NAPCAT_LOAD_PATH: path.join(NAPCAT_DIR, 'loadNapCat.js'),
    NAPCAT_INJECT_PATH: NAPCAT_HOOK,
    NAPCAT_LAUNCHER_PATH: NAPCAT_BOOT,
    NAPCAT_MAIN_PATH: path.join(NAPCAT_DIR, 'napcat.mjs')
  };
  const out = fs.openSync(path.join(STATE_DIR, 'napcat.log'), 'a');
  const child = spawn(NAPCAT_BOOT, args, { cwd: NAPCAT_DIR, stdio: ['ignore', out, out], detached: true, windowsHide: true, env });
  child.unref();
  children.napcat = child;
  rememberPid('napcat', child.pid);
  log('NapCat 已启动（pid ' + child.pid + '，QQ: ' + qqPath + '）');
  return { ok: true, pid: child.pid, qq: qqPath, restartedQQ: qqRunning > 0 };
}

async function stopNapCat() {
  // 注入器是 NapCatWinBootMain.exe，不是 node 进程：findOwnPids 按命令行找 node 的方式碰不到它，
  // 必须按镜像名杀，否则网关显示停了、实际还挂着，下次启动就两个实例打架。
  const before = await countProcess('NapCatWinBootMain');
  if (before) await killByImage('NapCatWinBootMain.exe');
  if (children.napcat && !children.napcat.killed) {
    try { children.napcat.kill(); } catch {}
  }
  children.napcat = null;
  return { ok: true, stopped: before };
}

// 协议端只有一个入口：面板上所有「启动/停止网关」都走这里，按 config.gateway 分派。
// 否则用户把网关切成 NapCat 之后，旧按钮还在拉 SnowLuma。
function gatewayKind() {
  // 回滚后只有 SnowLuma 一种协议端；保留这个函数是因为端口、目录都要跟着它走。
  return 'snowluma';
}


// ── 独立后端的会话历史（人工编辑用）──────────────────────────────────────
// 会话文件由 src/backend/standalone.mjs 管理，这边只做「安全地读 / 删 / 截断」。
// 落盘之后机器人内存里还是旧的那份，所以编辑接口会顺带重启机器人让它重新 loadSession。
function standaloneSessionsDir() {
  return path.join(STATE_DIR, 'standalone', 'sessions');
}

// lastError 存的是 safeFailure 的对象，展示前压成一行字。
function errText(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  return String(v.message || v.apiCode || JSON.stringify(v));
}

// 只允许打开这几个数据文件，别的一律拒绝（这个接口能拉起外部程序）。
const REVEALABLE = {
  social: () => path.join(STATE_DIR, 'social-v2.json'),
  config: () => path.join(ROOT, 'config.json'),
  slang: () => path.join(STATE_DIR, 'slang.json'),
  stickers: () => path.join(STATE_DIR, 'stickers.json'),
  sessions: () => path.join(STATE_DIR, 'standalone', 'sessions'),
  statedir: () => STATE_DIR
};

function revealDataFile(key) {
  const pick = REVEALABLE[String(key || '')];
  if (!pick) throw new Error('不支持的 file：' + key);
  const target = pick();
  if (!fs.existsSync(target)) throw new Error('文件不存在：' + target);
  // explorer /select, 只高亮不打开，避免拿 .json 的默认关联乱跑
  spawn('explorer.exe', ['/select,' + target], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true, path: target };
}

function safeSessionId(raw) {
  const id = String(raw ?? '').trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error('会话 id 不合法');
  return id;
}

function listStandaloneSessions() {
  const dir = standaloneSessionsDir();
  const sessions = [];
  let files = [];
  try { files = fs.readdirSync(dir); } catch { files = []; }
  for (const f of files) {
    if (!f.endsWith('.json') || f.includes('.bak-')) continue;
    const id = f.replace(/\.json$/, '');
    let messages = 0, chars = 0, summaryChars = 0, updatedAt = '', preset = '', blocked = false, blockedAt = '', blockedError = '';
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const msgs = Array.isArray(d.messages) ? d.messages : [];
      messages = msgs.length;
      chars = msgs.reduce((n, m) => n + String(m?.content ?? '').length, 0);
      summaryChars = String(d.summary ?? '').length;
      updatedAt = String(d.updatedAt ?? '');
      preset = String(d.preset ?? '');
      if (d.auditBlocked) {
        blocked = true;
        blockedAt = String(d.auditBlocked.at ?? '');
        blockedError = errText(d.auditBlocked.lastError);
      }
    } catch { /* 文件坏了也照列，好让人一眼看见 */ }
    sessions.push({ id, file: f, messages, chars, summaryChars, updatedAt, preset, blocked, blockedAt, blockedError });
  }
  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { dir: path.relative(ROOT, dir), sessions };
}

function readStandaloneSession(rawId, full = false) {
  const id = safeSessionId(rawId);
  const file = path.join(standaloneSessionsDir(), id + '.json');
  if (!fs.existsSync(file)) throw new Error('没有这个会话：' + id);
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const msgs = Array.isArray(d.messages) ? d.messages : [];
  return {
    id,
    preset: String(d.preset ?? ''),
    summary: String(d.summary ?? ''),
    updatedAt: String(d.updatedAt ?? ''),
    blocked: !!d.auditBlocked,
    blockedAt: String(d.auditBlocked?.at ?? ''),
    blockedError: errText(d.auditBlocked?.lastError),
    messages: msgs.map((m, i) => {
      const text = String(m?.content ?? '');
      return {
        index: i,
        role: String(m?.role ?? ''),
        chars: text.length,
        calls: Array.isArray(m?.tool_calls) ? m.tool_calls.map((t) => String(t?.id ?? '')) : [],
        toolCallId: String(m?.tool_call_id ?? ''),
        preview: text.slice(0, 160),
        ...(full ? { content: text } : {})
      };
    })
  };
}

async function editStandaloneSession(input) {
  const id = safeSessionId(input?.id);
  const dir = standaloneSessionsDir();
  const file = path.join(dir, id + '.json');
  if (!fs.existsSync(file)) throw new Error('没有这个会话：' + id);
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  let msgs = Array.isArray(d.messages) ? d.messages : [];
  const before = msgs.length;
  const mode = String(input?.mode ?? '');

  // 先备份：人改坏了还能捞回来。
  const bak = file + '.bak-' + Date.now();
  fs.copyFileSync(file, bak);

  if (mode === 'delete') {
    const drop = new Set((Array.isArray(input.indices) ? input.indices : [])
      .map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < msgs.length));
    // 删 tool 消息时，如果它对应的 assistant 的所有 tool 都被删了，就连 assistant 一起删。
    // 留下孤儿 tool_call_id 会让下一次请求直接 400（这个坑踩过一次）。
    const owners = new Map();
    msgs.forEach((m, i) => {
      if (Array.isArray(m?.tool_calls)) for (const tc of m.tool_calls) if (tc?.id) owners.set(String(tc.id), i);
    });
    for (const i of [...drop]) {
      const m = msgs[i];
      const owner = m?.role === 'tool' && m.tool_call_id ? owners.get(String(m.tool_call_id)) : undefined;
      if (owner === undefined) continue;
      const siblings = (msgs[owner]?.tool_calls ?? []).map((tc) => String(tc?.id ?? ''));
      const allGone = siblings.every((sid) => {
        const at = msgs.findIndex((x) => x?.role === 'tool' && String(x?.tool_call_id) === sid);
        return at === -1 || drop.has(at);
      });
      if (allGone) drop.add(owner);
    }
    msgs = msgs.filter((_, i) => !drop.has(i));
  } else if (mode === 'keepLast') {
    const n = Math.max(1, Math.min(500, Number(input.count) || 0));
    msgs = msgs.slice(-n);
    // 切点落在 tool 上就是孤儿，往后挪到第一条非 tool。
    while (msgs.length && msgs[0]?.role === 'tool') msgs.shift();
  } else if (mode === 'unblock') {
    if (!d.auditBlocked) throw new Error('这个会话没有被暂停');
    d.auditBlocked = null;
  } else if (mode === 'clearSummary') {
    d.summary = '';
  } else if (mode === 'setSummary') {
    d.summary = String(input.text ?? '').slice(0, 8000);
  } else {
    throw new Error('不认识的操作：' + mode);
  }

  if (mode === 'delete' || mode === 'keepLast') d.messages = msgs;
  d.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(d, null, 2), 'utf8');

  let restarted = false;
  try {
    if (children.bridge && !children.bridge.killed) {
      await stopBot();
      await new Promise((r) => setTimeout(r, 1200));
      await startBot();
      restarted = true;
    }
  } catch (e) {
    log('改完会话后重启机器人失败：' + (e?.message ?? e));
  }

  return {
    id,
    before,
    after: Array.isArray(d.messages) ? d.messages.length : before,
    summaryChars: String(d.summary ?? '').length,
    backup: path.basename(bak),
    restarted
  };
}

async function startGateway() {
  return gatewayKind() === 'snowluma' ? startSnowLuma() : startNapCat();
}

async function stopGateway() {
  return gatewayKind() === 'snowluma' ? stopSnowLuma() : stopNapCat();
}

async function status() {
  const cfg = readConfig();
  // 两个网关的 WebUI 端口不同（SnowLuma 5099 / NapCat 6099），只探当前选中的那个，
  // 界面上的「网关页面」一栏才不会被另一个网关的端口带偏。
  const kind = gatewayKind(cfg);
  const gwWebuiPort = kind === 'snowluma' ? WEBUI_PORT : NAPCAT_WEBUI_PORT;
  const [webui, onebotHttp, onebotWs] = await Promise.all([
    probePort(gwWebuiPort),
    probePort(ONEBOT_HTTP_PORT),
    probePort(ONEBOT_WS_PORT)
  ]);
  const botAlive = children.bot && !children.bot.killed ? true : await probePort(Number(cfg?.consolePort ?? 3100), 500);
  const qqProcs = await listQQProcesses();
  const qqConfigured = String(cfg?.qq?.path ?? '').trim();
  // 网关装没装、目录、pid 都按当前选择取，别把 SnowLuma 的状态套到 NapCat 上。
  const gwInstalled = kind === 'snowluma' ? fs.existsSync(path.join(SNOWLUMA_DIR, 'index.mjs')) : napcatInstalled();
  const gwPid = (kind === 'snowluma' ? children.snowluma : children.napcat)?.pid ?? null;
  const gatewayState = {
    kind,
    label: kind === 'snowluma' ? 'SnowLuma' : 'NapCat',
    running: onebotWs || webui,
    webui,
    webuiPort: gwWebuiPort,
    webuiUrl: 'http://127.0.0.1:' + gwWebuiPort + '/',
    onebotHttp,
    onebotWs,
    installed: gwInstalled,
    dir: kind === 'snowluma' ? SNOWLUMA_DIR : NAPCAT_DIR,
    // 面板自己拉起来的进程才有 pid；外部已经在跑时是 null，界面上标「外部进程」。
    pid: gwPid,
    // NapCat 靠注入 QQ 工作；QQ 没开时灯是黄的而不是绿。
    needsQQ: kind === 'napcat'
  };
  return {
    // 新键：界面一律读它。snowluma 保留成同一份内容，避免旧页面/旧调用方拿到 undefined。
    gateway: gatewayState,
    snowluma: gatewayState,
    // 只有「网关起来了但 OneBot 没开」时才有值，前端拿到就直接显示
    gatewayHint,
    bot: { running: !!botAlive, pid: children.bot?.pid ?? null },
    // QQ 本体：网关靠注入它工作，所以面板要能把「装在哪、开没开」摆出来。
    qq: {
      running: qqProcs.length > 0,
      count: qqProcs.length,
      path: qqConfigured,
      configured: !!qqConfigured,
      autoLaunch: cfg?.qq?.autoLaunch !== false,
      // 正在跑的那个 QQ 的路径，比配置里存的更可信（用户可能重装到别处）
      runningPath: qqProcs.find((p) => p.path)?.path ?? ''
    },
    config: cfg
      ? {
          hasKey: !!String(cfg.llm?.apiKey ?? '').trim(),
          model: cfg.llm?.model ?? '',
          baseUrl: cfg.llm?.baseUrl ?? '',
          groups: cfg.allow?.groups ?? [],
          private: cfg.allow?.private ?? [],
          disabledGroups: cfg.allow?.disabled?.groups ?? [],
          disabledPrivate: cfg.allow?.disabled?.private ?? [],
          names: cfg.allow?.names ?? {},
          denyGroups: cfg.deny?.groups ?? [],
          denyPrivate: cfg.deny?.private ?? [],
          consolePort: cfg.consolePort ?? 3100,
          ownerQQ: cfg.ownerQQ ?? '',
          today: readSocialToday(cfg),
          // 界面上要填的不止语言模型一家：语音合成、联网搜索、网关令牌都是密钥。
          tts: {
            enabled: cfg.tts?.enabled !== false,
            hasKey: !!String(cfg.tts?.apiKey ?? '').trim(),
            baseUrl: cfg.tts?.baseUrl ?? '',
            model: cfg.tts?.model ?? ''
          },
          webSearch: {
            hasKey: !!String(cfg.webSearch?.apiKey ?? '').trim(),
            apiKeyEnv: cfg.webSearch?.apiKeyEnv ?? '',
            baseURL: cfg.webSearch?.baseURL ?? ''
          },
          gateway: {
            // 选的是哪一套：NapCat 不用令牌，界面上那几栏 SnowLuma 字段要跟着隐藏/变灰。
            kind: cfg?.gateway === 'snowluma' ? 'snowluma' : 'napcat',
            hasToken: !!String(cfg.snowluma?.accessToken ?? '').trim(),
            wsUrl: cfg.snowluma?.wsUrl ?? '',
            httpUrl: cfg.snowluma?.httpUrl ?? ''
          },
          hasConsoleToken: !!String(cfg.consoleToken ?? '').trim(),
          // 后端是 standalone（直连模型 API，默认）还是 dsh（连 DeepSeek Harness）。
          // 选 dsh 时端口每次都会变，界面上要给"检测端口"的按钮。
          backend: cfg.backend === 'dsh' ? 'dsh' : 'standalone',
          dsh: {
            baseUrl: cfg.dsh?.baseUrl ?? '',
            hasToken: !!String(cfg.dsh?.authToken ?? '').trim()
          }
        }
      : null,
    // 桥接控制台（完整功能：角色卡、TTS、二代仿真、黑话、调试…）就嵌在面板的选项卡里。
    // 这个地址只在鼠标本机可用，和面板自身一样。
    console: consoleEntry(cfg),
    configPath: CONFIG_PATH,
    root: ROOT
  };
}

// 拼出带令牌的控制台地址；令牌优先取 config.consoleToken，没有就读桥接自动生成并落盘的那个。
function consoleEntry(cfg) {
  const port = Number(cfg?.consolePort ?? 3100);
  let token = String(cfg?.consoleToken ?? '').trim();
  if (!token) {
    try { token = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); } catch {}
  }
  return {
    port,
    token,
    url: `http://127.0.0.1:${port}/` + (token ? `?token=${encodeURIComponent(token)}` : ''),
    hasToken: !!token
  };
}

function tailLines(file, count) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    return lines.slice(-count);
  } catch {
    return [];
  }
}

function rememberPid(kind, pid) {
  try {
    const map = JSON.parse(fs.readFileSync(PIDS_FILE, 'utf8'));
    map[kind] = pid;
    fs.writeFileSync(PIDS_FILE, JSON.stringify(map), 'utf8');
  } catch {}
}

function snowlumaNode() {
  const bundled = path.join(SNOWLUMA_DIR, 'node.exe');
  return fs.existsSync(bundled) ? bundled : process.execPath;
}

// 网关默认端口是 3000/3001，Windows 有一段保留端口把它占了，绑不上。
// 本程序统一用 38000/38001，所以启动网关之前先把它自己的配置改过来。
function normalizeGatewayPorts() {
  const cfgDir = path.join(SNOWLUMA_DIR, 'config');
  const result = { files: 0, changed: [], tokenFixed: [] };
  if (!fs.existsSync(cfgDir)) return result;
  let names = [];
  try { names = fs.readdirSync(cfgDir).filter((n) => /^onebot_.*\.json$/i.test(n)); } catch { return result; }
  result.files = names.length;
  // 桥接只认 config.snowluma.accessToken 这一个 token。网关那边如果配成别的
  // （重建目录后 SnowLuma 会随机生成一对新 token），日志里就是
  // 「rejected unauthorized WebSocket upgrade」+ 一直连不上 38000。这里顺手对齐。
  const wantToken = String(readConfig()?.snowluma?.accessToken || '').trim();
  for (const name of names) {
    const file = path.join(cfgDir, name);
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      let dirty = false;
      let tokenDirty = false;
      const fix = (s) => {
        if (Number(s.port) === 3000) { s.port = ONEBOT_HTTP_PORT; dirty = true; }
        if (Number(s.port) === 3001) { s.port = ONEBOT_WS_PORT; dirty = true; }
        if (wantToken && s.accessToken !== wantToken) { s.accessToken = wantToken; tokenDirty = true; }
      };
      for (const s of raw?.networks?.httpServers ?? []) fix(s);
      for (const s of raw?.networks?.wsServers ?? []) fix(s);
      // 面板要连 38000/38001，如果用户自己填过别的端口就别动；token 必须一致，无条件对齐
      if (dirty || tokenDirty) {
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
        fs.renameSync(tmp, file);
        if (dirty) result.changed.push(name);
        if (tokenDirty) result.tokenFixed.push(name);
      }
    } catch (error) {
      log(`网关配置读不出 ${name}：${error?.message ?? error}`);
    }
  }
  if (result.changed.length) log(`网关端口已统一到 ${ONEBOT_HTTP_PORT}/${ONEBOT_WS_PORT}：${result.changed.join(', ')}`);
  if (result.tokenFixed.length) log(`网关 token 已对齐到配置文件里的值：${result.tokenFixed.join(', ')}（要重启网关才生效）`);
  return result;
}

async function startSnowLuma() {
  if (children.snowluma) return { ok: true, already: true };
  // 先修配置再判断：外部已在跑的网关下次重启也能拿到正确端口
  const ports = normalizeGatewayPorts();
  if (await probePort(ONEBOT_WS_PORT, 600)) return { ok: true, already: true, external: true, ports };
  const entry = path.join(SNOWLUMA_DIR, 'index.mjs');
  if (!fs.existsSync(entry)) {
    return {
      ok: false,
      code: 'gateway-missing',
      error: '没有找到 QQ 网关：snowluma\\index.mjs',
      hint: '从 SnowLuma 的 GitHub 仓库 Releases 下载 Windows 版，解压后把文件夹改名为 snowluma，放到本程序目录下（与 node.exe 同一层）。'
    };
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const child = spawn(snowlumaNode(), ['index.mjs'], {
    cwd: SNOWLUMA_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  child.stdout.on('data', (d) => logs.snowluma.push(String(d)));
  child.stderr.on('data', (d) => logs.snowluma.push(String(d)));
  child.on('exit', (code) => {
    log(`SnowLuma 退出（${code}）`);
    if (children.snowluma === child) delete children.snowluma;
  });
  children.snowluma = child;
  rememberPid('snowluma', child.pid);
  log(`SnowLuma 已启动（pid ${child.pid}）`);
  // 网关进程起来了不等于 QQ 那头接上了：SnowLuma 只能给「还没跑起来」的 QQ 注入 hook。
  // QQ 早就在跑（或者上一次注入没生效）时，OneBot 的 38001 不会开，
  // 面板却显示「网关运行中」，机器人于是一直连不上。
  // 这里在后台盯着，不挡住「启动网关」的返回。
  gatewayHint = '';
  void (async () => {
    const tail = children.snowluma;
    const ok = await waitPort(ONEBOT_WS_PORT, 20000);
    if (children.snowluma !== tail) return; // 期间又被停掉或重启了，别覆盖新状态
    if (!ok) {
      gatewayHint = '网关进程起来了，但 QQ 那头没接上（38001 没开）。把 QQ 完全退出（托盘图标也要退）再打开一次，然后点「刷新」。';
      log('网关进程起了，但 OneBot（38001）没开——多半是 QQ 没被重新注入');
    }
  })();
  return { ok: true, pid: child.pid };
}

function taskkill(pid) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
  });
}

// 面板重启过之后，children.* 就空了，但外面那个进程还在跑。
// 所以不能只认自己 spawn 的句柄，要按工作目录扫一遍 node 进程。
function findOwnPids(marker) {
  return new Promise((resolve) => {
    // 必须写成一行：-Command 后面换行会被拼成同一条语句，缺分号就直接语法错。
    // ROOT 里可能带中文，经 env 传给 PowerShell 会被破坏成乱码，
    // 所以只比对路径里那段纯 ASCII 的目录名（qq-bot）+ 进程标记。
    const script = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" `
      + `| Where-Object { $_.CommandLine -like ('*' + $env:QQBOT_TAG + '*' + $env:QQBOT_MARKER + '*') } `
      + `| ForEach-Object { $_.ProcessId }`;
    execFile('powershell', ['-NoProfile', '-Command', script], {
      windowsHide: true,
      env: { ...process.env, QQBOT_TAG: path.basename(ROOT), QQBOT_MARKER: marker }
    }, (error, stdout) => {
      if (error) return resolve([]);
      resolve(String(stdout ?? '').split(/\r?\n/).map((line) => Number(line.trim())).filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid));
    });
  });
}

async function stopSnowLuma() {
  let stopped = 0;
  if (children.snowluma) {
    await taskkill(children.snowluma.pid);
    delete children.snowluma;
    stopped += 1;
  }
  for (const pid of await findOwnPids('snowluma')) {
    await taskkill(pid);
    stopped += 1;
  }
  if (!stopped) return { ok: true, already: true };
  log(`SnowLuma 已停止（${stopped} 个进程）`);
  return { ok: true, stopped };
}

async function startBot() {
  if (children.bot) return { ok: true, already: true };
  const cfg = readConfig();
  if (!cfg) return { ok: false, error: '还没有配置' };
  if (!String(cfg.llm?.apiKey ?? '').trim()) return { ok: false, error: '请先填模型 API Key' };
  const groups = Array.isArray(cfg.allow?.groups) ? cfg.allow.groups.length : 0;
  const priv = Array.isArray(cfg.allow?.private) ? cfg.allow.private.length : 0;
  if (!groups && !priv) return { ok: false, error: '请至少填一个群号或好友 QQ' };
  // 面板外面已经跑着一个（比如 launch.mjs 起的），别起第二个抢 38001。
  if (await probePort(Number(cfg.consolePort ?? 3100), 500)) {
    return { ok: true, already: true, external: true };
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  const out = fs.openSync(BRIDGE_LOG, 'a');
  // stdout 必须丢掉：bridge.js 的 log() 自己会写 BRIDGE_LOG，再把 stdout 接到同一个文件
  // 就会每行写两遍，排查时看着像每条都触发了两次。stderr 仍接文件，崩溃堆栈只能从这儿拿。
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'bridge.js')], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', out],
    windowsHide: true
  });
  child.on('exit', (code) => {
    log(`机器人退出（${code}）`);
    if (children.bot === child) delete children.bot;
  });
  children.bot = child;
  rememberPid('bot', child.pid);
  log(`机器人已启动（pid ${child.pid}）`);
  return { ok: true, pid: child.pid };
}

async function stopBot() {
  let stopped = 0;
  if (children.bot) {
    await taskkill(children.bot.pid);
    delete children.bot;
    stopped += 1;
  }
  // 外部起的（launch.mjs / start.bat / 手动 node src\bridge.js）也要能停。
  for (const pid of [...await findOwnPids('src\\launch.mjs'), ...await findOwnPids('src\\bridge.js')]) {
    await taskkill(pid);
    stopped += 1;
  }
  if (!stopped) return { ok: true, already: true };
  log(`机器人已停止（${stopped} 个进程）`);
  return { ok: true, stopped };
}

function openAppWindow(url, reason = '') {
  log(`开窗请求：${reason || '未说明'} → ${url}（Windows 会另起一个浏览器窗口）`);
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.ProgramFiles ?? '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.ProgramFiles ?? '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? '', 'Google/Chrome/Application/chrome.exe')
  ].filter(Boolean);
  const browser = candidates.find((p) => p && fs.existsSync(p));
  if (!browser) return false;
  spawn(browser, [`--app=${url}`, '--window-size=1080,820'], { stdio: 'ignore', detached: true, windowsHide: false }).on('error', () => {});
  return true;
}

function mask(key) {
  const s = String(key ?? '');
  if (!s) return '';
  return s.length <= 8 ? '••••' : `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

function parseList(raw) {
  return String(raw ?? '')
    .split(/[\s,，、;；]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{4,15}$/.test(s))
    .map(Number);
}

function mergeConfig(base, input) {
  const next = { ...(base ?? {}) };
  const prevLlm = next.llm ?? {};
  next.llm = {
    ...DEFAULTS.llm,
    ...prevLlm,
    protocol: String(input.protocol ?? prevLlm.protocol ?? DEFAULTS.llm.protocol),
    baseUrl: String(input.baseUrl ?? '').trim() || prevLlm.baseUrl || DEFAULTS.llm.baseUrl,
    model: String(input.model ?? '').trim() || prevLlm.model || DEFAULTS.llm.model
  };
  const key = String(input.apiKey ?? '').trim();
  if (key) next.llm.apiKey = key;

  // 语音合成（Fish Audio 等 OpenAI 不兼容的自家接口）
  const prevTts = next.tts ?? {};
  next.tts = {
    ...DEFAULTS.tts,
    ...prevTts,
    baseUrl: String(input.ttsBaseUrl ?? '').trim() || prevTts.baseUrl || DEFAULTS.tts.baseUrl,
    model: String(input.ttsModel ?? '').trim() || prevTts.model || DEFAULTS.tts.model,
    enabled: input.ttsEnabled === undefined ? (prevTts.enabled ?? DEFAULTS.tts.enabled) : !!input.ttsEnabled
  };
  const ttsKey = String(input.ttsApiKey ?? '').trim();
  if (ttsKey) next.tts.apiKey = ttsKey;

  // 联网搜索（留空则回退到 apiKeyEnv 指向的环境变量）
  const prevWeb = next.webSearch ?? {};
  next.webSearch = {
    ...DEFAULTS.webSearch,
    ...prevWeb,
    baseURL: String(input.webSearchBaseURL ?? '').trim() || prevWeb.baseURL || DEFAULTS.webSearch.baseURL
  };
  const webKey = String(input.webSearchApiKey ?? '').trim();
  if (webKey) next.webSearch.apiKey = webKey;

  const prevSl = next.snowluma ?? {};
  const token = String(input.accessToken ?? '').trim();
  next.snowluma = {
    ...DEFAULTS.snowluma,
    ...prevSl,
    wsUrl: String(input.wsUrl ?? '').trim() || prevSl.wsUrl || DEFAULTS.snowluma.wsUrl,
    httpUrl: String(input.httpUrl ?? '').trim() || prevSl.httpUrl || DEFAULTS.snowluma.httpUrl
  };
  if (token) next.snowluma.accessToken = token;

  // 没提交这两个字段时保留原名单：否则一次局部保存就能把白名单清空。
  const prevAllow = next.allow ?? {};
  // 列表页一次性提交完整四份数据；没提交的字段保留原值，避免局部保存清空白名单。
  const numList = (v, prev) => {
    if (v === undefined) return prev ?? [];
    const arr = Array.isArray(v) ? v : parseList(v);
    const out = [];
    for (const x of arr) {
      const k = Number(String(x).trim());
      if (Number.isFinite(k) && k > 0 && !out.includes(k)) out.push(k);
    }
    return out;
  };
  const cleanNames = (v, prev) => {
    if (v === undefined) return prev ?? {};
    if (!v || typeof v !== 'object' || Array.isArray(v)) return prev ?? {};
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      const key = String(k).trim();
      const text = String(val ?? '').trim();
      if (/^[0-9]{5,12}$/.test(key) && text) out[key] = text.slice(0, 40);
    }
    return out;
  };
  const prevDisabled = prevAllow.disabled ?? {};
  next.allow = {
    ...prevAllow,
    groups: numList(input.groups, prevAllow.groups),
    private: numList(input.private, prevAllow.private),
    disabled: {
      groups: numList(input.disabledGroups, prevDisabled.groups),
      private: numList(input.disabledPrivate, prevDisabled.private)
    },
    names: cleanNames(input.allowNames, prevAllow.names)
  };
  // 拒绝名单：单独一层 deny，命中就一句话都不回（比「不启用」更硬）。
  const prevDeny = next.deny ?? {};
  next.deny = {
    ...prevDeny,
    groups: numList(input.denyGroups, prevDeny.groups),
    private: numList(input.denyPrivate, prevDeny.private)
  };
  if (String(input.ownerQQ ?? '').trim()) next.ownerQQ = Number(String(input.ownerQQ).trim()) || 0;
  // QQ 本体：路径留空表示没配（首次启动会去探测），autoLaunch 缺省开。
  const prevQQ = next.qq ?? {};
  next.qq = {
    ...DEFAULTS.qq,
    ...prevQQ,
    path: input.qqPath === undefined ? (prevQQ.path ?? '') : String(input.qqPath).trim(),
    autoLaunch: input.qqAutoLaunch === undefined
      ? (prevQQ.autoLaunch ?? DEFAULTS.qq.autoLaunch)
      : !!input.qqAutoLaunch
  };
  next.consolePort = Number(input.consolePort) || next.consolePort || DEFAULTS.consolePort;
  const consoleToken = String(input.consoleToken ?? '').trim();
  if (consoleToken) next.consoleToken = consoleToken;
  if (!next.consoleToken) next.consoleToken = crypto.randomBytes(8).toString('hex');

  // 可选后端 dsh（连 DeepSeek Harness）：它的端口每次启动都换，所以界面上给了"检测"按钮，
  // 检测完写回这里的 dsh.baseUrl。
  const prevDsh = next.dsh ?? {};
  next.dsh = { ...prevDsh };
  const dshBaseUrl = String(input.dshBaseUrl ?? '').trim().replace(/\/+$/, '');
  if (dshBaseUrl) next.dsh.baseUrl = dshBaseUrl;
  const dshToken = String(input.dshAuthToken ?? '').trim();
  if (dshToken) next.dsh.authToken = dshToken;

  if (String(input.backend ?? '').trim()) next.backend = input.backend === 'dsh' ? 'dsh' : 'standalone';
  return next;
}

// ── 角色包：一个角色一份 roles/<角色>.pack.json ──────────
// 桥接每次合成/唤醒前都会现读这个文件（按 mtime 缓存），所以这里写完立刻生效。
function listRoleNames() {
  try {
    return fs.readdirSync(ROLES_DIR)
      .filter((name) => /\.md$/i.test(name) && !/^readme/i.test(name))
      .map((name) => name.replace(/\.md$/i, ''));
  } catch { return []; }
}

function readRolePackFile(role) {
  const file = path.join(ROLES_DIR, `${role}.pack.json`);
  try {
    return { file, pack: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return { file, pack: null };
  }
}

function rolePackSummary(role) {
  const { file, pack } = readRolePackFile(role);
  const dict = pack && typeof pack.dictionary === 'object' && pack.dictionary ? pack.dictionary : null;
  return {
    name: role,
    hasPack: !!pack,
    voiceId: String(pack?.voiceId ?? ''),
    aliases: Array.isArray(pack?.aliases) ? pack.aliases : [],
    dictionary: dict,
    dictionaryCount: dict ? Object.keys(dict).length : 0,
    worldName: String(pack?.worldName ?? ''),
    file: path.relative(ROOT, file)
  };
}

function currentRoleName() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'current-role.json'), 'utf8')).role ?? '').trim();
  } catch { return ''; }
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 512 * 1024) throw new Error('请求体过大');
  }
  return raw;
}

function json(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  try {
    // ── 界面 ─────────────────────────────────────────────
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      // 页面加载 = 窗口还在，撤销任何「即将关窗」的挂起动作（刷新不算关闭）。
      cancelPendingClose();
      const html = fs.existsSync(HTML_PATH) ? fs.readFileSync(HTML_PATH) : Buffer.from('<h1>缺少 app/ui.html</h1>');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html);
    }
    // 桥接控制台本体：同源提供，外层只借用它的主内容区，导航由外层统一给。
    if (req.method === 'GET' && /^\/console(\/(index\.html)?)?$/.test(url.pathname)) {
      if (!fs.existsSync(CONSOLE_PATH)) {
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
        return res.end('<h1>找不到 public/console.html</h1>');
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(CONSOLE_PATH));
    }

    // 面板与桥接控制台共用的静态资源：主题变量、公共函数。
    if (req.method === 'GET' && (url.pathname === '/theme.css' || url.pathname === '/shared.js')) {
      const file = path.join(APP_DIR, url.pathname.slice(1));
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end(''); }
      const type = url.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(file));
    }

    // ── 面板自己的接口（进程管理 / 模型配置）───────────────
    if (url.pathname.startsWith('/panel/api/')) {
      const sub = url.pathname.slice('/panel/api/'.length);
      // 关窗行为：read / write。写的时候只认 closeAction 两个值。
      if (req.method === 'GET' && sub === 'settings') {
        return json(res, 200, { ok: true, ...readUiSettings() });
      }
      if (req.method === 'POST' && sub === 'settings') {
        const raw = await readBody(req);
        let input = {};
        try { input = JSON.parse(raw || '{}'); } catch { input = {}; }
        return json(res, 200, { ok: true, ...writeUiSettings(input) });
      }
      // 页面每次加载都会 ping 一次：用来区分「刷新」和「真关了」。
      if (req.method === 'GET' && sub === 'ping') {
        cancelPendingClose();
        return json(res, 200, { ok: true });
      }
      // 关窗时用 sendBeacon 打过来（不带 JSON 头）。先挂起 3 秒，中途有 ping 就取消。
      if (req.method === 'POST' && sub === 'window-closed') {
        cancelPendingClose();
        closeTimer = setTimeout(() => {
          closeTimer = null;
          void applyCloseAction();
        }, 3000);
        return json(res, 200, { ok: true, pending: true, closeAction: readUiSettings().closeAction });
      }
      if (req.method === 'GET' && sub === 'status') {
        return json(res, 200, { ok: true, ...(await status()) });
      }
      // 版本与更新：单独一个接口，因为它要联网查 GitHub 最新版（带 6 小时缓存），
      // 不能拖慢每 2.5 秒轮询一次的 /status。
      if (req.method === 'GET' && sub === 'version') {
        try {
          return json(res, 200, await updateInfo({ force: url.searchParams.get('force') === '1' }));
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }
      if (req.method === 'GET' && sub === 'logs') {
        // bridge=机器人的桥接日志；snowluma=网关日志；ui=面板自己的启动/操作日志。
        // 三个来源都在面板里看，用户不用再去开黑窗口。
        const want = String(url.searchParams.get('which') ?? '');
        const which = want === 'snowluma' ? 'snowluma' : want === 'ui' ? 'ui' : 'bridge';
        const count = Math.min(400, Math.max(20, Number(url.searchParams.get('tail') ?? 120)));
        const extra = which === 'snowluma' ? logs.snowluma.join('').split(/\r?\n/).filter(Boolean) : [];
        const file = which === 'snowluma' ? SNOWLUMA_LOG : which === 'ui' ? UI_LOG : BRIDGE_LOG;
        const lines = which === 'snowluma' && extra.length ? extra.slice(-count) : tailLines(file, count);
        return json(res, 200, { ok: true, which, lines });
      }
      if (req.method === 'GET' && sub === 'live') {
        // 转成桥接的 /api/live：面板不自己猜「静默/观察/潜水/思考中」，
        // 免得两边的状态判定标准越走越远。
        req.url = '/api/live';
        return proxyConsole(req, res);
      }
      if (sub === 'rolepacks' && req.method === 'GET') {
        const cfg = readConfig() ?? {};
        const names = listRoleNames();
        return json(res, 200, {
          ok: true,
          currentRole: currentRoleName(),
          roles: names.map(rolePackSummary),
          configDefaults: {
            voiceId: String(cfg.tts?.voiceId ?? '').trim(),
            aliases: Array.isArray(cfg.socialV2?.wake?.aliases) ? cfg.socialV2.wake.aliases : []
          }
        });
      }
      if (sub === 'rolepack' && req.method === 'POST') {
        const input = JSON.parse((await readBody(req)) || '{}');
        const role = String(input.role ?? '').trim();
        if (!role) return json(res, 400, { ok: false, error: '缺少角色名' });
        if (!listRoleNames().includes(role)) return json(res, 400, { ok: false, error: `没有这个角色卡：${role}` });
        const file = path.join(ROLES_DIR, `${role}.pack.json`);
        if (input.remove) {
          try { fs.unlinkSync(file); } catch { /* 本来就没有 */ }
          return json(res, 200, { ok: true, removed: true, role });
        }
        let dictionary = {};
        if (typeof input.dictionary === 'string' && input.dictionary.trim()) {
          try { dictionary = JSON.parse(input.dictionary); } catch (e) { return json(res, 400, { ok: false, error: '注音字典不是合法 JSON：' + e.message }); }
        } else if (input.dictionary && typeof input.dictionary === 'object' && !Array.isArray(input.dictionary)) {
          dictionary = input.dictionary;
        }
        const aliases = Array.isArray(input.aliases)
          ? input.aliases.map((s) => String(s).trim()).filter(Boolean)
          : String(input.aliases ?? '').split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);
        // 保持和已有文件一致的键序，方便人肉 diff。
        const pack = { role, roleFile: `roles/${role}.md` };
        const voiceId = String(input.voiceId ?? '').trim();
        if (voiceId) pack.voiceId = voiceId;
        if (aliases.length) pack.aliases = aliases;
        if (dictionary && Object.keys(dictionary).length) pack.dictionary = dictionary;
        pack.worldName = String(input.worldName ?? '').trim() || role;
        fs.mkdirSync(ROLES_DIR, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(pack, null, 2) + '\n', 'utf8');
        return json(res, 200, { ok: true, pack, file: path.relative(ROOT, file) });
      }
      // ── 会话历史：自动整理未必合心意，这里让人自己看、自己删 ──────────
      if (sub === 'reveal' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        try { json(res, 200, revealDataFile(body.file)); }
        catch (e) { json(res, 400, { ok: false, error: e.message }); }
        return;
      }
      if (sub === 'sessions' && req.method === 'GET') {
        return json(res, 200, { ok: true, ...listStandaloneSessions() });
      }
      if (sub === 'session' && req.method === 'GET') {
        const id = String(url.searchParams.get('id') ?? '').trim();
        const full = url.searchParams.get('full') === '1';
        try {
          return json(res, 200, { ok: true, ...readStandaloneSession(id, full) });
        } catch (e) {
          return json(res, 400, { ok: false, error: e?.message ?? String(e) });
        }
      }
      if (sub === 'session' && req.method === 'POST') {
        let input = {};
        try { input = JSON.parse((await readBody(req)) || '{}'); } catch { input = {}; }
        try {
          return json(res, 200, { ok: true, ...(await editStandaloneSession(input)) });
        } catch (e) {
          return json(res, 400, { ok: false, error: e?.message ?? String(e) });
        }
      }
      if (req.method === 'POST' && sub === 'config') {
        const input = JSON.parse((await readBody(req)) || '{}');
        writeConfig(mergeConfig(readConfig() ?? { ...DEFAULTS }, input));
        return json(res, 200, { ok: true });
      }
      if (sub === 'models' && (req.method === 'GET' || req.method === 'POST')) {
        // 「获取可用模型」：拿当前填的地址与 key 去问 OpenAI 兼容的 /models。
        // key 留空就用配置里已存的那个，用户不必为了看一眼列表再输入一遍。
        const input = req.method === 'POST'
          ? JSON.parse((await readBody(req)) || '{}')
          : Object.fromEntries(url.searchParams.entries());
        const cfg = readConfig() ?? {};
        const baseUrl = String(input.baseUrl ?? '').trim() || String(cfg.llm?.baseUrl ?? '').trim();
        const apiKey = String(input.apiKey ?? '').trim() || String(cfg.llm?.apiKey ?? '').trim();
        if (!baseUrl) return json(res, 400, { ok: false, error: '先填接口地址' });
        if (!apiKey) return json(res, 400, { ok: false, error: '没有可用的 API Key' });
        const started = Date.now();
        try {
          const target = baseUrl.replace(/\/+$/, '') + '/models';
          const resp = await fetch(target, {
            headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
            signal: AbortSignal.timeout(20000)
          });
          const text = await resp.text();
          if (!resp.ok) {
            return json(res, 502, { ok: false, error: `模型列表返回 ${resp.status}：${text.slice(0, 200)}` });
          }
          let parsed = {};
          try { parsed = JSON.parse(text); } catch { return json(res, 502, { ok: false, error: '返回的不是 JSON：' + text.slice(0, 120) }); }
          const list = Array.isArray(parsed.data) ? parsed.data : Array.isArray(parsed.models) ? parsed.models : Array.isArray(parsed) ? parsed : [];
          const models = list
            .map((item) => (typeof item === 'string' ? item : item?.id ?? item?.name ?? ''))
            .map((id) => String(id).trim())
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b));
          return json(res, 200, { ok: true, models, count: models.length, ms: Date.now() - started });
        } catch (error) {
          const msg = error?.name === 'TimeoutError' ? '请求超时（20s）' : (error?.message ?? String(error));
          return json(res, 502, { ok: false, error: `拉取模型列表失败：${msg}` });
        }
      }
      if (sub === 'image-models' && (req.method === 'GET' || req.method === 'POST')) {
        // 生图模型的「获取可用模型」：跟语言模型那个一样，拿 baseUrl + key 问 /models，
        // 但结果按名字粗筛一遍（image/dall/flux/sd/kolors/wanx/seedream 之类）。
        const input = req.method === 'POST'
          ? JSON.parse((await readBody(req)) || '{}')
          : Object.fromEntries(url.searchParams.entries());
        const cfg = readConfig() ?? {};
        const baseUrl = String(input.baseUrl ?? '').trim() || String(cfg.socialV2?.qzone?.aiImage?.baseUrl ?? '').trim();
        const apiKey = String(input.apiKey ?? '').trim();
        if (!baseUrl) return json(res, 400, { ok: false, error: '先填生图接口地址' });
        if (!apiKey) return json(res, 400, { ok: false, error: '先填生图 API Key' });
        const started = Date.now();
        try {
          const { listImageModels } = await import('../src/image-gen.mjs');
          const result = await listImageModels({ baseUrl, apiKey });
          return json(res, 200, {
            ok: true,
            models: result.models,
            filtered: result.filtered,
            total: result.total,
            ms: Date.now() - started
          });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
      if (sub === 'tts-models' && (req.method === 'GET' || req.method === 'POST')) {
        const ttsCfg = (readConfig() ?? {}).tts ?? {};
        const engines = ['s2.1-pro-free', 's2-pro', 'speech-1.6', 'speech-1.5', 's1'];
        return json(res, 200, {
          ok: true,
          models: engines,
          count: engines.length,
          current: String(ttsCfg.model ?? '').trim(),
          hasKey: !!String(ttsCfg.apiKey ?? '').trim() || !!String(process.env.FISH_API_KEY ?? '').trim(),
          note: 'Fish Audio 引擎版本；音色（voiceId）在「角色包」页配。'
        });
      }
      if (sub === 'dsh/endpoint' && req.method === 'GET') {
        // 「检测 DSH 端口」：DSH 桌面端每次启动会换一个随机端口，而桥接的地址写在 config.json 里。
        // 这里现场扫一遍（netstat + HTTP 指纹认得 DSH 的 401 / __DSH_BOOT__），把结果交给界面填。
        const started = Date.now();
        const script = path.join(ROOT, 'scripts', 'dsh-endpoint.mjs');
        if (!fs.existsSync(script)) {
          return json(res, 501, { ok: false, error: '这个版本没带 dsh-endpoint.mjs（只有选 DSH 后端才需要）' });
        }
        const result = await new Promise((resolve) => {
          execFile(process.execPath, [script, '--json'], { cwd: ROOT, timeout: 30000, windowsHide: true }, (error, stdout) => {
            if (error) return resolve({ ok: false, error: `检测失败：${error.message}` });
            const last = String(stdout).trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
            try { resolve(JSON.parse(last)); } catch { resolve({ ok: false, error: `识别不了检测输出：${last.slice(0, 120)}` }); }
          });
        });
        return json(res, 200, { ...result, ms: Date.now() - started });
      }
      // 缺网关的包（--no-gateway）用这个接口代下代装。
      if (req.method === 'POST' && sub === 'gateway/install') {
        try {
          return json(res, 200, await installGateway());
        } catch (e) {
          return json(res, 500, { ok: false, error: e.message });
        }
      }
      // 网关升级：不管装没装，都下最新版替换（保留 config/data/logs）。
      if (req.method === 'POST' && sub === 'gateway/update') {
        try {
          return json(res, 200, await installGateway({ force: true }));
        } catch (e) {
          return json(res, 500, { ok: false, error: e.message });
        }
      }
      // 面板自己更新：下载 setup.exe，交给独立脚本覆盖安装并重启。
      if (req.method === 'POST' && sub === 'app/update') {
        try {
          return json(res, 200, await updateApp());
        } catch (e) {
          return json(res, 500, { ok: false, error: e.message });
        }
      }
      // snowluma/* 是旧名字，保留着兼容老页面和外部脚本；实际按 config.gateway 分派。
      if (req.method === 'POST' && (sub === 'snowluma/start' || sub === 'gateway/start')) {
        return json(res, 200, await startGateway());
      }
      if (req.method === 'POST' && (sub === 'snowluma/stop' || sub === 'gateway/stop')) {
        return json(res, 200, await stopGateway());
      }
      if (req.method === 'POST' && sub === 'bot/start') return json(res, 200, await startBot());
      if (req.method === 'POST' && sub === 'bot/stop') return json(res, 200, await stopBot());
      if (sub === 'gateway' && req.method === 'GET') return json(res, 200, await gatewayInfo());
      if (req.method === 'POST' && sub === 'qq/start') return json(res, 200, await startQQ());
      if (req.method === 'POST' && sub === 'qq/pick') return json(res, 200, await pickQQPath());
      if (req.method === 'POST' && sub === 'qq/detect') {
        const p = await detectQQPath(readConfig());
        return json(res, 200, p ? { ok: true, path: p } : { ok: false, error: '没探测到 QQ.exe，请点「浏览…」手动选' });
      }
      if (req.method === 'POST' && sub === 'open-webui') {
        // 登录页地址跟网关走：NapCat 的 WebUI 在 6099，SnowLuma 在 5099。
        const port = gatewayKind() === 'snowluma' ? WEBUI_PORT : NAPCAT_WEBUI_PORT;
        const url = `http://127.0.0.1:${port}/`;
        const opened = openAppWindow(url, '点了「登录页」（网关 WebUI）');
        return json(res, 200, { ok: opened, url });
      }
      if (req.method === 'POST' && sub === 'mask') {
        return json(res, 200, { ok: true, apiKey: mask(readConfig()?.llm?.apiKey), accessToken: mask(readConfig()?.snowluma?.accessToken) });
      }
      return json(res, 404, { ok: false, error: 'not found' });
    }

    // ── 其余 /api/* 都是桥接控制台的请求：转给 127.0.0.1:<consolePort> ──
    if (url.pathname.startsWith('/api/')) return proxyConsole(req, res);

    return json(res, 404, { ok: false, error: 'not found' });
  } catch (error) {
    return json(res, 500, { ok: false, error: error?.message ?? String(error) });
  }
});

// 把控制台请求原样转给桥接，并顺手补上令牌（浏览器的同源请求不会自己带）。
function proxyConsole(req, res) {
  const entry = consoleEntry(readConfig());
  const headers = { ...req.headers, host: `127.0.0.1:${entry.port}` };
  delete headers.connection;
  // 浏览器带的 Origin/Referer 是面板自己的地址，桥接那边会当成跨站请求挡掉。
  // 这里本来就是本机同源代理，去掉再转发。
  delete headers.origin;
  delete headers.referer;
  if (entry.token) headers['x-console-token'] = entry.token;
  const up = http.request(
    { host: '127.0.0.1', port: entry.port, path: req.url, method: req.method, headers },
    (ur) => {
      const out = { ...ur.headers };
      delete out['x-frame-options'];
      delete out['content-security-policy'];
      res.writeHead(ur.statusCode ?? 502, out);
      ur.pipe(res);
    }
  );
  up.on('error', () => {
    if (res.headersSent) return res.end();
    json(res, 502, { ok: false, error: '控制台不可达：机器人还没启动？' });
  });
  req.pipe(up);
}

const port = Number(process.env.QQ_BOT_UI_PORT) || Number(process.env.QQ_BOT_SETUP_PORT) || 3199;

// ── 关窗行为 ─────────────────────────────────────────────
// 浏览器窗口关掉时，面板服务默认继续留在后台（机器人照跑）。用户可以在页面上改成
// 「一并停止」。选完写进 state/ui.json，下次打开还是这个选择。
const UI_SETTINGS_PATH = path.join(STATE_DIR, 'ui.json');

function readUiSettings() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(UI_SETTINGS_PATH, 'utf8')) || {};
  } catch {
    raw = {};
  }
  // 旧的 keep/stop 迁移到新的 tray/exit
  const closeAction = raw.closeAction === 'exit' || raw.closeAction === 'stop'
    ? 'exit'
    : 'tray';
  const theme = raw.theme === 'dark' || raw.theme === 'light' ? raw.theme : 'auto';
  return {
    closeAction,
    theme,
    rememberClose: raw.rememberClose === true,
    exitStopsServices: raw.exitStopsServices !== false,
    // 是否已经走过「快速开始」：只用来决定第一次打开要不要拦到引导页，
    // 之后用户点「以后再说」也算走过，不再打扰。
    onboarded: raw.onboarded === true
  };
}

function writeUiSettings(patch) {
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(UI_SETTINGS_PATH, 'utf8')) || {}; } catch { prev = {}; }
  const next = { ...readUiSettings(), ...prev, ...patch };
  next.closeAction = next.closeAction === 'exit' || next.closeAction === 'stop' ? 'exit' : 'tray';
  next.theme = next.theme === 'dark' || next.theme === 'light' ? next.theme : 'auto';
  next.rememberClose = next.rememberClose === true;
  next.exitStopsServices = next.exitStopsServices !== false;
  next.onboarded = next.onboarded === true;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(UI_SETTINGS_PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

let closeTimer = null;

function cancelPendingClose() {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
}

async function applyCloseAction() {
  const { closeAction } = readUiSettings();
  log(`窗口已关闭：${closeAction === 'stop' ? '按设置一并停止机器人和网关' : '继续在后台运行'}`);
  if (closeAction !== 'stop') return;
  await stopBot().catch(() => {});
  await stopSnowLuma().catch(() => {});
  setTimeout(() => process.exit(0), 300);
}

async function shutdown() {
  log('正在退出，停掉本窗口启动的进程…');
  if (children.bot) await taskkill(children.bot.pid);
  if (children.snowluma) await taskkill(children.snowluma.pid);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.on('error', async (error) => {
  if (error?.code === 'EADDRINUSE') {
    const url = `http://127.0.0.1:${port}/`;
    // 已经有一个面板在跑：不要起第二个（否则两台进程抢同一份 state）。
    // 直接确认它活着，然后把窗口指过去。
    try {
      const res = await fetch(`${url}panel/api/ping`);
      const data = await res.json();
      if (data && data.ok) {
        console.log(`[ui] 面板已经在运行：${url}（复用，不再启动第二个）`);
        if (OPEN_WINDOW) openAppWindow(url, '已有面板在跑，把浏览器窗口指过去');
        else console.log('[ui] 已有面板在跑；本进程不开浏览器窗口（要开请加 --open）');
        setTimeout(() => process.exit(0), 600);
        return;
      }
    } catch {
      // 占用端口的不是本程序的面板，走下面的提示。
    }
    console.error(`[ui] 端口 ${port} 被别的程序占用了。关掉它，或设置 QQ_BOT_UI_PORT=3200 再启动。`);
  } else {
    console.error('[ui] 启动失败：', error?.message ?? error);
  }
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}/`;
  console.log(`[ui] 控制面板：${url}`);
  console.log(`[ui] 配置：${CONFIG_PATH}`);
  if (OPEN_WINDOW) {
    const ok = openAppWindow(url, '启动时加了 --open');
    if (!ok) console.log(`[ui] 没找到 Edge/Chrome，手动打开 ${url}`);
  } else if (HOSTED_BY_LAUNCHER) {
    console.log('[ui] 窗口由 QQ聊天机器人.exe 提供，不开浏览器窗口。');
  } else {
    console.log(`[ui] 不开浏览器窗口；要看面板请打开 ${url}，或加 --open 启动。`);
  }
  autostart().catch((error) => log(`自动启动出错：${error?.message ?? error}`));
});

// 配置齐了就自动把网关和机器人拉起来，让「双击 start.bat」等于「开始工作」。
async function autostart() {
  if (process.env.QQ_BOT_AUTOSTART === '0') {
    log('已跳过自动启动（QQ_BOT_AUTOSTART=0）');
    return;
  }
  const cfg = readConfig();
  const complete = !!(cfg && String(cfg.llm?.apiKey ?? '').trim() && ((cfg.allow?.groups?.length ?? 0) || (cfg.allow?.private?.length ?? 0)));
  if (!complete) {
    log('配置还没填完，在面板里填好再点启动。');
    return;
  }
  log('配置完整，自动启动…');
  // QQ 先起来：网关是往 QQ 进程里注入 hook 的，QQ 没开它只能干等。
  if (cfg?.qq?.autoLaunch !== false) {
    const qq = await startQQ();
    if (qq.already) log(`QQ 已在运行（${qq.count} 个进程），跳过。`);
    else if (qq.ok) log(`QQ 已拉起（${qq.path}），等它连上后网关会自动注入。`);
    else log(`QQ 没起来：${qq.error}`);
  } else {
    log('已关闭「启动时自动打开 QQ」，跳过检测。');
  }
  const gw = await startGateway();
  if (gw.external) log('网关已经在跑，复用。');
  else if (gw.ok) log('网关启动中，等 QQ 上线…');
  else if (gw.error) log(`网关没起来：${gw.error}`);
  // 给网关最多 60 秒上线；没上线也照样起桥接（桥接自己会重连）。
  for (let i = 0; i < 30; i += 1) {
    if (await probePort(ONEBOT_WS_PORT, 500)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  const bot = await startBot();
  if (bot.external) log('机器人已经在跑（外部进程），复用。');
  else if (bot.ok) log('机器人已启动。');
  else log(`机器人没起来：${bot.error}`);
}
