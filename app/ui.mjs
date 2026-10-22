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
const OPEN_WINDOW = !process.argv.includes('--no-open');

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
  allow: { groups: [], private: [] },
  backend: 'standalone',
  consolePort: 3100
};

const children = {};
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
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
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

async function status() {
  const [webui, onebotHttp, onebotWs] = await Promise.all([
    probePort(WEBUI_PORT),
    probePort(ONEBOT_HTTP_PORT),
    probePort(ONEBOT_WS_PORT)
  ]);
  const cfg = readConfig();
  const botAlive = children.bot && !children.bot.killed ? true : await probePort(Number(cfg?.consolePort ?? 3100), 500);
  return {
    snowluma: { running: onebotWs || webui, webui, onebotHttp, onebotWs },
    bot: { running: !!botAlive },
    config: cfg
      ? {
          hasKey: !!String(cfg.llm?.apiKey ?? '').trim(),
          model: cfg.llm?.model ?? '',
          baseUrl: cfg.llm?.baseUrl ?? '',
          groups: cfg.allow?.groups ?? [],
          private: cfg.allow?.private ?? [],
          consolePort: cfg.consolePort ?? 3100,
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
            hasToken: !!String(cfg.snowluma?.accessToken ?? '').trim(),
            wsUrl: cfg.snowluma?.wsUrl ?? '',
            httpUrl: cfg.snowluma?.httpUrl ?? ''
          },
          hasConsoleToken: !!String(cfg.consoleToken ?? '').trim()
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

async function startSnowLuma() {
  if (children.snowluma) return { ok: true, already: true };
  if (await probePort(ONEBOT_WS_PORT, 600)) return { ok: true, already: true, external: true };
  const entry = path.join(SNOWLUMA_DIR, 'index.mjs');
  if (!fs.existsSync(entry)) return { ok: false, error: `找不到 ${entry}` };
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
    const script = `$root = $env:QQBOT_ROOT; `
      + `Get-CimInstance Win32_Process -Filter "Name='node.exe'" `
      + `| Where-Object { $_.CommandLine -like ('*' + $root + '*') -and $_.CommandLine -like ('*' + $env:QQBOT_MARKER + '*') } `
      + `| ForEach-Object { $_.ProcessId }`;
    execFile('powershell', ['-NoProfile', '-Command', script], {
      windowsHide: true,
      env: { ...process.env, QQBOT_ROOT: ROOT, QQBOT_MARKER: marker }
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
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'bridge.js')], {
    cwd: ROOT,
    stdio: ['ignore', out, out],
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

function openAppWindow(url) {
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
  next.allow = {
    ...prevAllow,
    groups: input.groups === undefined ? (prevAllow.groups ?? []) : parseList(input.groups),
    private: input.private === undefined ? (prevAllow.private ?? []) : parseList(input.private)
  };
  if (String(input.ownerQQ ?? '').trim()) next.ownerQQ = Number(String(input.ownerQQ).trim()) || 0;
  next.consolePort = Number(input.consolePort) || next.consolePort || DEFAULTS.consolePort;
  const consoleToken = String(input.consoleToken ?? '').trim();
  if (consoleToken) next.consoleToken = consoleToken;
  if (!next.consoleToken) next.consoleToken = crypto.randomBytes(8).toString('hex');
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
      if (req.method === 'GET' && sub === 'logs') {
        const which = url.searchParams.get('which') === 'snowluma' ? 'snowluma' : 'bridge';
        const count = Math.min(400, Math.max(20, Number(url.searchParams.get('tail') ?? 120)));
        const extra = which === 'snowluma' ? logs.snowluma.join('').split(/\r?\n/).filter(Boolean) : [];
        const lines = which === 'snowluma' && extra.length ? extra.slice(-count) : tailLines(which === 'snowluma' ? SNOWLUMA_LOG : BRIDGE_LOG, count);
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
      if (req.method === 'POST' && sub === 'snowluma/start') return json(res, 200, await startSnowLuma());
      if (req.method === 'POST' && sub === 'snowluma/stop') return json(res, 200, await stopSnowLuma());
      if (req.method === 'POST' && sub === 'bot/start') return json(res, 200, await startBot());
      if (req.method === 'POST' && sub === 'bot/stop') return json(res, 200, await stopBot());
      if (req.method === 'POST' && sub === 'open-webui') {
        const opened = openAppWindow(`http://127.0.0.1:${WEBUI_PORT}/`);
        return json(res, 200, { ok: opened, url: `http://127.0.0.1:${WEBUI_PORT}/` });
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
  try {
    const raw = JSON.parse(fs.readFileSync(UI_SETTINGS_PATH, 'utf8'));
    return { closeAction: raw.closeAction === 'stop' ? 'stop' : 'keep' };
  } catch {
    return { closeAction: 'keep' };
  }
}

function writeUiSettings(patch) {
  const next = { ...readUiSettings(), ...patch };
  next.closeAction = next.closeAction === 'stop' ? 'stop' : 'keep';
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
        if (OPEN_WINDOW) openAppWindow(url);
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
    const ok = openAppWindow(url);
    if (!ok) console.log(`[ui] 没找到 Edge/Chrome，手动打开 ${url}`);
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
  const gw = await startSnowLuma();
  if (gw.external) log('网关已经在跑，复用。');
  else if (gw.ok) log('网关启动中，等 QQ 上线…');
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
