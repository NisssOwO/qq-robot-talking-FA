// 统一启动入口：向导 → SnowLuma → 桥接，一路托管。
//
// 用法（start.bat 调的就是这里）：
//   node src/launch.mjs
//
// 顺序：
//   1. 读 config.json，检查「模型 API Key / SnowLuma token / 白名单」是否齐了；不齐先开配置向导。
//   2. 确保 SnowLuma 在跑：38001 连得上就复用，连不上就拉起随包的 snowluma\index.mjs。
//   3. 等 QQ 登录（38001 可连）后 import bridge.js。
//
// 环境变量：
//   QQ_BOT_CONFIG          改用别的配置文件
//   QQ_BOT_SETUP_PORT      向导端口（默认 3199）
//   QQ_BOT_KILL_SNOWLUMA=1 桥接退出时顺手关掉本进程拉起的 SnowLuma
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = process.env.QQ_BOT_CONFIG || path.join(ROOT, 'config.json');
const MARKER = path.join(ROOT, 'state', 'setup-launch-requested');
const SETUP_SCRIPT = path.join(ROOT, 'app', 'setup.mjs');
const STATE_DIR = path.join(ROOT, 'state');
const SNOWLUMA_DIR = path.join(ROOT, 'snowluma');
const SNOWLUMA_PID = path.join(STATE_DIR, 'snowluma.pid');

const ONEBOT_WS_PORT = 38001;
const ONEBOT_HTTP_PORT = 38000;
const WEBUI_PORT = 5099;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function missingFields(cfg) {
  if (!cfg) return ['config.json'];
  const miss = [];
  if (!String(cfg.llm?.apiKey ?? '').trim()) miss.push('模型 API Key');
  if (!String(cfg.snowluma?.accessToken ?? '').trim()) miss.push('SnowLuma access token');
  const groups = Array.isArray(cfg.allow?.groups) ? cfg.allow.groups.length : 0;
  const priv = Array.isArray(cfg.allow?.private) ? cfg.allow.private.length : 0;
  if (!groups && !priv) miss.push('群号/好友白名单');
  return miss;
}

function probePort(port, timeoutMs = 900) {
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

async function waitPort(port, totalMs, onTick) {
  const startedAt = Date.now();
  let lastTick = 0;
  while (Date.now() - startedAt < totalMs) {
    if (await probePort(port)) return true;
    const elapsed = Date.now() - startedAt;
    if (onTick && elapsed - lastTick >= 10000) {
      lastTick = elapsed;
      onTick(elapsed);
    }
    await sleep(1000);
  }
  return false;
}

function openBrowser(url) {
  if (process.env.QQ_BOT_NO_BROWSER === '1') return;
  try {
    spawn('cmd.exe', ['/c', 'start', '""', url], { stdio: 'ignore', windowsHide: true, detached: true }).on('error', () => {});
  } catch {}
}

function runSetup() {
  if (!fs.existsSync(SETUP_SCRIPT)) {
    console.error(`[launch] 找不到配置向导：${SETUP_SCRIPT}`);
    console.error('[launch] 请手动编辑 config.json 后重试。');
    process.exit(1);
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SETUP_SCRIPT], { cwd: ROOT, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', (error) => {
      console.error('[launch] 启动配置向导失败：', error?.message ?? error);
      resolve(1);
    });
  });
}

function consumeMarker() {
  if (!fs.existsSync(MARKER)) return false;
  try {
    fs.unlinkSync(MARKER);
  } catch {}
  return true;
}

function snowlumaNode() {
  const bundled = path.join(SNOWLUMA_DIR, 'node.exe');
  if (fs.existsSync(bundled)) return bundled;
  return process.execPath;
}

function startSnowLuma() {
  const entry = path.join(SNOWLUMA_DIR, 'index.mjs');
  if (!fs.existsSync(entry)) {
    return { ok: false, reason: `找不到 ${entry}` };
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const logFile = path.join(STATE_DIR, 'snowluma.log');
  const out = fs.openSync(logFile, 'a');
  const child = spawn(snowlumaNode(), ['index.mjs'], {
    cwd: SNOWLUMA_DIR,
    stdio: ['ignore', out, out],
    detached: true,
    windowsHide: true
  });
  child.unref();
  try {
    fs.writeFileSync(SNOWLUMA_PID, String(child.pid ?? ''), 'utf8');
  } catch {}
  return { ok: true, pid: child.pid, logFile };
}

function clearSnowLumaPid() {
  try {
    fs.unlinkSync(SNOWLUMA_PID);
  } catch {}
}

// 网关默认端口 3000/3001 被 Windows 保留段占了，启动前统一改成 38000/38001
function normalizeGatewayPorts() {
  const cfgDir = path.join(SNOWLUMA_DIR, 'config');
  if (!fs.existsSync(cfgDir)) return;
  let names = [];
  try { names = fs.readdirSync(cfgDir).filter((n) => /^onebot_.*\.json$/i.test(n)); } catch { return; }
  const changed = [];
  for (const name of names) {
    const file = path.join(cfgDir, name);
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      let dirty = false;
      for (const s of raw?.networks?.httpServers ?? []) {
        if (Number(s.port) === 3000) { s.port = ONEBOT_HTTP_PORT; dirty = true; }
      }
      for (const s of raw?.networks?.wsServers ?? []) {
        if (Number(s.port) === 3001) { s.port = ONEBOT_WS_PORT; dirty = true; }
      }
      if (dirty) {
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
        fs.renameSync(tmp, file);
        changed.push(name);
      }
    } catch {
      /* 单个文件坏掉不影响启动 */
    }
  }
  if (changed.length) console.log(`[launch] 网关端口已统一到 ${ONEBOT_HTTP_PORT}/${ONEBOT_WS_PORT}：${changed.join(', ')}`);
}

