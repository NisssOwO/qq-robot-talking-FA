// QQ 空间说说用的「地点池」：从 resources/qzone-places.json 里按天气、季节、时段挑候选。
// 设计要点（照 eidolon-sc 的做法，落成我们这边的约束）：
//  - 下雨下雪打雷只给室内类（室内归类写死在 CATEGORIES 里，不信数据文件）
//  - 季节名所只在对应季节出现
//  - 30 天内去过的地点硬性排除（由调用方传入 recentIds）
//  - 同类最多给 2 个，避免「四个咖啡馆」
//  - 读不到数据 / 数据写错 → 只关掉地点功能，不阻塞 bridge 启动
// 纯函数，无 I/O、无第三方依赖；文件读取交给调用方或 loadPlacePoolFile。

export const PLACE_CATEGORIES = [
  { id: 'cafe', label: '咖啡馆・甜品・餐厅', indoor: true },
  { id: 'park', label: '公园・河边', indoor: false },
  { id: 'shrine', label: '神社・寺院', indoor: false },
  { id: 'books', label: '书店・图书馆', indoor: true },
  { id: 'mall', label: '商场・车站大楼', indoor: true },
  { id: 'museum', label: '美术馆・博物馆', indoor: true },
  { id: 'seaside', label: '海边・湾岸', indoor: false },
  { id: 'bath', label: '温泉・钱汤', indoor: true },
  { id: 'night-view', label: '展望台・夜景', indoor: false },
  { id: 'shopping-street', label: '商店街', indoor: false },
  { id: 'fashion-street', label: '杂货・服装街区', indoor: false },
  { id: 'seasonal', label: '季节名所', indoor: false },
  { id: 'amusement', label: '水族馆・动物园・游乐园', indoor: false },
  { id: 'venue', label: '演出场馆', indoor: true },
];

export const CATEGORY_IDS = PLACE_CATEGORIES.map((c) => c.id);
export const INDOOR_CATEGORY_IDS = PLACE_CATEGORIES.filter((c) => c.indoor).map((c) => c.id);

// 雨雪雷一律只去室内，其余天气室内室外都行
export const WET_WEATHER_KINDS = ['雨', '雪', '雷'];
export const NONE_PLACE_LABEL = '哪儿都没去';
export const PLACE_MAX_PER_CATEGORY = 2;

const SEASONS = ['spring', 'summer', 'autumn', 'winter'];
const SLOTS = ['morning', 'afternoon', 'evening', 'night'];

const CATEGORY_MAP = new Map(PLACE_CATEGORIES.map((c) => [c.id, c]));

export function categoryOf(id) {
  return CATEGORY_MAP.get(String(id ?? '')) ?? null;
}

export function categoryLabel(id) {
  return CATEGORY_MAP.get(String(id ?? ''))?.label ?? '别的地方';
}

export function isIndoorCategory(id) {
  return CATEGORY_MAP.get(String(id ?? ''))?.indoor === true;
}

// 月份（1–12）→ 季节。北半球、东京，跟 places.toml 的注释一致。
export function seasonOf(month) {
  const m = Number(month);
  if (!Number.isFinite(m)) return 'spring';
  if (m >= 3 && m <= 5) return 'spring';
  if (m >= 6 && m <= 8) return 'summer';
  if (m >= 9 && m <= 11) return 'autumn';
  return 'winter';
}

// 地点自己的营业时段用三个值（跟 places.toml 的 slots 一致）：morning 5–10、afternoon 11–16、evening 17–23；凌晨算 night。
export function slotOfHour(hour) {
  const h = Number(hour);
  if (!Number.isFinite(h)) return 'afternoon';
  const x = ((Math.floor(h) % 24) + 24) % 24;
  if (x < 5) return 'night';
  if (x <= 10) return 'morning';
  if (x <= 16) return 'afternoon';
  return 'evening';
}

function normalizePlace(raw, index) {
  const errors = [];
  const where = `places[${index}]`;
  const id = String(raw?.id ?? '').trim();
  if (!id) errors.push(`${where}.id 为空`);
  const name = String(raw?.name ?? '').trim();
  if (!name) errors.push(`${where}.name 为空`);
  const category = String(raw?.category ?? '').trim();
  if (!categoryOf(category)) errors.push(`${where}.category 不认识：${category}`);
  const lat = Number(raw?.lat);
  const lon = Number(raw?.lon);
  if (!Number.isFinite(lat) || lat < 20 || lat > 47) errors.push(`${where}.lat 不合理：${raw?.lat}`);
  if (!Number.isFinite(lon) || lon < 122 || lon > 154) errors.push(`${where}.lon 不合理：${raw?.lon}`);
  const seasons = Array.isArray(raw?.seasons)
    ? raw.seasons.map((s) => String(s)).filter((s) => SEASONS.includes(s))
    : [];
  const slots = Array.isArray(raw?.slots)
    ? raw.slots.map((s) => String(s)).filter((s) => SLOTS.includes(s))
    : [];
  return {
    errors,
    place: {
      id,
      name,
      area: String(raw?.area ?? '').trim(),
      category,
      label: categoryLabel(category),
      indoor: isIndoorCategory(category),
      note: String(raw?.note ?? '').trim(),
      lat,
      lon,
      seasons,
      slots,
      source: String(raw?.source ?? '').trim(),
    },
  };
}

