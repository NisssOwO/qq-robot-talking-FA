// 世界观提示词：从 world.json 生成「世界设定 + 你的歌 + 你上过的演出」。
//
// 对齐 eidolon-sc 的 world.py（World.prompt），但按 A 档精简：
//   · 世界设定：全带（含那 6 条「不编造」规则）
//   · 你的歌：只列歌名，不带收录唱片的发售日
//   · 你上过的演出：演出名 + 年份，不带每场的日期和会场
//
// 为什么不带 today 变量：这段文本会进对话历史、靠服务端前缀缓存摊平成本。
// 一旦掺进「将于」这类依赖当天日期的措辞，每天前缀都会变一次 → 缓存全废。
// 当前时间由每轮的【当前时间】提供，模型自己会算先后。
//
// 纯函数 + 按 mtime 缓存解析结果：world.json 有 1.3MB，不宜每次现解析。
import fs from 'node:fs';

const worldCache = new Map();

function loadWorld(file) {
  const stat = fs.statSync(file);
  const hit = worldCache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.world;
  const world = JSON.parse(fs.readFileSync(file, 'utf8'));
  worldCache.set(file, { mtimeMs: stat.mtimeMs, world });
  return world;
}

const sortedKey = (names) => [...names].sort().join('|');
const dayText = (iso) => {
  const [y, m, d] = String(iso).split('-').map(Number);
  return `${y}年${m}月${d}日`;
};

function settingSection(world) {
  const asOf = dayText(world.as_of);
  const lines = [
    '# 世界设定',
    `以下是你所在的${world.office?.name ?? '事务所'}的基本情况，资料截止到 ${asOf}。`,
    '',
  ];
  for (const staff of world.office?.staff ?? []) {
    lines.push(`${staff.position}：${staff.name}${staff.reading ? `（${staff.reading}）` : ''}`);
  }
  lines.push('', '事务所的组合和成员（每位偶像只属于一个组合）：');
  for (const unit of world.units ?? []) {
    lines.push(`- ${unit.name}${unit.reading ? `（${unit.reading}）` : ''}：${(unit.members ?? []).join('、')}`);
  }
  lines.push(
    '',
    '关于作品里的事实：',
    '- 歌曲、唱片、演出，上面的资料里查不到的，就老实说一时想不起来；既不说「没有这回事」，也不顺着对方的说法附和、编下去。',
    '- 不引用歌词，也不编造歌词。被要求唱或念歌词时，用你自己的方式岔开，比如说想在舞台上唱给他听。',
    '- 关于演出，你只知道名称、日期、会场、出演者和曲目这类事实，不编造台上发生了什么（MC、现场的情节等）。',
    '- 不谈论声优，也不知道「中の人」这回事；被问到时按你自己的性格应对，不说出任何人的名字。',
    '- 不谈论具体的周边商品（立牌、徽章之类），被问到时按你自己的性格应对，不编造商品。',
    `- ${asOf}以后的事（新的歌曲、唱片、演出、新来的偶像等）你一概不知道，被问到就说还没听说。`,
  );
  return lines.join('\n');
}

function songsSection(world, worldName) {
  const idol = (world.idols ?? []).find((i) => i.name === worldName);
  const unit = (world.units ?? []).find((u) => u.name === idol?.unit);
  const wanted = new Set([sortedKey([worldName]), ...(unit ? [sortedKey(unit.members ?? [])] : [])]);
  const songs = (world.songs ?? []).filter((s) => !s.special_unit && wanted.has(sortedKey(s.singers ?? [])));
  const lines = ['# 你的歌'];
  if (!songs.length) {
    lines.push('资料里还没有你唱的歌。');
    return { text: lines.join('\n'), count: 0 };
  }
  lines.push('下面是你一个人唱的歌，和你所在的组合全员一起唱的歌。别的偶像的歌、特别组合或者全体一起唱的歌不在这里。');
  for (const song of songs) lines.push(`- ${song.title}`);
  return { text: lines.join('\n'), count: songs.length };
}

function livesSection(world, worldName) {
  const lives = [];
  for (const live of world.lives ?? []) {
    const years = [...new Set((live.days ?? [])
      .filter((d) => (d.performers ?? []).includes(worldName))
      .map((d) => String(d.date).slice(0, 4)))].sort();
    if (years.length) lives.push({ name: live.name, years });
  }
  const lines = ['# 你上过的演出'];
  if (!lives.length) {
    lines.push('资料里还没有你站上过的舞台。');
    return { text: lines.join('\n'), count: 0 };
  }
  lines.push('下面是你站上过的舞台。你没有上台的演出不在这里：那些演出你可能知道，但你没有站上去。');
  for (const live of lives) lines.push(`- ${live.name}（${live.years.map((y) => `${y}年`).join('、')}）`);
  return { text: lines.join('\n'), count: lives.length };
}

// 非偶像（事务员、工作人员）：世界设定照给，但不给「你的歌 / 你上过的演出」，
// 换成一句位置说明，免得模型以为自己有作品和舞台。
function staffSection(world, worldName) {
  const staff = (world.office?.staff ?? []).find((s) => s.name === worldName);
  return [
    '# 你的位置',
    `你不是偶像，是${world.office?.name ?? '事务所'}的${staff?.position ?? '工作人员'}，不属于任何组合。`,
    '你没有自己的歌，也没有自己的唱片，不登台演出；上台的都是偶像们，你只在背后安排和陪同。',
    '资料里没有你的作品和舞台，这是对的：不要编造自己的歌、唱片或演出，也不要冒充偶像。',
  ].join('\n');
}

/**
 * 生成某个角色的世界观提示词（A 档）。
 * @returns {{ text: string, chars: number, songs: number, lives: number, asOf: string|null }|null}
 *          角色在资料里找不到时返回 null（调用方别硬塞）。
 */
export function buildWorldPrompt(file, worldName) {
  if (!file || !worldName) return null;
  let world;
  try {
    world = loadWorld(file);
  } catch {
    return null;
  }
  const isIdol = (world.idols ?? []).some((i) => i.name === worldName);
  const isStaff = (world.office?.staff ?? []).some((s) => s.name === worldName);
  if (!isIdol && !isStaff) return null;
  const setting = settingSection(world);
  if (!isIdol) {
    // 非偶像（事务员）：世界设定照给，但不给「你的歌 / 你上过的演出」。
    const text = [setting, staffSection(world, worldName)].join('\n\n');
    return { text, chars: text.length, songs: 0, lives: 0, asOf: world.as_of ?? null };
  }
  const songs = songsSection(world, worldName);
  const lives = livesSection(world, worldName);
  const text = [setting, songs.text, lives.text].join('\n\n');
  return { text, chars: text.length, songs: songs.count, lives: lives.count, asOf: world.as_of ?? null };
}