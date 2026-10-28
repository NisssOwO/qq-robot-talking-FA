// 模型请求的脱敏诊断：只记结构和统计，不记内容。
// 用它是为了在服务商拦请求（比如百炼的 data_inspection_failed）时，
// 能回答「这次到底发出去多大一坨」，而不是只有一句 400。

/**
 * 统计一次请求的形状。
 * @param {Array<any>} messages OpenAI 格式的消息数组
 * @param {Array<any>} toolDefs 工具定义
 * @param {object} [context] 无副作用，仅为调用方对齐形参
 */
export function requestMetadata(messages = [], toolDefs = [], context = {}) {
  const list = Array.isArray(messages) ? messages : [];
  let chars = 0;
  let images = 0;
  const roles = {};
  for (const m of list) {
    const role = String(m?.role || 'unknown');
    roles[role] = (roles[role] || 0) + 1;
    const c = m?.content;
    if (typeof c === 'string') {
      chars += c.length;
    } else if (Array.isArray(c)) {
      for (const b of c) {
        if (b?.type === 'text') chars += String(b.text || '').length;
        if (b?.type === 'image_url') images += 1;
      }
    }
    if (Array.isArray(m?.tool_calls)) {
      for (const t of m.tool_calls) chars += String(t?.function?.arguments || '').length;
    }
  }
  const tools = Array.isArray(toolDefs) ? toolDefs : [];
  return {
    messages: list.length,
    chars,
    images,
    roles,
    tools: tools.length,
    toolsChars: tools.reduce((n, t) => n + JSON.stringify(t || {}).length, 0)
  };
}

/**
 * 把「接口返回非 2xx」包成一个带上下文的 Error，方便上层判断类型。
 */
export function modelFailure(status, textBody, requestId) {
  const body = typeof textBody === 'string' ? textBody : '';
  const error = new Error(`模型接口 ${status}：${body.slice(0, 400) || '(空响应)'}`);
  error.status = status;
  error.requestId = requestId || '';
  error.apiCode = (() => {
    try {
      return String(JSON.parse(body)?.error?.code || '');
    } catch {
      return '';
    }
  })();
  return error;
}

/**
 * 脱敏后的失败快照：只留能定位问题的字段，不带正文。
 */
export function safeFailure(error) {
  if (!error) return { code: '', message: '', status: null, requestId: '', apiCode: '' };
  return {
    code: String(error.code || error.name || ''),
    message: String(error.message || '').slice(0, 300),
    status: error.status ?? null,
    requestId: String(error.requestId || ''),
    apiCode: String(error.apiCode || '')
  };
}