// 校验整份数据。返回 { ok, city, places, errors }；ok 为 false 时调用方应只关掉地点功能。
export function loadPlacePool(raw) {
  const errors = [];
  const data = raw && typeof raw === 'object' ? raw : {};
  if (Number(data.version) !== 1) errors.push(`version 应为 1，实际 ${data.version}`);
  const city = data.cities?.tokyo ?? null;
  if (!city) errors.push('缺少 cities.tokyo');
  if (city) {
    if (!Number.isFinite(Number(city.latitude))) errors.push('cities.tokyo.latitude 不是数字');
    if (!Number.isFinite(Number(city.longitude))) errors.push('cities.tokyo.longitude 不是数字');
    if (!String(city.timezone ?? '').includes('/')) errors.push('cities.tokyo.timezone 形如 Asia/Tokyo');
  }
  const list = Array.isArray(data.places) ? data.places : [];
  if (!list.length) errors.push('places 为空');
  const places = [];
  const seen = new Set();
  for (let i = 0; i < list.length; i += 1) {
    const one = normalizePlace(list[i], i);
    errors.push(...one.errors);
    if (seen.has(one.place.id)) errors.push(`地点 id 重复：${one.place.id}`);
    seen.add(one.place.id);
    if (!one.errors.length) places.push(one.place);
  }
  return {
    ok: errors.length === 0,
    city,
    places,
    errors,
  };
}

function shuffle(list, random) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const t = out[i];
    out[i] = out[j];
    out[j] = t;
  }
  return out;
}

// 挑候选地点。
// opts: { places, weatherKind, month, slot, recentIds, limit=4, random, allowVenue=false }
export function pickPlaces(opts = {}) {
  const places = Array.isArray(opts.places) ? opts.places : [];
  const limit = Math.max(1, Math.min(6, Number(opts.limit) || 4));
  const random = typeof opts.random === 'function' ? opts.random : Math.random;
  const weatherKind = String(opts.weatherKind ?? '');
  const wet = WET_WEATHER_KINDS.includes(weatherKind);
  const season = seasonOf(opts.month);
  const slot = String(opts.slot ?? '');
  const recent = new Set((Array.isArray(opts.recentIds) ? opts.recentIds : []).map((x) => String(x)));
  const allowVenue = opts.allowVenue === true;

  const filtered = places.filter((p) => {
    if (recent.has(p.id)) return false;
    if (!allowVenue && p.category === 'venue') return false;
    if (wet && !p.indoor) return false;
    if (p.seasons.length && !p.seasons.includes(season)) return false;
    if (p.slots.length && slot && !p.slots.includes(slot)) return false;
    return true;
  });

  // 先打散，再按「同类最多 2 个」抽，保证类别分散
  const picked = [];
  const perCategory = new Map();
  for (const p of shuffle(filtered, random)) {
    if (picked.length >= limit) break;
    const used = perCategory.get(p.category) ?? 0;
    if (used >= PLACE_MAX_PER_CATEGORY) continue;
    perCategory.set(p.category, used + 1);
    picked.push(p);
  }
  return picked;
}

// 拼进提示词的候选块。空数组也给「哪儿都没去」，让模型有个明确选项。
export function buildPlaceBlock(candidates) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  if (!list.length) return `- none｜${NONE_PLACE_LABEL}`;
  const lines = list.map((p, i) => {
    const area = p.area ? `・${p.area}` : '';
    const note = p.note ? `｜${p.note}` : '';
    return `${i + 1}. ${p.name}（${p.label}${area}）${note}`;
  });
  lines.push(`0. none｜${NONE_PLACE_LABEL}`);
  return lines.join('\n');
}

// 把正文倒数第一行（落款行）解析出来，跟候选列表比对。
// 返回 { found, line, place, name }：found 只表示「写了落款」，name 可能对不上候选。
export function verifyPlace(content, candidates) {
  const text = String(content ?? '');
  const lines = text
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  const last = lines.length ? lines[lines.length - 1] : '';
  const mark = last.indexOf('📍');
  if (mark < 0) return { found: false, line: '', place: null, name: '' };
  // 📍 是代理对，长度按字符算，否则会切掉半个字符
  const rest = last.slice(mark + '📍'.length).trim();
  const name = (rest.split(/[\s　]+/)[0] ?? '').replace(/[。、,.!！?？]+$/, '').trim();
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  const place = list.find((p) => p.name === name) ?? null;
  return { found: true, line: last, place, name };
}

// 给面板/日志用的一句话
export function describePlace(place) {
  if (!place) return '没写地点';
  return `${place.name}（${place.label}${place.area ? `・${place.area}` : ''}）`;
}