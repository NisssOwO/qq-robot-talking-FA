// QQ 空间「发说说」的提示词模板。
//
// 以前这段文案是写死在 bridge.js 的 buildWakePromptV2 里的：想改一句「口吻像在手机备忘录里
// 随手记一笔」，得改代码再重新打包。这里把它抽成一份**带占位符的模板**，面板可以改、可以存，
// 存进 config.json 的 `socialV2.qzone.prompt`；留空就回落默认（也就是下面这段）。
//
// 1.1.x 的教训：老的默认模板第一句是「原因：到点了，你想在自己的 QQ 空间发一条说说」——
// 提示词亲口承认「没有原因」，模型就只能在人设的平均态里采样，写出来的东西放到哪一天都成立。
// 现在的写法是：**先给一条今天真实发生过的由头（{hook}）、一个钟点（{clock}）、一句真实天气
// （{weatherLine}）、一处地点（{placeBlock}）**，模型只负责「把这件事说成她自己的口吻」。
// 拿不到由头就不发（在 bridge 里判断），所以模板本身不写「可以随便写点什么」。
//
// 纯函数、零依赖，方便单测。占位符只有下面这几个，认不出来的 `{xxx}` 原样保留，
// 方便使用者自己在模板里写注释（不会因为写了个 `{注意}` 就把整段吞掉）。

export const QZONE_PROMPT_MAX = 8000;

/** 模板里认的占位符：key 是占位符名字（不含花括号），desc 给面板做提示。 */
export const QZONE_PLACEHOLDERS = Object.freeze([
  { key: 'key', desc: '会话 key（一般不用管）' },
  { key: 'hook', desc: '这条说说的由头（今天群里真实提过的小事 / 日记里记过的事）' },
  { key: 'clock', desc: '现在的钟点，如「晚上 19:42」' },
  { key: 'slot', desc: '此刻的大致时段，如「傍晚」' },
  { key: 'weatherLine', desc: '此刻的天气，如「外面晴，18℃。」；没有数据时为空串' },
  { key: 'weatherRule', desc: '天气相关的写法规则（有数据/没数据自动切换）' },
  { key: 'placeBlock', desc: '可选地点（几个候选 + 「哪儿都没去」）；地点功能关掉时为空串' },
  { key: 'recentBlock', desc: '最近已发过的三条 + 「别再写」提醒；没历史时为空串' },
  { key: 'modeNote', desc: '这次偏重什么（日常 / 接群里的茬）' },
  { key: 'imageMode', desc: '配图模式：none / sticker / ai / random' },
  { key: 'imageHint', desc: '配图那句话（配图时会带上模式说明）' }
]);

/**
 * 默认模板。
 * 改这里请同步 work/test-qzone-prompt.mjs（那里校验结构、占位符与落款规则），
 * 否则模板被悄悄改坏也没人发现。
 */
export const DEFAULT_QZONE_PROMPT = `【发一条空间说说】{key}
【这条为什么发】
{hook}
【现在】
{clock}。{weatherLine}
【在哪】
{placeBlock}
【写什么】
{recentBlock}
- 用「日语原文 + 中文字幕」两段式：先写日语（三十到八十字），换行再写这一段的中文。
- 两段都是正文，不要加「日语」「中文」这类标签，不要括号，不要用 markdown。
- 口吻像在手机备忘录里随手记一笔。
- 时间感要对得上（{slot}）：早上是赶、中午是饿、傍晚是松下来、晚上是安静。但正文里不要出现「{slot}」这类词。
- 只写【这条为什么发】里那件事：挑其中一个具体的细节写（东西、数字、地点、动作里的至少一个），不要把它扩写成一段抒情，也不要另起一件事。
- 正文不出现「你」「大家」这类称呼，也不对任何人说话——这不是回消息，是自言自语。
- 这次偏向：{modeNote}
- **结尾不许感慨**：不要用「真好」「治愈」「感慨」「真好呢」这类词收尾，也不要总结一句道理。说完那件事就停。
- **不许**出现：问候语（早安/晚安/在吗）、"今天也要加油"这类打气话、AI 自我指涉、"作为一个…"、任何括号旁白。
- **不许**提群友、提 QQ、提"刚才有人跟我说"，也不要复述别人的原话。
- {weatherRule}
- 不要编世界观里没写的剧情，不要写别的偶像做了什么。

【落款】
正文写完后另起一行，只写落款：📍地名　☀ 18℃（用【在哪】里给你的那个地名，图标和气温用【现在】给的）。
没有天气数据就只写 📍地名；【在哪】里挑的是「哪儿都没去」就写 📍哪儿都没去。
地名只出现在这一行，正文里不要再重复。

【怎么发】
配图模式：{imageMode}。
调用 qq_post_qzone：第一个参数 content 是正文；第二个参数 imagePrompt 是一句英文画面描述{imageHint}。
发完就安静收尾（qq_mark_read 或 qq_set_wake_config），不要在群里额外说一句"我刚发了说说"。`;

/**
 * 归一化用户填的模板：非字符串→空串；去首尾空白；超长截断。
 * 空串是合法值，表示「用默认」。
 */
export function normalizeTemplate(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.length > QZONE_PROMPT_MAX ? trimmed.slice(0, QZONE_PROMPT_MAX) : trimmed;
}

/** 有效模板：用户填了就用用户的，没填或全空白就用默认。 */
export function effectiveTemplate(value) {
  return normalizeTemplate(value) || DEFAULT_QZONE_PROMPT;
}

/**
 * 渲染模板。vars 里缺的占位符渲染成空串；未知占位符原样保留。
 * 只替换一次一轮（用 split/join，避免正则里 $& 之类的坑）。
 */
export function renderQzonePrompt(template, vars = {}) {
  const text = effectiveTemplate(template);
  let out = text;
  for (const { key } of QZONE_PLACEHOLDERS) {
    const value = vars?.[key];
    out = out.split(`{${key}}`).join(value == null ? '' : String(value));
  }
  return out;
}

/** 模板是否等于默认（面板上用来显示「未改动 / 已自定义」）。 */
export function isDefaultTemplate(value) {
  return !normalizeTemplate(value);
}

/** 给面板的一段占位符说明。 */
export function placeholdersHint() {
  return QZONE_PLACEHOLDERS.map((p) => `{${p.key}}：${p.desc}`).join('\n');
}