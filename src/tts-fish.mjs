// Fish Audio 一次性语音合成（TTS）——QQ 语音消息用。
//
// 与 eidolon-sc 的关系：那边用 WebSocket 流式做实时通话，本文件只借用它的
// **一次性合成**接口（对应 eidolon 的 greetings.py）：
//   POST {baseUrl}/v1/tts
//   headers: Authorization: Bearer <key>, model: <model>
//   body: { text, reference_id: <voiceId>, format: "mp3" }
//
// 本模块是纯函数（无全局状态、不读 config 单例），便于测试与复用。
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import { cleanupTemp, probeAudio } from './voice-core.js';

/** 合成失败的类型化错误：调用方按 code 决定降级方式（一律降级成只发文字）。 */
export class TtsError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'TtsError';
    this.code = code;
    this.detail = detail;
  }
}

const MPEG1_LAYER3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_LAYER3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

/** 底层网络错误 → TtsError（超时 / 其它网络问题）。 */
function mapNetworkError(error, timeoutMs) {
  if (error instanceof TtsError) return error;
  const name = String(error?.name ?? '');
  if (name === 'TimeoutError' || name === 'AbortError' || /timeout/i.test(String(error?.message ?? ''))) {
    return new TtsError('timeout', `合成超时（${timeoutMs}ms）`);
  }
  return new TtsError('network', `连不上 Fish Audio：${error?.message ?? error}`);
}

/** 直连：走 Node 全局 fetch（它不读系统代理，所以没配代理时就是裸连）。 */
async function requestDirect({ url, headers, body, timeoutMs, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw mapNetworkError(error, timeoutMs);
  }
  let buffer;
  try {
    buffer = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw new TtsError('bad-response', `读取音频失败：${error?.message ?? error}`);
  }
  return {
    status: response.status,
    contentType: String(response.headers?.get?.('content-type') ?? ''),
    buffer
  };
}

/**
 * 走 HTTP 代理：CONNECT 隧道 + TLS + HTTP/1.1。
 *
 * 为什么单独实现：Node 的 fetch 不读系统代理，而给整个桥接进程设 HTTPS_PROXY 会连带
 * 影响 SnowLuma/DSH/图片下载。这里只包住 TTS 这一个请求，别的一律不动。
 * 零依赖（net/tls/http 都是内置模块），密钥只出现在请求头里，不进命令行。
 */
function requestViaProxy({ proxyUrl, url, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket = null;
    let timer = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) {
        try { socket?.destroy(); } catch {}
        reject(error);
        return;
      }
      resolve(value);
    };

    let target;
    let proxy;
    try {
      target = new URL(url);
      proxy = new URL(proxyUrl);
    } catch (error) {
      finish(new TtsError('no-proxy', `代理地址不合法：${error?.message ?? error}`));
      return;
    }

    const targetPort = Number(target.port || 443);
    const proxyPort = Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80));
    timer = setTimeout(() => finish(new TtsError('timeout', `合成超时（${timeoutMs}ms）`)), timeoutMs);

    socket = net.connect(proxyPort, proxy.hostname);
    socket.on('error', (error) => finish(mapNetworkError(error, timeoutMs)));
    socket.once('connect', () => {
      socket.write(
        `CONNECT ${target.hostname}:${targetPort} HTTP/1.1\r\n`
        + `Host: ${target.hostname}:${targetPort}\r\n`
        + 'Proxy-Connection: keep-alive\r\n\r\n'
      );
    });

    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.removeListener('data', onData);
      const statusLine = head.subarray(0, end).toString('latin1').split('\r\n')[0];
      const status = Number(/^HTTP\/\d\.\d\s+(\d{3})/.exec(statusLine)?.[1] ?? 0);
      if (status !== 200) {
        finish(new TtsError('network', `代理拒绝 CONNECT（${statusLine.slice(0, 60)}）`));
        return;
      }
      const tlsSocket = tls.connect({ socket, servername: target.hostname }, () => {
        const payload = Buffer.from(body, 'utf8');
        // 关键：用一次性 Agent 覆盖 createConnection。
        // 只写 `agent: false` 时 Node 会自己建连（绕开代理直连目标域名），在墙内必然超时。
        const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
        agent.createConnection = () => tlsSocket;
        const req = http.request(
          {
            host: target.hostname,
            port: targetPort,
            method: 'POST',
            path: `${target.pathname}${target.search}`,
            headers: { ...headers, 'content-length': String(payload.length), connection: 'close' },
            agent
          },
          (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => finish(null, {
              status: res.statusCode ?? 0,
              contentType: String(res.headers['content-type'] ?? ''),
              buffer: Buffer.concat(chunks)
            }));
          }
        );
        req.on('error', (error) => finish(mapNetworkError(error, timeoutMs)));
        req.end(payload);
      });
      tlsSocket.on('error', (error) => finish(mapNetworkError(error, timeoutMs)));
    };
    socket.on('data', onData);
  });
}

