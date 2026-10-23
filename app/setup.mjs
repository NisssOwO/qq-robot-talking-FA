// 配置向导：第一次运行时的本地单页表单。
//
// 目的：用户双击 start.bat 就能用，不需要手改 config.json。
// 零依赖（只用 node:http），只监听 127.0.0.1。
//
// 用法：
//   node app/setup.mjs            # 打开向导
//   node app/setup.mjs --no-open  # 不自动开浏览器
//
// 保存后可以直接点「保存并启动」，本进程会 spawn src/bridge.js 然后退出。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(APP_DIR, '..');
const CONFIG_PATH = process.env.QQ_BOT_CONFIG || path.join(ROOT, 'config.json');
const OPEN_BROWSER = !process.argv.includes('--no-open');

// 主题变量与面板（app/ui.html）共用同一份 app/theme.css，视觉保持一致；
// 改色只改那一个文件。读不到时用空串，向导自己的规则不受影响。
const THEME_CSS = (() => {
  try { return fs.readFileSync(path.join(APP_DIR, 'theme.css'), 'utf8'); } catch { return ''; }
})();

const DEFAULTS = {
  backend: 'standalone',
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
  allow: { groups: [], private: [] },
  ownerQQ: 0,
  consolePort: 3100,
  consoleToken: ''
};

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeConfig(next) {
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

function str(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseList(raw) {
  // QQ 号只可能是数字；非数字一律丢掉，避免把说明文字写进白名单。
  return String(raw ?? '')
    .split(/[\s,，、;；]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{4,15}$/.test(s))
    .map(Number);
}

function maskKey(key) {
  const s = str(key);
  if (!s) return '（未设置）';
  return s.length <= 8 ? '••••' : `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function viewModel(cfg) {
  const c = cfg ?? {};
  const llm = { ...DEFAULTS.llm, ...(c.llm ?? {}) };
  const sl = { ...DEFAULTS.snowluma, ...(c.snowluma ?? {}) };
  const allow = c.allow ?? {};
  return {
    backend: str(c.backend, DEFAULTS.backend),
    protocol: str(llm.protocol, DEFAULTS.llm.protocol),
    baseUrl: str(llm.baseUrl, DEFAULTS.llm.baseUrl),
    model: str(llm.model, DEFAULTS.llm.model),
    apiKey: str(llm.apiKey),
    apiKeyMasked: maskKey(llm.apiKey),
    wsUrl: str(sl.wsUrl, DEFAULTS.snowluma.wsUrl),
    httpUrl: str(sl.httpUrl, DEFAULTS.snowluma.httpUrl),
    accessToken: str(sl.accessToken),
    accessTokenMasked: maskKey(sl.accessToken),
    groups: (allow.groups ?? []).join('\n'),
    private: (allow.private ?? []).join('\n'),
    ownerQQ: String(c.ownerQQ ?? ''),
    consolePort: String(c.consolePort ?? DEFAULTS.consolePort),
    consoleToken: str(c.consoleToken),
    hasKey: !!str(llm.apiKey)
  };
}

function renderPage(cfg, notice = '') {
  const v = viewModel(cfg);
  const token = v.consoleToken;
  const consoleUrl = `http://127.0.0.1:${esc(v.consolePort)}/${token ? `?token=${esc(token)}` : ''}`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QQ 聊天机器人 · 配置向导</title>
<style>
${THEME_CSS}
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.65 "Segoe UI","Noto Sans SC",system-ui,sans-serif; }
  .wrap { max-width: 820px; margin: 0 auto; padding: 40px 20px 80px; }
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing:.02em; }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 28px; }
  section { background: var(--surface); border:1px solid var(--border); border-radius: 14px; padding: 20px 22px; margin-bottom: 16px; }
  h2 { font-size: 13px; letter-spacing:.12em; text-transform: uppercase; color: var(--muted); margin: 0 0 16px; font-weight: 600; }
  label { display:block; font-size: 13px; color: var(--muted); margin: 12px 0 6px; }
  input, select, textarea { width:100%; padding: 9px 11px; border-radius: 9px; border:1px solid var(--border); background: var(--bg); color: var(--text); font: inherit; font-size: 14px; }
  textarea { min-height: 72px; resize: vertical; font-family: ui-monospace, Consolas, monospace; font-size: 13px; }
  input:focus, select:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .hint { font-size: 12px; color: var(--muted); margin-top: 6px; }
  .badge { display:inline-block; font-size:12px; padding:2px 8px; border-radius: 999px; border:1px solid var(--border); color:var(--muted); }
  .badge.ok { color: var(--accent); border-color: var(--accent); }
  .actions { display:flex; gap: 12px; align-items:center; margin-top: 8px; }
  button { cursor:pointer; border-radius: 10px; padding: 11px 20px; font: inherit; font-size:14px; border:1px solid var(--border); background: var(--surface); color: var(--text); }
  button.primary { background: var(--accent); color: var(#fff); border-color: var(--accent); font-weight: 600; }
  button:disabled { opacity:.5; cursor: default; }
  .toast { margin-top: 14px; font-size: 13px; min-height: 20px; color: var(--accent); }
  .toast.err { color: #c2410c; }
  a { color: var(--accent); }
  code { font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; background: var(--bg); padding:1px 5px; border-radius:5px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>七草叶月 · 配置向导</h1>
  <div class="sub">填一次就能跑。改动会写回 <code>config.json</code>，之后双击 <code>start.bat</code> 直接启动。</div>

  <form id="form">
    <section>
      <h2>模型</h2>
      <div class="row">
        <div>
          <label>运行方式</label>
          <select name="backend">
            <option value="standalone"${v.backend === 'standalone' ? ' selected' : ''}>独立运行（不依赖 DSH）</option>
            <option value="dsh"${v.backend === 'dsh' ? ' selected' : ''}>连接 DeepSeek Harness</option>
          </select>
        </div>
        <div>
          <label>协议</label>
          <select name="protocol">
            <option value="openai-completions"${v.protocol === 'openai-completions' ? ' selected' : ''}>OpenAI Chat Completions</option>
          </select>
        </div>
      </div>
      <label>接口地址</label>
      <input name="baseUrl" value="${esc(v.baseUrl)}" placeholder="https://api.deepseek.com/v1">
      <div class="row">
        <div>
          <label>模型名</label>
          <input name="model" value="${esc(v.model)}" placeholder="deepseek-chat">
        </div>
        <div>
          <label>API Key <span class="badge ${v.hasKey ? 'ok' : ''}">${v.hasKey ? '已设置' : '未设置'}</span></label>
          <input name="apiKey" type="password" value="${esc(v.apiKey)}" placeholder="sk-..." autocomplete="off">
        </div>
      </div>
      <div class="hint">当前：<code>${esc(v.apiKeyMasked)}</code>。留空表示不修改。</div>
    </section>

    <section>
      <h2>QQ 网关（SnowLuma）</h2>
      <div class="row">
        <div>
          <label>WebSocket</label>
          <input name="wsUrl" value="${esc(v.wsUrl)}" placeholder="ws://127.0.0.1:38001">
        </div>
        <div>
          <label>HTTP</label>
          <input name="httpUrl" value="${esc(v.httpUrl)}" placeholder="http://127.0.0.1:38000">
        </div>
      </div>
      <label>Access Token</label>
      <input name="accessToken" type="password" value="${esc(v.accessToken)}" placeholder="网关的 access token" autocomplete="off">
      <div class="hint">当前：<code>${esc(v.accessTokenMasked)}</code>。留空表示不修改。</div>
    </section>

    <section>
      <h2>允许说话的会话</h2>
      <label>群号（每行一个，或用逗号分隔）</label>
      <textarea name="groups" placeholder="123456789">${esc(v.groups)}</textarea>
      <label>好友 QQ（每行一个）</label>
      <textarea name="private" placeholder="1000000001">${esc(v.private)}</textarea>
      <label>管理员 QQ</label>
      <input name="ownerQQ" value="${esc(v.ownerQQ)}" placeholder="1000000001">
      <div class="hint">没有列在這裡的群/好友，机器人不会回应。</div>
    </section>

    <section>
      <h2>控制台</h2>
      <div class="row">
        <div>
          <label>控制台端口</label>
          <input name="consolePort" value="${esc(v.consolePort)}" placeholder="3100">
        </div>
        <div>
          <label>控制台 token</label>
          <input name="consoleToken" value="${esc(v.consoleToken)}" placeholder="留空自动生成">
        </div>
      </div>
      <div class="hint">启动后打开：<a href="${consoleUrl}" target="_blank" rel="noreferrer">${esc(consoleUrl)}</a></div>
    </section>

    <div class="actions">
      <button type="button" class="primary" id="btn-save-start">保存并启动机器人</button>
      <button type="button" id="btn-save">只保存</button>
      <span class="toast" id="toast">${esc(notice)}</span>
    </div>
  </form>
</div>
<script>
const form = document.getElementById('form');
const toast = document.getElementById('toast');
const btnSave = document.getElementById('btn-save');
const btnStart = document.getElementById('btn-save-start');

function say(text, isError) {
  toast.textContent = text;
  toast.className = isError ? 'toast err' : 'toast';
}

function payload() {
  const fd = new FormData(form);
  const out = {};
  for (const [k, val] of fd.entries()) out[k] = typeof val === 'string' ? val : '';
  return out;
}

async function save() {
  const res = await fetch('/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload()) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || ('保存失败（HTTP ' + res.status + '）'));
  return data;
}

btnSave.addEventListener('click', async () => {
  btnSave.disabled = true;
  try { await save(); say('已保存。'); } catch (e) { say(e.message, true); } finally { btnSave.disabled = false; }
});

btnStart.addEventListener('click', async () => {
  btnStart.disabled = true;
  say('正在保存…');
  try {
    await save();
    say('正在启动机器人…');
    const res = await fetch('/start', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || '启动失败');
    document.body.innerHTML = '<div class="wrap"><h1>机器人已启动</h1><div class="sub">这个页面可以关掉了。日志在 <code>state/bridge.log</code>。</div><div class="sub">控制台：<a href="' + data.consoleUrl + '" target="_blank" rel="noreferrer">' + data.consoleUrl + '</a></div></div>';
  } catch (e) {
    say(e.message, true);
    btnStart.disabled = false;
  }
});
</script>
</body>
</html>`;
}

function mergeConfig(base, input) {
  const next = { ...(base ?? {}) };
  next.backend = input.backend === 'dsh' ? 'dsh' : 'standalone';

  const prevLlm = next.llm ?? {};
  const apiKey = str(input.apiKey).trim();
  next.llm = {
    ...DEFAULTS.llm,
    ...prevLlm,
    protocol: str(input.protocol, DEFAULTS.llm.protocol),
    baseUrl: str(input.baseUrl, DEFAULTS.llm.baseUrl).trim() || DEFAULTS.llm.baseUrl,
    model: str(input.model, DEFAULTS.llm.model).trim() || DEFAULTS.llm.model
  };
  if (apiKey) next.llm.apiKey = apiKey;

  const prevSl = next.snowluma ?? {};
  const accessToken = str(input.accessToken).trim();
  next.snowluma = {
    ...DEFAULTS.snowluma,
    ...prevSl,
    wsUrl: str(input.wsUrl, DEFAULTS.snowluma.wsUrl).trim() || DEFAULTS.snowluma.wsUrl,
    httpUrl: str(input.httpUrl, DEFAULTS.snowluma.httpUrl).trim() || DEFAULTS.snowluma.httpUrl
  };
  if (accessToken) next.snowluma.accessToken = accessToken;

  next.allow = {
    ...(next.allow ?? {}),
    groups: parseList(input.groups),
    private: parseList(input.private)
  };
  if (str(input.ownerQQ).trim()) next.ownerQQ = Number(str(input.ownerQQ).trim()) || 0;
  next.consolePort = num(input.consolePort, DEFAULTS.consolePort);
  const token = str(input.consoleToken).trim();
  if (token) next.consoleToken = token;
  else if (!next.consoleToken) next.consoleToken = crypto.randomBytes(8).toString('hex');
  return next;
}

function startBot(cfg) {
  // 不在这里 spawn：交给 launch.mjs 统一启动，避免出现两个机器人进程。
  // 这里只留下「用户已经点过启动」的标记。
  const marker = path.join(ROOT, 'state', 'setup-launch-requested');
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, new Date().toISOString(), 'utf8');
}

function consoleUrlFor(cfg) {
  const port = cfg?.consolePort ?? DEFAULTS.consolePort;
  const token = cfg?.consoleToken ?? '';
  return `http://127.0.0.1:${port}/${token ? `?token=${token}` : ''}`;
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 256 * 1024) throw new Error('请求体过大');
  }
  return raw;
}

function pickPort(preferred) {
  return preferred;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const send = (code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };

  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(200, renderPage(readConfig()), 'text/html; charset=utf-8');
    }
    if (req.method === 'POST' && url.pathname === '/save') {
      const raw = await readBody(req);
      const input = JSON.parse(raw || '{}');
      const next = mergeConfig(readConfig() ?? { ...DEFAULTS }, input);
      writeConfig(next);
      return send(200, JSON.stringify({ ok: true }));
    }
    if (req.method === 'POST' && url.pathname === '/start') {
      const cfg = readConfig();
      if (!cfg) return send(400, JSON.stringify({ ok: false, error: '还没有保存配置' }));
      if (!str(cfg.llm?.apiKey)) return send(400, JSON.stringify({ ok: false, error: '请先填模型 API Key' }));
      if (!(cfg.allow?.groups?.length || cfg.allow?.private?.length)) {
        return send(400, JSON.stringify({ ok: false, error: '请至少填一个群号或好友 QQ' }));
      }
      startBot(cfg);
      setTimeout(() => {
        try { server.close(); } catch {}
        process.exit(0);
      }, 800);
      return send(200, JSON.stringify({ ok: true, consoleUrl: consoleUrlFor(cfg) }));
    }
    if (req.method === 'GET' && url.pathname === '/state') {
      const cfg = readConfig();
      return send(200, JSON.stringify({ ok: true, configPath: CONFIG_PATH, root: ROOT, hasConfig: !!cfg, consoleUrl: consoleUrlFor(cfg) }));
    }
    return send(404, JSON.stringify({ ok: false, error: 'not found' }));
  } catch (error) {
    return send(500, JSON.stringify({ ok: false, error: error?.message ?? String(error) }));
  }
});

const preferredPort = num(process.env.QQ_BOT_SETUP_PORT, 3199);
const port = pickPort(preferredPort);
server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.error(`[setup] 端口 ${port} 被占用，换一个：QQ_BOT_SETUP_PORT=3200 node app/setup.mjs`);
  } else {
    console.error('[setup] 启动失败：', error?.message ?? error);
  }
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}/`;
  const cfg = readConfig();
  console.log(`[setup] 配置向导已启动：${url}`);
  console.log(`[setup] 配置文件：${CONFIG_PATH}${cfg ? '' : '（还不存在，保存后会创建）'}`);
  if (OPEN_BROWSER) {
    spawn('cmd.exe', ['/c', 'start', '""', url], { stdio: 'ignore', windowsHide: true, detached: true }).on('error', () => {});
  }
});

// 十分钟没人操作就退出，避免后台常驻。
const idleTimer = setTimeout(() => {
  console.log('[setup] 长时间无操作，退出。');
  process.exit(0);
}, 10 * 60 * 1000);
idleTimer.unref?.();
