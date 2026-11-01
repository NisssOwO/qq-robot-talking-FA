// QQ 空间说说用的「此刻」：钟点 + 天气。
//
// 为什么要有：现在的提示词只告诉模型「大概是傍晚」，没有钟点、没有天气，也没有地点，
// 于是它只能写「天色暗下来」这种放到任何一天都成立的话。
// Open-Meteo 免费、免 key，取一次当前小时的气温与天气码，就能给正文一个**落地锚**。
//
// 取不到就不显示、也不给模型（提示词里对应规则自动切换成「不要提天气」）——宁可少一个
// 细节，也不要让模型编一个气温。

/** 7 档：晴 / 多云 / 阴 / 雾 / 雨 / 雪 / 雷。来自 WMO 4677 天气码（Open-Meteo 用的就是这套）。 */
export const WEATHER_KINDS = Object.freeze(['晴', '多云', '阴', '雾', '雨', '雪', '雷']);

export const WEATHER_ICONS = Object.freeze({
  晴: '☀',
  多云: '⛅',
  阴: '☁',
  雾: '🌫',
  雨: '🌧',
  雪: '❄',
  雷: '⛈'
});

/** WMO 天气码 → 7 档。认不出来的码按「阴」处理（比按「晴」保守）。 */
export function wmoToKind(code) {
  const c = Number(code);
  if (!Number.isFinite(c)) return '阴';
  if (c === 0 || c === 1) return '晴';
  if (c === 2) return '多云';
  if (c === 3) return '阴';
  if (c === 45 || c === 48) return '雾';
  if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) return '雨';
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return '雪';
  if (c >= 95 && c <= 99) return '雷';
  return '阴';
}

export const DEFAULT_WEATHER_CONF = Object.freeze({
  enabled: true,
  latitude: 35.68,
  longitude: 139.76,
  timezone: 'Asia/Tokyo'
});

