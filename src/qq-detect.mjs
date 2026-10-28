// QQNT 探测：面板只认 QQNT 版 QQ，老版（9.7 那批 C++ 版）一律不碰。
//
// 为什么要有这个文件：同一台机器上常常并存两套 QQ（老版 E:\QQ\Bin、新版 F:\QQNT），
// 主程序都叫 QQ.exe。网关的做法是 hook 注入到进程里，只能注入 QQNT；认错目标就
// 表现为「网关起不来 / 一直等注入」，而面板还显示找到了 QQ。
//
// 权威来源：注册表里记的 QQNT 安装目录。目录之外一律不认，宁可返回空让用户手动选。

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const QQNT_REG_KEYS = [
  'HKLM:\\SOFTWARE\\WOW6432Node\\Tencent\\QQNT',
  'HKLM:\\SOFTWARE\\Tencent\\QQNT',
  'HKCU:\\Software\\Tencent\\QQNT'
];

const QQ_EXE_RE = /[\\/]QQ\.exe$/i;
const NT_DIR_RE = /[\\/]QQNT[\\/]/i;

// 注册表里可能记目录、也可能记 exe；统一归成「存在 QQ.exe 的目录」，否则返回空。
export function normalizeNTRoot(raw) {
  const value = String(raw ?? '').trim().replace(/^"|"$/g, '');
  if (!value) return '';
  const dir = QQ_EXE_RE.test(value) ? path.dirname(value) : value;
  return fs.existsSync(path.join(dir, 'QQ.exe')) ? dir : '';
}

// 判定某个 QQ.exe 是不是 QQNT：在注册表记录的安装目录里，或者路径上带 QQNT。
export function isQQNTPath(exe, ntRoot) {
  const p = String(exe ?? '').trim();
  if (!p) return false;
  if (ntRoot) {
    const rel = path.relative(ntRoot, p);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true;
  }
  return NT_DIR_RE.test(p);
}

export function readQQNTRootFresh() {
  return new Promise((resolve) => {
    const keys = QQNT_REG_KEYS.map((k) => `'${k}'`).join(',');
    const script = `foreach ($k in @(${keys})) { if (Test-Path $k) { $p = Get-ItemProperty $k -ErrorAction SilentlyContinue; foreach ($f in @('Install','InstallPath','Path')) { $v = $p.$f; if ($v) { Write-Output $v; exit } } } }`;
    execFile('powershell', ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 8000 }, (error, stdout) => {
      if (error) return resolve('');
      resolve(normalizeNTRoot(String(stdout ?? '').split(/\r?\n/)[0]));
    });
  });
}

let cache = { at: 0, root: '' };

export async function readQQNTRoot() {
  if (Date.now() - cache.at < 10000) return cache.root;
  const root = await readQQNTRootFresh();
  cache = { at: Date.now(), root };
  return root;
}

// 纯函数，方便单测：从候选里挑出唯一的 QQNT 主程序。
// 顺序：该目录下正在跑的进程 → 配置里存的 → 注册表目录本身 → 兜底值。
export function pickQQNTPath({ ntRoot = '', procs = [], configured = '', fallback = '' } = {}) {
  const accept = (p) => Boolean(p) && QQ_EXE_RE.test(p) && fs.existsSync(p) && isQQNTPath(p, ntRoot);

  const running = procs.find((p) => accept(p?.path));
  if (running) return running.path;

  if (accept(configured)) return String(configured).trim();

  if (ntRoot) {
    const exe = path.join(ntRoot, 'QQ.exe');
    if (fs.existsSync(exe)) return exe;
  }

  if (accept(fallback)) return String(fallback).trim();
  return '';
}