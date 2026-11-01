// 「思考程度」开关：把用户选的一档翻成 OpenAI 兼容接口认识的参数。
//
// 2026-10-29 对阿里云 MaaS 兼容模式（model deepseek-v4.1-flash-1017）实测：
//   不带参数          → reasoning = 400（默认就在想，且会吃掉 max_tokens）
//   reasoning_effort: 'none'    → reasoning = 0，0.7 秒答完
//   reasoning_effort: 'minimal' → reasoning = 338
//   reasoning_effort: 'low'     → reasoning = 204
//   reasoning_effort: 'medium' / 'high' → 想得更多（400 封顶时答案会被截断）
//   非法值（如 'off'）          → 400 invalid_parameter_error，合法枚举是 none/minimal/low/medium/high/…
// 所以只发 reasoning_effort 这一个参数，不叠加 thinking:{type} —— 后者虽然也认，
// 但不同厂商拼法不一样，留出 extraBody 让用户自己补。
export const THINKING_LEVELS = ['auto', 'none', 'minimal', 'low', 'medium', 'high'];

export const THINKING_LABEL = {
  auto: '跟随接口默认',
  none: '不思考（最快）',
  minimal: '极浅',
  low: '浅',
  medium: '中',
  high: '深（最慢，想最多）'
};

export const THINKING_HINT = {
  auto: '不传任何参数，由接口自己决定。多数推理模型会想很多，回复偏慢。',
  none: '显式关掉思考：最快、最省 token，适合闲聊。',
  minimal: '极浅思考：比 none 稍微多想一点。',
  low: '浅思考：速度和质量的折中，日常聊天够用。',
  medium: '中等思考：适合需要动脑的问题。',
  high: '深度思考：最慢，token 消耗最多；max_tokens 要留够，否则答案会被思考吃掉。'
};

const ALIASES = new Map([
  ['', 'auto'], ['default', 'auto'], ['on', 'low'], ['true', 'low'], ['yes', 'low'],
  ['off', 'none'], ['false', 'none'], ['no', 'none'], ['disabled', 'none'], ['disable', 'none'],
  ['0', 'none'], ['1', 'low'], ['shallow', 'low'], ['deep', 'high'], ['xhigh', 'high'], ['max', 'high']
]);

/** 把配置里任何写法归一成 THINKING_LEVELS 之一（不认识的一律 auto）。 */
export function normalizeThinking(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (THINKING_LEVELS.includes(raw)) return raw;
  if (ALIASES.has(raw)) return ALIASES.get(raw);
  return 'auto';
}

/** 只有需要时才发参数：auto 不传任何东西，保持与旧版本完全一致。 */
export function thinkingParams(level) {
  const lv = normalizeThinking(level);
  if (lv === 'auto') return {};
  return { reasoning_effort: lv };
}

/** 兼容 extraBody：对象或 JSON 字符串，用来兜底喂各家自己的私有字段。 */
export function readExtraBody(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** 请求体里要拼的那几个键（extraBody 优先，方便用户覆盖）。 */
export function llmThinkingBody(llm) {
  return { ...thinkingParams(llm?.thinking), ...readExtraBody(llm?.extraBody) };
}

/** 日志/面板里显示用。 */
export function describeThinking(value) {
  const lv = normalizeThinking(value);
  return `${lv}（${THINKING_LABEL[lv]}）`;
}