/**
 * Fish Audio 的 `pronunciation_dictionary`：把「写法 → 音素」的映射包成它的请求格式。
 * 空/无效时返回 null，调用方据此决定要不要带这个字段。
 */
export function buildDictionaryPayload(dictionary) {
  if (!dictionary || typeof dictionary !== 'object') return null;
  const items = Object.entries(dictionary)
    .filter(([key, value]) => typeof key === 'string' && key && typeof value === 'string' && value)
    .map(([key, value]) => ({ key, value, case_sensitive: true }));
  return items.length ? [{ items }] : null;
}

/**
 * 调 Fish Audio 合成一段 mp3。
 * @returns {Promise<{ buffer: Buffer, contentType: string }>}
 * @throws {TtsError} code: no-key | empty-text | timeout | network | auth | rate | server | bad-response | empty-audio
 */
export async function synthesizeFish({
  baseUrl = 'https://api.fish.audio',
  apiKey = '',
  model = 's2.1-pro-free',
  voiceId = '',
  text = '',
  timeoutMs = 30000,
  proxyUrl = '',
  dictionary = null,
  fetchImpl = globalThis.fetch
} = {}) {
  const key = String(apiKey ?? '').trim();
  if (!key) throw new TtsError('no-key', '未配置 Fish Audio API Key');
  const spoken = String(text ?? '').trim();
  if (!spoken) throw new TtsError('empty-text', '没有可合成的文本');
  if (!voiceId) throw new TtsError('no-voice', '当前角色没有音色 ID（角色包里的 voiceId 为空）');

  const url = `${String(baseUrl ?? '').replace(/\/+$/, '')}/v1/tts`;
  const headers = {
    authorization: `Bearer ${key}`,
    model: String(model),
    'content-type': 'application/json'
  };
  const payload = { text: spoken, reference_id: String(voiceId), format: 'mp3' };
  const pronunciation = buildDictionaryPayload(dictionary);
  if (pronunciation) payload.pronunciation_dictionary = pronunciation;
  const body = JSON.stringify(payload);
  const proxy = String(proxyUrl ?? '').trim();

  const { status, contentType, buffer } = proxy
    ? await requestViaProxy({ proxyUrl: proxy, url, headers, body, timeoutMs })
    : await requestDirect({ url, headers, body, timeoutMs, fetchImpl });

  if (status < 200 || status >= 300) {
    const detail = buffer.toString('utf8', 0, Math.min(200, buffer.length));
    if (status === 401 || status === 403) {
      throw new TtsError('auth', `API Key 无效或没有权限（HTTP ${status}）`, detail);
    }
    if (status === 429) {
      throw new TtsError('rate', 'Fish Audio 限流（HTTP 429），稍后再试', detail);
    }
    throw new TtsError('server', `Fish Audio 返回 HTTP ${status}`, detail);
  }

  if (!buffer.length) throw new TtsError('empty-audio', 'Fish Audio 返回了空音频');

  // 有时错误会以 200 + JSON 返回，别把它当音频存下来再发给 QQ。
  if (!/audio|octet-stream/i.test(contentType) && buffer[0] !== 0xff && buffer[0] !== 0x49) {
    throw new TtsError('bad-response', `返回的不是音频（content-type=${contentType || '空'}）`, buffer.toString('utf8', 0, Math.min(160, buffer.length)));
  }
  return { buffer, contentType: contentType || 'audio/mpeg' };
}

