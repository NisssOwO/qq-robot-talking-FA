// 记忆日记：让 bot 在「上下文被换掉之前」给下一个失去记忆的自己写日记，
// 新会话开头再自动把这几天读回来。灵感来自 AstrBot 的 astrbot_plugin_memory_diary，
// 但按本项目（独立后端 + 二代仿真模式 + 自带 Web 面板）重写。
//
// 设计要点（跟原插件一致的地方）：
//   1. 按天归档：一天一个文件，当天写多篇就追加在同一天里，体积随时间可控；
//   2. 三种写法：完整（质量锚点，四段式）/ 简记（1~3 句）/ 随笔（没聊天时写 bot 自己的生活）；
//   3. 摘要块（preamble）永远在文件顶部，每篇都在重写它——新会话读它就能一眼知道"最近在干嘛"；
//   4. 素材游标：只把上次写日记之后的新消息当素材，不反复读同一段历史；
//   5. 上下文哨兵：估算占用，到提醒线提醒、到自动线自己写完整日记并叫人开新会话；
//   6. 完整篇吸收同日简记，被吸收的简记标「已吸收」，注入时跳过，不重复占 token。
//
// 这个文件不依赖 bridge.js，只碰文件系统和传入的 toLLM 回调，方便单测。

import fs from 'node:fs/promises';
import path from 'node:path';

export const MODES = /** @type {const} */ (['full', 'brief', 'life']);
export const MODE_LABEL = { full: '完整', brief: '简记', life: '随笔' };

export const DEFAULT_CFG = Object.freeze({
  enabled: true,          // 总开关
  inject: true,           // 新会话自动注入
  injectDays: 7,          // 注入最近几天
  injectMaxChars: 3000,   // 注入内容上限（跨所有注入文件）
  injectCooldownMinutes: 240, // 同一段上下文里，隔多久才再把日记塞一次
  scope: 'key',           // key=每个会话一本日记；global=全局一本
  fullPerDay: 2,          // 每天最多几篇完整日记
  briefMinMinutes: 30,    // 两篇简记最短间隔（分钟）
  firstMinMessages: 8,    // 第一次写完整日记前，至少攒够多少条新消息
  blobMaxChars: 6000,     // 当天未成篇的素材最多攒多少字
  tokenLimit: 60000,      // 哨兵：模型上下文上限（token）
  remindRatio: 0.75,      // 哨兵：提醒线
  autoRatio: 0.9,         // 哨兵：自动写完整日记的线
  daily: {
    enabled: true,
    time: '23:20',        // 每天几点写（HH:MM，日记时区）
    timezone: 'Asia/Shanghai',
    catchUpHours: 3       // 错过之后多久内还补写
  },
  memoMax: 20,
  extraInstruction: ''
});

function clamp(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function normBool(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return !['0', 'false', 'off', 'no', '否'].includes(v.trim().toLowerCase());
  return Boolean(v);
}

function normTime(v, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '').trim());
  if (!m) return fallback;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return fallback;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

/** 把 config.json 里可能残缺的 diary 段补成一份完整配置。 */
export function resolveCfg(raw, base = DEFAULT_CFG) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const daily = r.daily && typeof r.daily === 'object' ? r.daily : {};
  return {
    enabled: normBool(r.enabled, base.enabled),
    inject: normBool(r.inject, base.inject),
    injectDays: clamp(r.injectDays, 0, 90, base.injectDays),
    injectMaxChars: clamp(r.injectMaxChars, 500, 20000, base.injectMaxChars),
    injectCooldownMinutes: clamp(r.injectCooldownMinutes, 0, 10080, base.injectCooldownMinutes ?? 240),
    scope: r.scope === 'global' ? 'global' : 'key',
    fullPerDay: clamp(r.fullPerDay, 0, 10, base.fullPerDay),
    briefMinMinutes: clamp(r.briefMinMinutes, 5, 600, base.briefMinMinutes),
    firstMinMessages: clamp(r.firstMinMessages, 1, 200, base.firstMinMessages ?? 8),
    blobMaxChars: clamp(r.blobMaxChars, 800, 30000, base.blobMaxChars),
    tokenLimit: clamp(r.tokenLimit, 4000, 2000000, base.tokenLimit),
    remindRatio: clamp(r.remindRatio, 0.3, 0.99, base.remindRatio),
    autoRatio: clamp(r.autoRatio, 0.4, 0.995, base.autoRatio),
    daily: {
      enabled: normBool(daily.enabled, base.daily.enabled),
      time: normTime(daily.time, base.daily.time),
      timezone: String(daily.timezone || base.daily.timezone),
      catchUpHours: clamp(daily.catchUpHours, 0, 24, base.daily.catchUpHours)
    },
    memoMax: clamp(r.memoMax, 1, 100, base.memoMax),
    extraInstruction: typeof r.extraInstruction === 'string' ? r.extraInstruction.slice(0, 2000) : ''
  };
}