async function ensureSnowLuma() {
  if (await probePort(ONEBOT_WS_PORT)) {
    console.log('[launch] SnowLuma 已在运行（38001 可连），直接复用。');
    return true;
  }

  // 网关默认 3000/3001，被 Windows 保留段占了，统一改成 38000/38001
  normalizeGatewayPorts();

  if (!fs.existsSync(path.join(SNOWLUMA_DIR, 'index.mjs'))) {
    console.log('[launch] 这个目录里没有 snowluma\\，跳过自启。');
    console.log('[launch] 需要先装 QQ 网关：从 https://github.com/SnowLuma/SnowLuma 的 Releases');
    console.log('[launch] 下载 Windows 版，解压后把文件夹改名为 snowluma，放到本目录（和 node.exe 同级）。');
    console.log('[launch] 或者你自己用别的方式启动 SnowLuma，只要 38001 端口能连上就行。');
    return false;
  }

  console.log('[launch] SnowLuma 没在跑，正在启动…');
  const started = startSnowLuma();
  if (!started.ok) {
    console.log(`[launch] 启动失败：${started.reason}`);
    return false;
  }
  console.log(`[launch] SnowLuma 进程已拉起（pid ${started.pid}），日志：${started.logFile}`);

  const webuiReady = await waitPort(WEBUI_PORT, 60000);
  if (webuiReady) {
    console.log(`[launch] SnowLuma 控制台已就绪：http://127.0.0.1:${WEBUI_PORT}/`);
    openBrowser(`http://127.0.0.1:${WEBUI_PORT}/`);
  } else {
    console.log(`[launch] 等了 60 秒还没看到控制台（${WEBUI_PORT}），先继续等 QQ 上线。`);
  }

  console.log('[launch] 等待 QQ 登录（首次使用请在打开的页面里扫码）…');
  const online = await waitPort(ONEBOT_WS_PORT, 300000, (elapsed) => {
    console.log(`[launch] 还在等 QQ 登录…（${Math.round(elapsed / 1000)} 秒）`);
    if (elapsed >= 20000) openBrowser(`http://127.0.0.1:${WEBUI_PORT}/`);
  });
  if (online) {
    console.log('[launch] QQ 已上线（38001 可连），继续启动机器人。');
    return true;
  }
  console.log('[launch] 5 分钟没等到 QQ 上线。仍然启动机器人，它会自己重连。');
  return true;
}

function maybeAutoStopSnowLuma() {
  if (process.env.QQ_BOT_KILL_SNOWLUMA !== '1') return;
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(SNOWLUMA_PID, 'utf8'));
  } catch {
    return;
  }
  if (!pid) return;
  try {
    process.kill(pid);
    console.log(`[launch] 已关闭 SnowLuma（pid ${pid}）。`);
  } catch {}
  clearSnowLumaPid();
}

async function main() {
  let cfg = readConfig();
  let miss = missingFields(cfg);

  if (miss.length) {
    console.log(`[launch] 配置还没填完（缺：${miss.join('、')}），先打开配置向导…`);
    fs.mkdirSync(path.dirname(MARKER), { recursive: true });
    try {
      if (fs.existsSync(MARKER)) fs.unlinkSync(MARKER);
    } catch {}
    await runSetup();
    cfg = readConfig();
    miss = missingFields(cfg);
    const requested = consumeMarker();
    if (!requested) {
      console.log('[launch] 向导已关闭，没有点「保存并启动」，先不启动机器人。');
      return;
    }
    if (miss.length) {
      console.log(`[launch] 还有字段没填（缺：${miss.join('、')}），先不启动机器人。`);
      return;
    }
    console.log('[launch] 配置已就绪，启动机器人。');
  }

  await ensureSnowLuma();
  process.on('exit', maybeAutoStopSnowLuma);
  if (process.env.QQ_BOT_LAUNCH_DRYRUN === '1') {
    console.log('[launch] DRYRUN：前置检查完成，不启动桥接。');
    return;
  }
  await import('./bridge.js');
}

await main();
