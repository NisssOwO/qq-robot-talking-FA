import { QuietHours } from '../src/quiet-hours.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 纯逻辑回归：不依赖真实时钟、不发网络请求（除非加 --with-holidays）。
const withHolidays = process.argv.includes('--with-holidays');
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-test-'));
const quiet = new QuietHours({
  config: { enabled: true, weekdays: [1, 2, 3, 4, 5], windows: [['09:00', '12:00'], ['14:00', '18:00']], holidays: withHolidays ? 'cn' : 'none' },
  stateDir,
  log: () => {},
});

const at = (date, hm) => Date.parse(`${date}T${hm}:00+08:00`);
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label} -> ${JSON.stringify(actual)}${ok ? '' : `（期望 ${JSON.stringify(expected)}）`}`);
};

// 窗口边界（2026-10-19 是周一）
for (const [hm, expected] of [['08:59', 'normal'], ['09:00', 'quiet'], ['11:59', 'quiet'], ['12:00', 'normal'], ['13:59', 'normal'], ['14:00', 'quiet'], ['17:59', 'quiet'], ['18:00', 'normal']]) {
  check(`周一 ${hm}`, quiet.state(at('2026-10-19', hm)).state, expected);
}
check('周六 10:00', quiet.state(at('2026-10-24', '10:00')).state, 'normal');
check('周日 10:00', quiet.state(at('2026-10-25', '10:00')).state, 'normal');

// 例外：静默期只认管理员 @；覆盖期任何人都行
const monday10 = at('2026-10-19', '10:00');
check('静默期 群友@', quiet.allowsInbound({ isOwner: false, mentioned: true, now: monday10 }), false);
check('静默期 管理员@', quiet.allowsInbound({ isOwner: true, mentioned: true, now: monday10 }), true);
check('静默期 管理员无@', quiet.allowsInbound({ isOwner: true, mentioned: false, now: monday10 }), false);

// 临时覆盖
quiet.setOverride('minutes', 15, monday10);
check('覆盖中状态', quiet.state(monday10 + 60_000).state, 'override');
check('覆盖期 群友@', quiet.allowsInbound({ isOwner: false, mentioned: true, now: monday10 + 60_000 }), true);
check('覆盖期 无@', quiet.allowsInbound({ isOwner: true, mentioned: false, now: monday10 + 60_000 }), false);
check('覆盖到期后', quiet.state(monday10 + 16 * 60_000).state, 'quiet');
quiet.clearOverride();

// 一次性回合标记
quiet.markOwnerException('group:1', 1000, monday10);
check('例外标记有效', quiet.isOwnerException('group:1', monday10 + 500), true);
check('例外标记过期', quiet.isOwnerException('group:1', monday10 + 2000), false);

if (withHolidays) {
  const got = await quiet.refreshHolidays(at('2026-10-01', '10:00'));
  console.log('节假日拉取:', got);
  const p = (date) => quiet.utc8Parts(at(date, '10:00'));
  check('国庆 10-01 是假日', quiet.isWorkday(p('2026-10-01')), false);
  check('10-08 恢复上班', quiet.isWorkday(p('2026-10-08')), true);
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
fs.rmSync(stateDir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