// ---------------------------------------------------------------------------
// 时间/文本小工具
// ---------------------------------------------------------------------------

/** 在指定时区下取 YYYY-MM-DD。timeZone 非法时回退本机时区。 */
export function dayKey(ts = Date.now(), timeZone = 'Asia/Shanghai') {
  const d = new Date(Number(ts));
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
    const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export function monthOf(day) {
  return String(day).slice(0, 7);
}

export function isoLocal(ts = Date.now(), timeZone = 'Asia/Shanghai') {
  const d = new Date(Number(ts));
  try {
    const fmt = new Intl.DateTimeFormat('sv-SE', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    return fmt.format(d).replace(' ', 'T');
  } catch {
    return d.toISOString().slice(0, 19);
  }
}

export function clockText(ts = Date.now(), timeZone = 'Asia/Shanghai') {
  const iso = isoLocal(ts, timeZone);
  return iso.slice(11, 16);
}

/** 粗略 token 估算：CJK 一字≈1 token，其余字符≈0.28 token。只用于哨兵，不需要准。 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  const cjk = (s.match(/[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/g) || []).length;
  const rest = s.length - cjk;
  return Math.ceil(cjk + rest * 0.28) + 4;
}

/** 会话 key（group:123 / private:456）→ 安全的目录名。 */
export function safeKey(key) {
  const s = String(key ?? '').trim();
  if (!s) return 'unknown';
  return s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
}

/** 会话 key 的中文描述，给面板/提示词用。 */
export function describeKey(key) {
  const s = String(key ?? '');
  if (s.startsWith('group:')) return `群 ${s.slice(6)}`;
  if (s.startsWith('private:')) return `私聊 ${s.slice(8)}`;
  return s || '未知会话';
}

// ---------------------------------------------------------------------------
// 日记文件：解析 / 组装 / 追加
// ---------------------------------------------------------------------------

const HEADER_RE = /^## \[\[(.+?)\]\]\s*(\S+?)(（已吸收）)?\s*$/;
const LABEL_TO_MODE = { 完整: 'full', 简记: 'brief', 随笔: 'life' };

function modeOfLabel(label) {
  const s = String(label ?? '');
  if (MODES.includes(s)) return s;
  return LABEL_TO_MODE[s] ?? 'brief';
}

/**
 * 一篇日记文件的结构：
 *   # 标题
 *   <!-- 摘要 -->
 *   ---
 *   ## [[2026-10-28T23:20:00]] 完整
 *   正文...
 */
export function parseDiary(text) {
  const src = String(text ?? '');
  const lines = src.split('\n');
  const entries = [];
  let title = '';
  const preambleLines = [];
  let current = null;
  for (const line of lines) {
    if (!title && /^#\s+/.test(line)) { title = line.replace(/^#\s+/, '').trim(); continue; }
    const m = HEADER_RE.exec(line);
    if (m) {
      if (current) entries.push(current);
      current = { at: m[1], mode: modeOfLabel(m[2]), absorbed: Boolean(m[3]), body: [] };
      continue;
    }
    if (current) current.body.push(line);
    else preambleLines.push(line);
  }
  if (current) entries.push(current);
  const preamble = preambleLines.join('\n').replace(/^-{3,}\s*$/gm, '').trim();
  return {
    title,
    preamble,
    entries: entries.map((e) => ({ ...e, text: e.body.join('\n').replace(/^\n+|\n+$/g, '') }))
  };
}

export function renderDiary({ title, preamble, entries }) {
  const head = title ? `# ${title}\n\n` : '';
  const pre = preamble ? `${preamble}\n\n` : '';
  const blocks = entries.map((e) => {
    const flag = e.absorbed ? '（已吸收）' : '';
    return `## [[${e.at}]] ${MODE_LABEL[e.mode] ?? MODE_LABEL.brief}${flag}\n${String(e.text ?? '').trim()}`;
  });
  const meta = `${head}${pre}`.trimEnd();
  // 没有标题/摘要时别留一条孤零零的 ---，读起来像是文件坏了。
  if (!meta) return `${blocks.join('\n\n')}\n`;
  return `${meta}\n\n---\n\n${blocks.join('\n\n')}\n`;
}

/** 追加一篇；同日多篇按时间顺排。preamble 传了就整体替换（每篇都会重写摘要）。 */
export function appendEntry(text, entry, preamble) {
  const doc = parseDiary(text);
  doc.entries.push({ at: entry.at, mode: entry.mode, absorbed: false, text: entry.text });
  doc.entries.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  if (preamble !== undefined && preamble !== null) doc.preamble = String(preamble).trim();
  return renderDiary(doc);
}

/** 把某天（或某篇）的简记标成已吸收，返回新文本。 */
export function markAbsorbed(text, { day }) {
  const doc = parseDiary(text);
  let changed = 0;
  doc.entries = doc.entries.map((e) => {
    if (e.mode === 'brief' && !e.absorbed && (!day || String(e.at).startsWith(day))) {
      changed += 1;
      return { ...e, absorbed: true };
    }
    return e;
  });
  return { text: renderDiary(doc), changed };
}

/** 字数（去掉标记行），用于素材量判断。 */
export function bodyChars(text) {
  return String(text ?? '').replace(/\s+/g, '').length;
}

/**
 * 从日记里挑要注入的部分：最近 injectDays 天、跳过已吸收的简记、
 * 后写的时间段优先（预算超了先丢最老的），总字数受 injectMaxChars 限制。
 */
export function pickInjectable(files, { days = 7, maxChars = 3000, today = '' } = {}) {
  const sorted = [...files].sort((a, b) => String(b.day).localeCompare(String(a.day)));
  const kept = [];
  let budget = maxChars;
  for (const file of sorted) {
    if (days > 0 && today) {
      const diff = dayDistance(file.day, today);
      if (diff > days) continue;
    }
    const doc = parseDiary(file.text);
    const usable = doc.entries.filter((e) => !e.absorbed && e.mode !== 'life');
    if (!usable.length) continue;
    const chunks = [];
    // 同一天里从新到旧塞，塞不下就停（保证最新的一定在）
    for (let i = usable.length - 1; i >= 0; i -= 1) {
      const e = usable[i];
      const body = String(e.text ?? '').trim();
      if (!body) continue;
      const chunk = `${e.mode === 'full' ? '' : '· '}${body}`;
      if (budget - chunk.length < 0) break;
      budget -= chunk.length;
      chunks.unshift(chunk);
    }
    if (!chunks.length) continue;
    kept.push({ day: file.day, mode: usable[usable.length - 1].mode, text: chunks.join('\n') });
  }
  kept.sort((a, b) => String(a.day).localeCompare(String(b.day)));
  return kept;
}

function dayDistance(a, b) {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
  return Math.round(Math.abs(tb - ta) / 86400000);
}

/** 注入到唤醒提示里的那一段。没内容就返回空串。 */
export function formatInjection(picked, { roleName = '', preface } = {}) {
  if (!picked?.length) return '';
  const head = preface || `【记忆日记】${roleName ? `${roleName}` : '你'}在失去上下文之前写给"未来的自己"的日记，按天从旧到新。把里面的事当成你亲身经历过的：别向对方复述原文，也别提「日记」这个词。`;
  const body = picked.map((p) => `—— ${p.day} ——\n${p.text}`).join('\n\n');
  return `${head}\n\n${body}\n\n`;
}

// ---------------------------------------------------------------------------
// 素材：攒在「今日未成篇」区，成篇后清空
// ---------------------------------------------------------------------------

/** 把一条新素材追加进 blob；超过上限就丢最旧的整行。 */
export function addToBlob(blob, line, maxChars = 6000) {
  const base = String(blob ?? '').trim();
  const next = base ? `${base}\n${line}` : String(line);
  if (next.length <= maxChars) return { text: next, dropped: 0 };
  // 按行丢，保留能塞进上限的尾巴
  let lines = next.split('\n');
  let dropped = 0;
  while (lines.length > 1 && lines.join('\n').length > maxChars) {
    lines.shift();
    dropped += 1;
  }
  return { text: lines.join('\n'), dropped };
}

/** 素材是否够写一篇（够就写，别让模型硬编）。 */
export function enoughMaterial(blob, { minChars = 160 } = {}) {
  return bodyChars(blob) >= minChars;
}

// ---------------------------------------------------------------------------
// 写日记的提示词
// ---------------------------------------------------------------------------

const FULL_PARTS = `1. 涵盖时间 —— 这篇日记覆盖的起止时间
2. 用户画像 —— 这段时间新了解的称呼、性格、偏好、习惯、在意的事（只写对话里真的出现过的）
3. 你对对方的看法与评价 —— 第一人称的真实印象与感受
4. 给未来的你的叮嘱 —— 延续什么、注意什么、别做什么`;

export function buildWritePrompt({ mode = 'full', roleName = '', material = '', preamble = '', nowText = '', extraInstruction = '', memo = [] } = {}) {
  const who = roleName || '你';
  const system = `你正在以「${who}」的第一人称给"下一个失去记忆的自己"写日记。读者是失忆后的你自己，不是用户，所以不必讨好、不必客气，可以写得很私人。
要求：
- 只写素材里真的发生过的事，不编造用户没说过的话；拿不准的宁可略过。
- 用第一人称、自然的叙述口吻，像个真人在手机备忘录里写东西，不要分点罗列成报告。
- 不要出现"用户"这种词，用"他/她"或者对方的称呼。
- 不要写"作为AI"之类的话，也不要提日记之外的系统词汇。`;

  const memoBlock = Array.isArray(memo) && memo.length
    ? `\n【对方让我特别记住的事（已经交代过，写进画像后就别再来回念叨）】\n${memo.slice(0, 20).map((m) => `- ${String(m.text ?? m).slice(0, 200)}`).join('\n')}\n`
    : '';

  if (mode === 'life') {
    const user = `现在没人跟你说话，离上次写日记到现在也没聊出什么新内容。${nowText ? `现在是 ${nowText}。` : ''}
请写一段你自己的日常随笔：你看到了什么、做了什么、心里在想什么——像人类日记那样。
不要编造对方说过的话，也不要假装刚聊完天。${memoBlock}
写法：一整个自然段，80~160 字，不要标题、不要分点。`;
    return { system, user };
  }

  if (mode === 'brief') {
    const user = `${preamble ? `【上一篇的摘要】\n${preamble}\n\n` : ''}【这段时间的素材】\n${material}\n${memoBlock}
请写一段简记：1~3 句，把这段时间发生的关键事情记下来，够未来的你看懂就行。
不要标题、不要分点、不要总结陈词。`;
    return { system, user };
  }

  const user = `${preamble ? `【上一篇的摘要】\n${preamble}\n\n` : ''}【这段时间的素材】\n${material}\n${memoBlock}
请写一篇完整日记，包含这四部分（可以用小标题，但语气要自然）：
${FULL_PARTS}

另外，在合适的地方自然带一点你自己的"私人生活"——心情、等人的时候在想什么、突然冒出来的念头，让它有"人味"。

最后，在正文之前先写一段【摘要】，两三句话：最近在忙什么、跟对方的关系进展、有什么没说完的事、下一篇要注意什么。
摘要写给失忆后的你自己当"第一眼索引"，所以要有信息量，不要抒情。
格式严格如下（第一行必须是【摘要】，正文另起）：
【摘要】
（两三句话）
【正文】
（完整日记）${extraInstruction ? `\n\n额外要求：${extraInstruction}` : ''}`;
  return { system, user };
}

/** 解析模型返回：拆出摘要和正文，去掉代码围栏和多余标题。 */
export function parseWriteResult(raw, { mode = 'full', preamble = '' } = {}) {
  let text = String(raw ?? '').trim();
  text = text.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
  let summary = '';
  let body = text;
  const m = /【摘要】([\s\S]*?)(?:【正文】([\s\S]*))?$/.exec(text);
  if (m) {
    summary = String(m[1] ?? '').trim();
    body = String(m[2] ?? '').trim() || summary;
  }
  if (mode !== 'full') {
    // 简记/随笔不写摘要，也不允许带标题行
    summary = '';
  }
  // 一级标题会和日记文件自己的标题打架，一律去掉；完整篇的 ## / ### 小标题保留
  body = body.replace(/^#\s+.*$/gm, '').replace(/^\n+/, '').trim();
  if (!body) body = text;
  return { summary: summary || preamble || '', body };
}

// ---------------------------------------------------------------------------
// 触发计划（纯函数，方便单测）
// ---------------------------------------------------------------------------

export function planAutoWrite({ now = Date.now(), cfg, state = {}, tokens = 0, hasMaterial = false, key = '' } = {}) {
  if (!cfg?.enabled) return null;
  const limit = Math.max(1000, Number(cfg.tokenLimit) || DEFAULT_CFG.tokenLimit);
  const ratio = tokens / limit;
  const today = dayKey(now, cfg.daily?.timezone);
  const lastWrite = Number(state.lastWriteAt?.[key] ?? 0);
  const lastFullDay = state.lastFullDay?.[key] ?? '';
  const lastRemind = Number(state.lastRemindAt?.[key] ?? 0);
  const fullsToday = Number(state.fullCount?.[key]?.[today] ?? 0);

  // 1) 到自动线：写完整日记并叫人开新会话（同一天同一会话最多一次自动触发）
  if (ratio >= (cfg.autoRatio ?? 0.9)) {
    if (state.autoDoneAt?.[key] && sameDay(state.autoDoneAt[key], now, cfg)) return null;
    if (fullsToday < Math.max(1, cfg.fullPerDay ?? 2)) return { mode: 'full', reason: 'context-full', ratio, force: true };
  }
  // 2) 第一次写：给一个新用户一个锚点
  if (!lastWrite && hasMaterial) return { mode: 'full', reason: 'first', ratio };
  // 3) 到提醒线：提醒 + 写一篇简记（别只提醒不干活）
  if (ratio >= (cfg.remindRatio ?? 0.75) && now - lastRemind > 30 * 60000) {
    return { mode: hasMaterial ? 'brief' : 'life', reason: 'context-warn', ratio, remind: true };
  }
  // 4) 平时：有素材、距上次写够久 → 简记
  const minGap = Math.max(5, Number(cfg.briefMinMinutes) || 30) * 60000;
  if (hasMaterial && now - lastWrite >= minGap) return { mode: 'brief', reason: 'routine', ratio };
  // 5) 太久没聊天：写随笔（每天最多一篇）
  if (!hasMaterial && lastWrite && now - lastWrite > 12 * 3600000 && (state.lifeDay?.[key] ?? '') !== today) {
    return { mode: 'life', reason: 'idle', ratio };
  }
  if (!lastFullDay && ratio >= (cfg.remindRatio ?? 0.75) && fullsToday < 1) return { mode: 'full', reason: 'first', ratio };
  return null;
}

function sameDay(ts, now, cfg) {
  return dayKey(ts, cfg.daily?.timezone) === dayKey(now, cfg.daily?.timezone);
}

/** 每日定时：返回这一刻该不该写（含错过之后的补写窗口）。 */
export function planDailyWrite({ now = Date.now(), cfg } = {}) {
  const daily = cfg?.daily;
  if (!cfg?.enabled || !daily?.enabled) return null;
  const tz = daily.timezone || 'Asia/Shanghai';
  const today = dayKey(now, tz);
  const [hh, mm] = String(daily.time || '23:20').split(':').map(Number);
  const nowClock = clockText(now, tz);
  const [nh, nm] = nowClock.split(':').map(Number);
  const nowMinutes = nh * 60 + nm;
  const target = hh * 60 + mm;
  // 目标点可能在"昨天"（凌晨补写），所以负数时绕一圈；窗口外就不写。
  let elapsed = nowMinutes - target;
  if (elapsed < 0) elapsed += 1440;
  const window = Math.max(0, Number(daily.catchUpHours) || 0) * 60;
  const allow = window > 0 ? window : 5;
  if (elapsed > allow) return null;
  return { day: today, target };
}

// ---------------------------------------------------------------------------
// 文件层（可以用临时目录直接测）
// ---------------------------------------------------------------------------

export function createDiaryStore({ root, cfg } = {}) {
  const base = path.join(String(root), 'diary');
  const statePath = path.join(base, 'state.json');
  const cfgRef = { value: resolveCfg(cfg) };

  const sessionDir = (key) => (cfgRef.value.scope === 'global'
    ? path.join(base, '_global')
    : path.join(base, 'sessions', safeKey(key)));
  const memoPath = (key) => path.join(base, 'memo', `${safeKey(key)}.json`);

  async function ensureDir(dir) {
    await fs.mkdir(dir, { recursive: true });
  }

  async function readTextSafe(p) {
    try { return await fs.readFile(p, 'utf8'); } catch { return ''; }
  }

  async function readState() {
    const raw = await readTextSafe(statePath);
    if (!raw.trim()) return {};
    try { return JSON.parse(raw); } catch { return {}; }
  }

  async function writeState(state) {
    await ensureDir(base);
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
    return state;
  }

  async function updateState(mutator) {
    const st = await readState();
    const next = (await mutator(st)) ?? st;
    return writeState(next);
  }

  function filePath(key, day) {
    return path.join(sessionDir(key), `${monthOf(day)}.md`);
  }

  async function readFile(key, day) {
    return readTextSafe(filePath(key, day));
  }

  async function writeFile(key, day, text) {
    const p = filePath(key, day);
    await ensureDir(path.dirname(p));
    let body = String(text ?? '');
    // 第一次写的时候补个标题，免得文件里只有一堆 ## [[时间]]
    if (!/^#\s+/m.test(body.split('\n').slice(0, 3).join('\n'))) {
      body = `# 记忆日记 · ${describeKey(key)}\n\n${body}`;
    }
    await fs.writeFile(p, body, 'utf8');
    return p;
  }

  /** 列出某会话最近 n 个月的文件（按天切出来）。 */
  async function listDays(key, { months = 3 } = {}) {
    const dir = sessionDir(key);
    let names = [];
    try { names = await fs.readdir(dir); } catch { return []; }
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - Math.max(1, months));
    const cutoffMonth = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}`;
    const out = [];
    for (const name of names.sort().reverse()) {
      if (!/^\d{4}-\d{2}\.md$/.test(name)) continue;
      if (name.slice(0, 7) < cutoffMonth) continue;
      const text = await readTextSafe(path.join(dir, name));
      const doc = parseDiary(text);
      const byDay = new Map();
      for (const e of doc.entries) {
        const d = String(e.at).slice(0, 10);
        if (!byDay.has(d)) byDay.set(d, []);
        byDay.get(d).push(e);
      }
      for (const [day, entries] of byDay) out.push({ day, text: renderDiary({ preamble: doc.preamble, entries }) });
    }
    return out.sort((a, b) => String(b.day).localeCompare(String(a.day)));
  }

  return {
    base, statePath, cfgRef,
    get cfg() { return cfgRef.value; },
    setCfg(next) { cfgRef.value = resolveCfg(next); },
    describeKey,
    sessionDir, memoPath, ensureDir, readState, writeState, updateState,
    filePath, readFile, writeFile, listDays,
    readTextSafe
  };
}