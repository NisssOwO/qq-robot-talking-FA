// QQ 空间说说「由头」收集。
//
// 现状：到点了就唤醒模型，让它「发一条说说」。模型手里没有人、没有事件，只能从人设的
// 平均态采样，于是每条都像凭空生成——也就是「原因不明」。
//
// 这里把「今天确实发生过的一件具体小事」先挑出来，再交给模型去写。由头是**数据**，
// 不是指令：`{hook}` 里放的是真句子，模型只负责「怎么说」。
//
// 纯函数、零依赖（不读盘、不联网），方便单测——接线在 bridge.js 的 qzoneCheck 分支。

/** 太短的句子没有信息量（「嗯」「好耶」）；太长的大多是复述或长篇，不适合当由头。 */
export const HOOK_MIN_LEN = 8;
export const HOOK_MAX_LEN = 80;
/** 打分阈值：2 分意味着「至少有一个具体的东西」，或者「一个动作 + 一个数字」。 */
export const HOOK_MIN_SCORE = 2;
/** 一次最多给模型几条候选：太多会写散，太少没有挑选余地。 */
export const HOOK_LIMIT = 3;

// ── 词表 ────────────────────────────────────────────────────────────────
// 只用来判分，不参与生成。宁可漏判（少一条候选），也不要误判成「具体」。
const PLACE_WORDS = [
  '便利店', '超市', '车站', '地铁', '公交', '电车', '巴士', '食堂', '咖啡店', '咖啡馆', '咖啡',
  '排练室', '录音棚', '摄影棚', '事务所', '教室', '学校', '天台', '公园', '河边', '海边', '桥',
  '路口', '街角', '书店', '图书馆', '电影院', '医院', '邮局', '银行', '商场', '宿舍', '家里',
  '办公室', '楼上', '楼下', '走廊', '电梯', '便利店门口', '神社', '澡堂', '澡堂子', '拉面店'
];

const THING_WORDS = [
  '空调', '暖气', '猫', '狗', '伞', '雨', '雪', '风', '帽子', '外套', '围巾', '手套', '耳机',
  '手机', '相机', '书', '本子', '笔', '杯子', '保温杯', '咖啡', '奶茶', '汽水', '拉面', '面',
  '饭', '面包', '蛋糕', '巧克力', '关东煮', '便当', '苹果', '橘子', '花', '金木犀', '樱花',
  '树', '叶子', '灯', '车', '车窗', '桌子', '椅子', '镜子', '药', '快递', '票', '时间表',
  '海报', '照片', '纸条', '口袋', '钥匙', '充电器', '袜子', '鞋', '裙摆', '袖口', '指甲'
];

const ACTION_WORDS = [
  '买', '吃', '喝', '走', '跑', '坐', '睡', '起', '拿', '放', '掉', '摔', '找', '等', '排队',
  '洗', '擦', '换', '修', '借', '送', '收', '打开', '关上', '拍', '练', '唱', '跳', '写',
  '看', '听', '闻', '尝', '试', '忘', '迟到', '加班', '回家', '出门', '上楼', '下楼', '坏',
  '坏掉', '漏', '洒', '断', '停电', '堵', '挤', '响', '停', '关'
];

const EMOTION_WORDS = [
  '开心', '高兴', '难过', '累', '烦', '舒服', '幸福', '寂寞', '孤独', '焦虑', '紧张', '感动',
  '治愈', '心情', '情绪', '感觉', '舍不得', '安心', '踏实', '委屈', '无力', '疲惫'
];

/** 寒暄/应答：这类消息就算出现在群里，也当不了「由头」。 */
const GREETING_WORDS = [
  '早安', '早上好', '晚安', '午安', '晚上好', '在吗', '大家', '大家好', '哈哈', '哈哈哈', '233',
  '草', '笑死', '好耶', '好的', '收到', '可以', '谢谢', '辛苦了', '牛逼', '绝了', '确实', '对吧',
  '嗯嗯', '哦哦', '啊啊', '嘿嘿', '嘿嘿嘿'
];

const NOISE_RE = /^[\s\p{P}\p{S}\p{Emoji_Presentation}]+$/u;
const LINK_RE = /https?:\/\//i;
// 中文数字要带量词才算「数字」：光有「一点」「一会儿」不是具体信息。
const NUMBER_RE = /[0-9０-９]+|[一二两三四五六七八九十百千万]{1,4}[个条只杯碗份张本块元米分秒日号点度岁次班趟年天晚人件句遍层站]/;
// 「一点点」「一会儿」这类模糊量词先抹掉，避免被当成数字加分。
const FUZZY_QUANT_RE = /一点点|一点|一下|一些|一会儿|有点儿|有点|好多|很多|有时候/g;

