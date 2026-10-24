// 生图：两个后端，一个免费的、一个通用的。
//
// - pollinations：GET 一个 URL 就返回图片，不需要 key。免费、快，但图上有水印。
// - openai-compatible：POST {baseUrl}/images/generations，GPT-image / DALL·E / 各种中转都走这套。
//   返回可能是 b64_json 也可能是 url，两种都处理。
//
// 统一返回 { buffer, mime, ext, source }，调用方自己决定存哪。

const POLLINATIONS_BASE = 'https://image.pollinations.ai/prompt';

export class ImageGenError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImageGenError';
    this.code = code;
  }
}

function sniffMime(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length > 8 && buf.toString('ascii', 1, 4) === 'PNG') return { mime: 'image/png', ext: 'png' };
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (buf.length > 6 && buf.toString('ascii', 0, 3) === 'GIF') return { mime: 'image/gif', ext: 'gif' };
  // pollinations 有时把 jpeg 标成 .png，靠内容判断，认不出就按 png
  return { mime: 'image/png', ext: 'png' };
}

/**
 * @param {object} cfg  aiImage 配置：{ provider, baseUrl, apiKey, model, size, width, height, promptPrefix }
 * @param {string} prompt 英文 prompt 最好，中文也能出图但质量不稳
 * @returns {Promise<{buffer: Buffer, mime: string, ext: string, source: string}>}
 */
export async function generateImage(cfg, prompt) {
  const provider = String(cfg?.provider ?? 'pollinations').trim() || 'pollinations';
  const text = String(cfg?.promptPrefix ?? '').trim()
    ? `${String(cfg.promptPrefix).trim()}, ${String(prompt ?? '').trim()}`
    : String(prompt ?? '').trim();
  if (!text) throw new ImageGenError('empty-prompt', '生图 prompt 是空的');

  if (provider === 'pollinations') return generateViaPollinations(cfg, text);
  if (provider === 'openai-compatible') return generateViaOpenAI(cfg, text);
  throw new ImageGenError('bad-provider', `不认识的生图后端：${provider}`);
}

async function generateViaPollinations(cfg, text) {
  const width = Math.min(1536, Math.max(256, Number(cfg?.width) || 768));
  const height = Math.min(1536, Math.max(256, Number(cfg?.height) || 768));
  const model = String(cfg?.model ?? 'flux').trim() || 'flux';
  const url = `${POLLINATIONS_BASE}/${encodeURIComponent(text)}?width=${width}&height=${height}&nologo=true&model=${encodeURIComponent(model)}`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  } catch (error) {
    throw new ImageGenError('network', `连不上 pollinations：${error?.message ?? error}`);
  }
  if (!res.ok) throw new ImageGenError('http', `pollinations 返回 ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) throw new ImageGenError('empty-image', `pollinations 返回的图片太小（${buf.length} 字节）`);
  const { mime, ext } = sniffMime(buf);
  return { buffer: buf, mime, ext, source: `pollinations/${model}` };
}

async function generateViaOpenAI(cfg, text) {
  const baseUrl = String(cfg?.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!baseUrl) throw new ImageGenError('no-baseurl', '没填生图接口地址');
  const apiKey = String(cfg?.apiKey ?? '').trim();
  if (!apiKey) throw new ImageGenError('no-key', '没填生图 API Key');
  const model = String(cfg?.model ?? '').trim();
  if (!model) throw new ImageGenError('no-model', '没选生图模型');

  const body = { model, prompt: text, n: 1 };
  const size = String(cfg?.size ?? '').trim();
  if (size && size !== 'auto') body.size = size;

  let res;
  try {
    res = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    });
  } catch (error) {
    throw new ImageGenError('network', `连不上生图接口：${error?.message ?? error}`);
  }
  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch { /* 下面统一报错 */ }
  if (!res.ok) {
    const msg = data?.error?.message ?? data?.message ?? raw.slice(0, 200);
    throw new ImageGenError('http', `生图接口返回 ${res.status}：${msg}`);
  }
  const item = data?.data?.[0] ?? data?.images?.[0] ?? null;
  if (!item) throw new ImageGenError('bad-response', '生图接口没有返回图片');

  // 优先 base64；有些中转只给 url
  if (item.b64_json) {
    const buf = Buffer.from(item.b64_json, 'base64');
    if (buf.length < 1024) throw new ImageGenError('empty-image', '返回的 base64 图片太小');
    const { mime, ext } = sniffMime(buf);
    return { buffer: buf, mime, ext, source: `api/${model}` };
  }
  if (item.url) {
    let imgRes;
    try {
      imgRes = await fetch(item.url, { signal: AbortSignal.timeout(60000) });
    } catch (error) {
      throw new ImageGenError('network', `下载生成的图片失败：${error?.message ?? error}`);
    }
    if (!imgRes.ok) throw new ImageGenError('http', `下载生成的图片失败：${imgRes.status}`);
    const buf = Buffer.from(await imgRes.arrayBuffer());
    if (buf.length < 1024) throw new ImageGenError('empty-image', '返回的图片太小');
    const { mime, ext } = sniffMime(buf);
    return { buffer: buf, mime, ext, source: `api/${model}` };
  }
  throw new ImageGenError('bad-response', '生图接口既没给 b64_json 也没给 url');
}

/**
 * 拉「可用模型」，给面板的「获取可用模型」用。
 * 生图服务的 /models 通常是一堆 chat 模型混着 image 模型，按名字粗筛一遍。
 */
export async function listImageModels({ baseUrl, apiKey }) {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) throw new ImageGenError('no-baseurl', '先填接口地址');
  const key = String(apiKey ?? '').trim();
  if (!key) throw new ImageGenError('no-key', '先填 API Key');
  let res;
  try {
    res = await fetch(`${base}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    throw new ImageGenError('network', `连不上接口：${error?.message ?? error}`);
  }
  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch { /* 下面报错 */ }
  if (!res.ok) throw new ImageGenError('http', `返回 ${res.status}：${raw.slice(0, 160)}`);
  const list = Array.isArray(data) ? data : (data?.data ?? data?.models ?? []);
  const ids = list.map((m) => String(m?.id ?? m?.name ?? '')).filter(Boolean);
  // 粗筛：名字里带这些词的算生图模型；一个都没有就全给你挑
  const IMAGE_HINTS = /(image|dall|flux|kolors|sdxl|stable-?diffusion|wanx|seedream|imagen|gpt-image|midjourney|mj)/i;
  const imageish = ids.filter((id) => IMAGE_HINTS.test(id));
  return { models: imageish.length ? imageish.sort() : ids.sort(), filtered: imageish.length > 0, total: ids.length };
}