/** 拼 Open-Meteo 的当前天气 URL（timezone 带斜杠，必须编码）。 */
export function buildWeatherUrl({ latitude, longitude, timezone }) {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: 'temperature_2m,weather_code',
    timezone: String(timezone)
  });
  return `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
}

/**
 * 取一次当前天气。失败抛错（由调用方决定冷却与降级）。
 * @returns {Promise<{kind:string, icon:string, tempC:number, text:string, at:number}>}
 */
export async function weatherAt({
  latitude = DEFAULT_WEATHER_CONF.latitude,
  longitude = DEFAULT_WEATHER_CONF.longitude,
  timezone = DEFAULT_WEATHER_CONF.timezone,
  timeoutMs = 5000,
  fetchImpl = globalThis.fetch,
  now = Date.now()
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch 不可用');
  const url = buildWeatherUrl({ latitude, longitude, timezone });
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res || !res.ok) throw new Error(`HTTP ${res?.status ?? '???'}`);
  const data = await res.json();
  const current = data?.current ?? {};
  const tempRaw = Number(current.temperature_2m);
  if (!Number.isFinite(tempRaw)) throw new Error('响应里没有 temperature_2m');
  const kind = wmoToKind(current.weather_code);
  const tempC = Math.round(tempRaw);
  return {
    kind,
    icon: WEATHER_ICONS[kind] ?? '',
    tempC,
    text: `外面${kind}，${tempC}℃`,
    at: now
  };
}

/**
 * 带缓存与失败冷却的取天气客户端。
 * - 成功缓存 30 分钟（同一个小时里不必反复请求）；
 * - 失败后 10 分钟内不再请求（断网时别把每一次唤醒都拖慢 5 秒）；
 * - 返回 null 表示「这次没有天气」，调用方据此切到「不要提天气」。
 */
export function createWeatherClient({
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  cacheMs = 30 * 60000,
  failCooldownMs = 10 * 60000,
  timeoutMs = 5000,
  log = () => {}
} = {}) {
  let cached = null; // { at, value }
  let failedAt = 0;
  return {
    get(conf = {}) {
      const c = { ...DEFAULT_WEATHER_CONF, ...(conf ?? {}) };
      if (c.enabled === false) return Promise.resolve(null);
      const t = now();
      if (cached && t - cached.at < cacheMs) return Promise.resolve(cached.value);
      if (failedAt && t - failedAt < failCooldownMs) return Promise.resolve(null);
      return weatherAt({ ...c, timeoutMs, fetchImpl, now: t })
        .then((value) => {
          cached = { at: t, value };
          failedAt = 0;
          return value;
        })
        .catch((error) => {
          failedAt = t;
          log(`[qzone] 取天气失败：${error?.message ?? error}`);
          return null;
        });
    },
    /** 清掉缓存（面板改了城市坐标时要立刻生效）。 */
    reset() {
      cached = null;
      failedAt = 0;
    }
  };
}

/** 提示词里【现在】那一行的天气部分；没有天气就是空串。 */
export function weatherLine(weather) {
  return weather?.text ? `${weather.text}。` : '';
}

/**
 * 提示词里的天气规则：有数据 → 允许顺带提一句冷暖；没有 → 明确禁止提天气。
 * 返回的句子直接拼在正文规则那一行的末尾。
 */
export function weatherRule(weather) {
  return weather?.kind
    ? '如果这件事发生在外面，可以顺带提一句天色或冷暖；不要单独写天气。'
    : '今天没有天气数据：正文不要提天气，也不要提「冷」「热」这类体感。';
}

const PERIODS = [
  { from: 0, to: 5, label: '凌晨' },
  { from: 5, to: 11, label: '早上' },
  { from: 11, to: 14, label: '中午' },
  { from: 14, to: 17, label: '下午' },
  { from: 17, to: 19, label: '傍晚' },
  { from: 19, to: 24, label: '晚上' }
];

/** 时段名（给 slot 用）。 */
export function periodOf(ts = Date.now(), timeZone = 'Asia/Shanghai') {
  const hour = hourInZone(ts, timeZone);
  const hit = PERIODS.find((p) => hour >= p.from && hour < p.to);
  return hit?.label ?? '这会儿';
}

function partsInZone(ts, timeZone) {
  try {
    const dtf = new Intl.DateTimeFormat('sv-SE', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    const parts = dtf.formatToParts(new Date(Number(ts)));
    const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
    return { year: get('year'), month: get('month'), day: get('day'), hour: Number(get('hour')), minute: get('minute') };
  } catch {
    const d = new Date(Number(ts));
    return {
      year: String(d.getUTCFullYear()),
      month: String(d.getUTCMonth() + 1).padStart(2, '0'),
      day: String(d.getUTCDate()).padStart(2, '0'),
      hour: d.getUTCHours(),
      minute: String(d.getUTCMinutes()).padStart(2, '0')
    };
  }
}

export function hourInZone(ts = Date.now(), timeZone = 'Asia/Shanghai') {
  return partsInZone(ts, timeZone).hour;
}

/** 本地日 key（YYYY-MM-DD），用于「今天 00:00」这类边界。 */
export function dayKeyInZone(ts = Date.now(), timeZone = 'Asia/Shanghai') {
  const p = partsInZone(ts, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** 本地月份（1–12），给季节名所筛选用。 */
export function monthInZone(ts = Date.now(), timeZone = 'Asia/Shanghai') {
  return Number(partsInZone(ts, timeZone).month) || 1;
}

/** 本地「今天 00:00」的时间戳（按指定时区）。 */
export function startOfDay(ts = Date.now(), timeZone = 'Asia/Shanghai') {
  const hour = hourInZone(ts, timeZone);
  const p = partsInZone(ts, timeZone);
  const minutes = Number(p.minute) || 0;
  // 从「现在」倒推回今天 00:00；用整点回退，避免夏令时造成的 15/30 分钟偏差。
  return Number(ts) - hour * 3600000 - minutes * 60000 - (Number(ts) % 60000);
}

/** 钟点文案：`晚上 19:42`。 */
export function clockText(ts = Date.now(), timeZone = 'Asia/Shanghai') {
  const p = partsInZone(ts, timeZone);
  const hh = String(p.hour).padStart(2, '0');
  const mm = String(p.minute).padStart(2, '0');
  return `${periodOf(ts, timeZone)} ${hh}:${mm}`;
}

/** 落款行：`📍神保町の古書店街　☀ 18℃`（缺哪一半就少哪一半）。 */
export function signatureLine({ place = '', weather = null, format = '📍{place}　{icon} {temp}℃' } = {}) {
  const name = String(place ?? '').trim();
  const temp = Number(weather?.tempC);
  const hasWeather = Number.isFinite(temp);
  if (!name && !hasWeather) return '';
  const icon = weather?.icon ?? WEATHER_ICONS[weather?.kind] ?? '';
  if (!hasWeather) return `📍${name}`;
  if (!name) return `${icon} ${temp}℃`.trim();
  return String(format)
    .replace('{place}', name)
    .replace('{icon}', icon)
    .replace('{temp}', String(temp));
}