/** 长词优先匹配，匹配到就从文本里挖掉，避免「咖啡店」又算一次「咖啡」。 */
function matchWords(text, words) {
  const hits = [];
  let rest = text;
  const sorted = [...words].sort((a, b) => b.length - a.length);
  for (const word of sorted) {
    if (!rest.includes(word)) continue;
    hits.push(word);
    rest = rest.split(word).join('\u0000');
  }
  return hits;
}

function hasNumber(text) {
  return NUMBER_RE.test(String(text ?? '').replace(FUZZY_QUANT_RE, ''));
}

/** 语气助词：判断「整句是不是只有寒暄」时先抹掉它们，不然「早上好呀大家」会漏判。 */
const FILLER_RE = /[呀啊呢吧啦哦嘛嗯哈嘿唷哟哎唉嘞咯喔嘻]/g;

function isGreetingOnly(text) {
  let rest = String(text ?? '').replace(FILLER_RE, '');
  const sorted = [...GREETING_WORDS].sort((a, b) => b.length - a.length);
  for (const word of sorted) rest = rest.split(word).join('');
  return !rest.replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * 给一句候选打分。
 * 数字 +2、地点 +2、具体物品 +2、动作 +1（各类最多算两次）；
 * 纯情绪（没有任何具体东西）−2；整句都是寒暄 −3；超过 60 字 −1（长句多是复述）。
 */
export function scoreHook(text) {
  const plain = String(text ?? '').trim();
  const place = matchWords(plain, PLACE_WORDS);
  const thing = matchWords(plain, THING_WORDS);
  const action = matchWords(plain, ACTION_WORDS);
  const emotion = matchWords(plain, EMOTION_WORDS);
  const number = hasNumber(plain);
  let score = 0;
  score += 2 * Math.min(place.length, 2);
  score += 2 * Math.min(thing.length, 2);
  score += 1 * Math.min(action.length, 2);
  if (number) score += 2;
  const concrete = place.length || thing.length || action.length || number;
  if (emotion.length && !concrete) score -= 2;
  if (isGreetingOnly(plain)) score -= 3;
  if (plain.length > 60) score -= 1;
  return { score, hits: { place, thing, action, emotion }, hasNumber: number };
}

/** 去重签名：去掉空白与标点后取前 10 个字。 */
export function signatureOf(text) {
  return String(text ?? '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 10);
}

/** 是不是纯表情/纯标点（这类消息一律不当由头）。 */
export function isNoise(text) {
  const plain = String(text ?? '').trim();
  return !plain || NOISE_RE.test(plain);
}

function normalizePlain(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function byScoreThenTime(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  return (b.at ?? 0) - (a.at ?? 0);
}

/**
 * 从二代 recentMessages 里挑由头。
 *
 * @param {object} opts
 * @param {Array}  opts.messages   recentMessages 的扁平数组（可来自多个会话，元素形如
 *                                 { plain, text, time, isSelf, hasMedia, kind }）
 * @param {number} [opts.dayStart] 今天 00:00 的时间戳；早于它的消息直接丢弃
 * @param {number} [opts.minScore] 打分阈值
 * @param {number} [opts.limit]    最多返回几条
 * @param {Set<string>|string[]} [opts.excludeSignatures] 要避开的签名（和最近发过的重复）
 * @returns {Array<{ source:'chat', text:string, score:number, at:number, hits:object }>}
 */
export function collectChatHooks({
  messages = [],
  dayStart = 0,
  minScore = HOOK_MIN_SCORE,
  limit = HOOK_LIMIT,
  excludeSignatures = []
} = {}) {
  const excluded = excludeSignatures instanceof Set ? excludeSignatures : new Set(excludeSignatures ?? []);
  const seen = new Set();
  const out = [];
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg || msg.isSelf === true) continue;
    if (msg.hasMedia === true) continue;
    // poke/sticker/system 之类不是「话」，没有由头价值
    if (msg.kind && msg.kind !== 'message' && msg.kind !== 'text' && msg.kind !== 'speech') continue;
    const plain = normalizePlain(msg.plain ?? msg.text);
    if (plain.length < HOOK_MIN_LEN || plain.length > HOOK_MAX_LEN) continue;
    if (LINK_RE.test(plain)) continue;
    if (/^[@[]/.test(plain)) continue;
    if (isNoise(plain)) continue;
    const time = Number(msg.time) || 0;
    if (dayStart && time < dayStart) continue;
    const sig = signatureOf(plain);
    if (!sig || excluded.has(sig) || seen.has(sig)) continue;
    const { score, hits } = scoreHook(plain);
    if (score < minScore) continue;
    seen.add(sig);
    out.push({ source: 'chat', text: plain, score, at: time, hits });
  }
  out.sort(byScoreThenTime);
  return out.slice(0, Math.max(0, limit));
}

/**
 * 从记忆日记里挑由头。picked 的形状来自 memory-diary 的 pickInjectable()：
 * `[{ day, mode, text }]`，text 里是多行条目。
 *
 * @returns {Array<{ source:'diary', text:string, score:number, day:string, at:number, hits:object }>}
 */
export function collectDiaryHooks({ picked = [], minScore = HOOK_MIN_SCORE, limit = HOOK_LIMIT, excludeSignatures = [] } = {}) {
  const excluded = excludeSignatures instanceof Set ? excludeSignatures : new Set(excludeSignatures ?? []);
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(picked) ? picked : []) {
    if (!item) continue;
    const day = String(item.day ?? '');
    const at = Date.parse(`${day}T00:00:00`) || 0;
    for (const rawLine of String(item.text ?? '').split(/\r?\n/)) {
      const line = normalizePlain(rawLine.replace(/^[·\-*]\s*/, ''));
      if (line.length < HOOK_MIN_LEN || line.length > HOOK_MAX_LEN) continue;
      if (LINK_RE.test(line) || isNoise(line)) continue;
      const sig = signatureOf(line);
      if (!sig || excluded.has(sig) || seen.has(sig)) continue;
      const { score, hits } = scoreHook(line);
      if (score < minScore) continue;
      seen.add(sig);
      out.push({ source: 'diary', text: line, score, day, at, hits });
      break; // 一天只取最好的一条（条目本身按时间倒序，第一条命中的就是最新的）
    }
  }
  out.sort(byScoreThenTime);
  return out.slice(0, Math.max(0, limit));
}

/**
 * 合并两个来源：群聊优先（更新鲜、更像「今天」），日记补位。
 * 配额：群聊最多 2 条、日记最多 1 条，总数不超过 limit。
 */
export function collectHooks({
  chat = [],
  diary = [],
  sources = ['chat', 'diary'],
  limit = HOOK_LIMIT,
  excludeSignatures = []
} = {}) {
  const excluded = excludeSignatures instanceof Set ? excludeSignatures : new Set(excludeSignatures ?? []);
  const wantChat = sources.includes('chat');
  const wantDiary = sources.includes('diary');
  const picked = [];
  const seen = new Set([...excluded]);
  const push = (hook, max) => {
    if (!hook) return;
    const sig = signatureOf(hook.text);
    if (!sig || seen.has(sig)) return;
    if (picked.filter((h) => h.source === hook.source).length >= max) return;
    seen.add(sig);
    picked.push(hook);
  };
  if (wantChat) for (const hook of chat) push(hook, 2);
  if (wantDiary) for (const hook of diary) push(hook, 1);
  return picked.slice(0, Math.max(0, limit));
}

const SOURCE_LABEL = { chat: '群聊', diary: '日记' };

export function hookSourceLabel(source) {
  return SOURCE_LABEL[source] ?? String(source ?? '');
}

/** 面板/日志上的一行摘要：`群聊·便利店买了关东煮` */
export function hookSummary(hook) {
  if (!hook) return '';
  const text = String(hook.text ?? '').replace(/\s+/g, ' ').slice(0, 14);
  return `${hookSourceLabel(hook.source)}·${text}`;
}

/**
 * 拼成提示词里的【这条为什么发】一节。
 * 没有由头就返回空串——调用方据此决定「不发」。
 */
export function formatHookBlock(hooks, { maxLines = HOOK_LIMIT } = {}) {
  const list = Array.isArray(hooks) ? hooks.filter(Boolean).slice(0, maxLines) : [];
  if (!list.length) return '';
  const lines = list.map((hook, i) => `${i + 1}. ${String(hook.text ?? '').replace(/\s+/g, ' ').trim()}`).join('\n');
  const hasChat = list.some((h) => h.source === 'chat');
  const tail = hasChat
    ? '这些是今天群里真实提到过的事，可以当作你自己今天也遇到过的同类小事来写，不要说「有人跟我说」，也不要复述别人的原话。'
    : '这些是你自己前些天记下来的事，当成你自己的经历来写。';
  return `今天确实发生过的小事（挑一件写，不要都写）：\n${lines}\n${tail}`;
}