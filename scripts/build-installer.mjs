// 打 Windows 安装包（Inno Setup）。
//
// 流程：
//   1. 用 build-standalone.mjs 打一份「干净」的绿色目录到 dist\release
//      —— 不带网关（SnowLuma 许可不允许随包分发，第一次打开面板会帮用户下载）
//      —— 不带任何个人数据（会话、群号、密钥、日志、登录态）
//   2. 调 ISCC 把 dist\release 编成 dist\QQ聊天机器人-<版本>-setup.exe
//
// 用法：
//   node scripts/build-installer.mjs                # 完整流程
//   node scripts/build-installer.mjs --keep         # 复用已有的 dist\release，不重新打
//   node scripts/build-installer.mjs --with-gateway # 连网关一起打包（只给自己用，别公开分发）
//   node scripts/build-installer.mjs --no-sign       # 不签名
//
// 需要 Inno Setup 6（https://jrsoftware.org/isdl.php，或 winget install JRSoftware.InnoSetup）。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const withGateway = argv.includes('--with-gateway');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const RELEASE = path.join(ROOT, 'dist', 'release');
const ISS = path.join(ROOT, 'installer', 'qq-bot.iss');

function step(name, fn) {
  process.stdout.write(`\n▶ ${name}\n`);
  return fn();
}

// ---------- 1. 找 ISCC ----------
function findIscc() {
  const candidates = [
    process.env.ISCC,
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
    'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files (x86)\\Inno Setup 5\\ISCC.exe',
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* 忽略 */ }
  }
  // 最后试 PATH
  try {
    const out = execFileSync('where.exe', ['ISCC.exe'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first) return first;
  } catch { /* 没有就算了 */ }
  return null;
}

// ---------- 2. 打绿色目录 ----------
if (!keep) {
  step('打包绿色目录（不含网关、不含个人数据）', () => {
    const args = ['scripts/build-standalone.mjs', '--out', 'dist/release', '--force'];
    if (!withGateway) args.push('--no-gateway');
    execFileSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  });
} else {
  if (!fs.existsSync(RELEASE)) {
    console.error(`--keep 需要 dist\\release 已存在，先去掉 --keep 跑一次。`);
    process.exit(1);
  }
  console.log(`\n▶ 复用已有 ${RELEASE}`);
}

// 干净性检查：这几样绝对不能进发布包
step('检查发布目录有没有夹带个人数据', () => {
  const forbidden = [
    ['state/sessions.json', '会话列表'],
    ['state/social-v2.json', '群友印象'],
    ['state/slang.json', '黑话库'],
    ['state/stickers.json', '收藏表情'],
    ['state/console-token', '控制台令牌'],
    ['state/ui.json', '面板本地设置'],
    ['snowluma/data', '网关登录态'],
    ['snowluma/config', '网关配置'],
    ['napcat', 'NapCat 残留'],
  ];
  const hits = forbidden.filter(([rel]) => fs.existsSync(path.join(RELEASE, rel)));
  if (hits.length) {
    console.error('发布目录里有不该出现的东西：');
    for (const [rel, why] of hits) console.error(`  ✗ ${rel} —— ${why}`);
    process.exit(1);
  }
  // config.json 必须是模板：llm.apiKey 为空、allow 为空
  const cfgPath = path.join(RELEASE, 'config.json');
  if (!fs.existsSync(cfgPath)) {
    console.error('  ✗ 缺少 config.json 模板');
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const leaks = [];
  if (cfg.llm?.apiKey) leaks.push(`llm.apiKey = ${String(cfg.llm.apiKey).slice(0, 6)}…`);
  if (cfg.snowluma?.accessToken) leaks.push('snowluma.accessToken 非空');
  if (cfg.tts?.apiKey) leaks.push('tts.apiKey 非空');
  if (cfg.webSearch?.apiKey) leaks.push('webSearch.apiKey 非空');
  if (cfg.ownerQQ) leaks.push(`ownerQQ = ${cfg.ownerQQ}`);
  if (cfg.allow?.groups?.length) leaks.push(`allow.groups = ${cfg.allow.groups.length} 个`);
  if (cfg.allow?.private?.length) leaks.push(`allow.private = ${cfg.allow.private.length} 个`);
  if (cfg.consoleToken) leaks.push('consoleToken 非空');
  if (leaks.length) {
    console.error('  ✗ config.json 里还有个人数据：');
    for (const l of leaks) console.error(`    - ${l}`);
    process.exit(1);
  }
  console.log('  ✓ 没有会话/印象/黑话/表情/登录态，config.json 是空模板');
});

// ---------- 3. 签名（可选） ----------
// 用本机的自签名代码签名证书给主程序和安装包打 Authenticode 签名。
// 自签名只在本机信任列表里算「有效」，别人电脑上仍会提示未知发布者 —— 要彻底消掉
// 只能买 CA 证书或用 SignPath 这类给开源项目的免费签名服务。
const SIGN = path.join(ROOT, 'installer', 'sign.ps1');
const wantSign = !argv.includes('--no-sign') && fs.existsSync(SIGN);

function signFile(file) {
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SIGN, '-Path', file,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    process.stdout.write(out.replace(/^/gm, '  '));
    return true;
  } catch (err) {
    if (err.status === 2) {
      console.log('  跳过：本机没有代码签名证书');
      return false;
    }
    console.warn(`  签名失败（${err.status}）：${String(err.stdout || err.message).trim()}`);
    return false;
  }
}

if (wantSign) {
  step('给主程序打签名', () => signFile(path.join(RELEASE, 'QQ聊天机器人.exe')));
}

// ---------- 4. 编译安装包 ----------
const iscc = findIscc();
if (!iscc) {
  console.error('\n找不到 ISCC.exe。装一个 Inno Setup 6：');
  console.error('  winget install --id JRSoftware.InnoSetup -e');
  console.error('或者官网 https://jrsoftware.org/isdl.php ，装完重跑本脚本。');
  process.exit(1);
}

step(`编译安装包（${path.basename(iscc)}，版本 ${version}）`, () => {
  execFileSync(iscc, [
    `/DAppVersion=${version}`,
    `/DSourceDir=${RELEASE}`,
    ISS,
  ], { cwd: ROOT, stdio: 'inherit' });
});

// ---------- 5. 签名安装包 ----------
const setup = path.join(ROOT, 'dist', `${'QQ聊天机器人'}-${version}-setup.exe`);
if (!fs.existsSync(setup)) {
  console.error(`\n编译好像没成功，找不到 ${setup}`);
  process.exit(1);
}
if (wantSign) {
  step('给安装包打签名', () => signFile(setup));
}


// ---------- 6. 结果 ----------
const mb = (fs.statSync(setup).size / 1024 / 1024).toFixed(1);
console.log(`\n完成：${setup}`);
console.log(`  体积 ${mb} MB，版本 ${version}${withGateway ? '（含网关）' : '（不含网关）'}`);
console.log(`  绿色目录：${RELEASE}`);
