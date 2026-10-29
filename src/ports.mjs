// 端口小工具：探测、自动挑一个能用的、把「实际落地的端口」记下来。
//
// 为什么需要它：Windows 上 bind 127.0.0.1 除了「被别人占了」（EADDRINUSE），还会撞上
// 「动态端口排除范围」——Hyper-V / WSL / Docker 每次开机会重新划走一段（比如某次开机
// 把 3072-3171 整段保留），此时报的是 EACCES。两种都不是"用户配置错了"，程序应该自己
// 换一个端口继续跑，而不是让用户去改配置或翻日志。
//
// 约定：state/ports.json 是「实际端口」的唯一事实源，形如
//   { "panel": 3199, "console": 3300, "official": 3180, "gateway": { "http": 38000, "ws": 38001 }, "at": "..." }
// 各组件启动时读它；谁先 bind 成功谁负责写自己那一项。
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/** 真的 bind 一次看能不能用。EACCES / EADDRINUSE 都算不可用。 */
export function probeBind(port, host = '127.0.0.1', timeoutMs = 1200) {
  return new Promise((resolve) => {
    const n = Number(port);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) return resolve(false);
    const srv = net.createServer();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try { srv.close(); } catch { /* 已经关了 */ }
      resolve(ok);
    };
    srv.once('error', () => done(false));
    srv.once('listening', () => done(true));
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref?.();
    try {
      srv.listen({ port: n, host, exclusive: true });
    } catch {
      done(false);
    }
  });
}

/** 候选端口序列：首选 → 首选之后按 step 跳几个。跳过被别的组件占着的那几个。 */
export function portCandidates(preferred, { avoid = [], count = 6, step = 200 } = {}) {
  const base = Number(preferred);
  const out = [];
  const skip = new Set(avoid.map(Number).filter((n) => Number.isInteger(n)));
  for (let i = 0; i < count; i += 1) {
    const p = base + i * step;
    if (p > 65535) break;
    if (!skip.has(p)) out.push(p);
  }
  return out;
}

/** 按候选顺序挑第一个能 bind 的；全都不行返回 null。 */
export async function pickFreePort(preferred, opts = {}) {
  const list = opts.candidates ?? portCandidates(preferred, opts);
  for (const p of list) {
    if (await probeBind(p, opts.host ?? '127.0.0.1')) return p;
  }
  return null;
}

const PORTS_FILE = (root) => path.join(root, 'state', 'ports.json');

export function readPorts(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(PORTS_FILE(root), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/** 写一项（合并，不覆盖别人写的），顺手带上时间戳。写不动就算了，不阻断启动。 */
export function writePort(root, name, port) {
  try {
    const dir = path.join(root, 'state');
    fs.mkdirSync(dir, { recursive: true });
    const cur = readPorts(root);
    const next = { ...cur, [name]: port, at: new Date().toISOString() };
    const tmp = `${PORTS_FILE(root)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, PORTS_FILE(root));
    return next;
  } catch {
    return null;
  }
}

/** 读一项的实际端口，没有就回落到给定值。 */
export function portOf(root, name, fallback) {
  const v = readPorts(root)[name];
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}