/**
 * 从 MP3 帧头估时长（ffprobe 不可用时的兜底）。
 * 只看 CBR：按首帧码率折算整段，VBR 会有偏差，所以宁可比实际略长。
 */
export function estimateMp3Seconds(buffer) {
  if (!buffer || !buffer.length) return 0;
  for (let i = 0; i < Math.min(buffer.length - 4, 64 * 1024); i += 1) {
    if (buffer[i] !== 0xff) continue;
    const b1 = buffer[i + 1];
    if ((b1 & 0xe0) !== 0xe0) continue;
    const versionBits = (b1 >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
    const layerBits = (b1 >> 1) & 0x03; // 1=Layer3
    if (layerBits !== 1) continue;
    const b2 = buffer[i + 2];
    const bitrateIndex = (b2 >> 4) & 0x0f;
    if (bitrateIndex === 0 || bitrateIndex === 15) continue;
    const table = versionBits === 3 ? MPEG1_LAYER3_BITRATES : MPEG2_LAYER3_BITRATES;
    const bitrateKbps = table[bitrateIndex];
    if (!bitrateKbps) continue;
    return (buffer.length * 8) / (bitrateKbps * 1000);
  }
  return (buffer.length * 8) / (128 * 1000); // 兜底按 128kbps
}

/**
 * 量一段音频的时长：优先 ffprobe，失败退回 MP3 帧头估算。
 * @returns {Promise<{ seconds: number, source: 'ffprobe'|'estimate', reason?: string }>}
 */
export async function measureSeconds(file, { ffprobePath = null, buffer = null } = {}) {
  const probe = await probeAudio(file, ffprobePath ? { ffprobePath } : {});
  if (probe.ok && Number(probe.duration) > 0) {
    return { seconds: Number(probe.duration), source: 'ffprobe' };
  }
  let bytes = buffer;
  if (!bytes) {
    try {
      bytes = fs.readFileSync(file);
    } catch (error) {
      return { seconds: 0, source: 'estimate', reason: `读文件失败：${error?.message ?? error}` };
    }
  }
  return { seconds: estimateMp3Seconds(bytes), source: 'estimate', reason: probe.reason };
}

/** 只清理本模块生成的文件，绝不碰用户自己的语音库。 */
export function cleanupTtsFiles(dir, keepFiles = 20) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir).filter((name) => /^tts-.*\.mp3$/i.test(name));
  } catch {
    return { removed: 0 };
  }
  if (entries.length <= keepFiles) return { removed: 0 };
  const withTime = entries.map((name) => {
    const full = path.join(dir, name);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(full).mtimeMs;
    } catch {}
    return { name, full, mtimeMs };
  }).sort((a, b) => b.mtimeMs - a.mtimeMs);
  let removed = 0;
  for (const item of withTime.slice(keepFiles)) {
    try {
      fs.unlinkSync(item.full);
      removed += 1;
    } catch {}
  }
  return { removed };
}

/**
 * 落盘：写到 <voiceDir>/tts/tts-<时间戳>.mp3，并按 keepFiles 清理最旧的文件。
 * @returns {{ file: string, relative: string }}
 */
export function saveTtsAudio(buffer, { voiceDir, keepFiles = 20, now = Date.now() } = {}) {
  if (!voiceDir) throw new TtsError('no-dir', '未配置语音目录');
  const dir = path.join(voiceDir, 'tts');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const file = path.join(dir, `tts-${stamp}-${Math.random().toString(36).slice(2, 6)}.mp3`);
  fs.writeFileSync(file, buffer);
  cleanupTtsFiles(dir, Math.max(1, Number(keepFiles) || 20));
  return { file, relative: path.relative(voiceDir, file).split(path.sep).join('/') };
}

/** 临时文件清理（与 voice-core 的约定保持一致）。 */
export { cleanupTemp };
