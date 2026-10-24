// shared.js — 面板与桥接控制台共用的基础工具函数
// 约定：只做 UI 反馈，不改全局状态；供 iframe 里的 console.html 通过 window.parent.QQBotShared 引用。
window.$ = window.$ || ((s, r) => (r || document).querySelector(s));
window.esc = window.esc || ((s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
window.fmtAgo = window.fmtAgo || ((ms) => {
  if (ms === null || ms === undefined || ms === '') return '未知';
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '未知';
  if (n < 1000) return '刚刚';
  if (n < 60_000) return Math.round(n / 1000) + ' 秒';
  if (n < 3_600_000) return Math.round(n / 60_000) + ' 分钟';
  if (n < 86_400_000) return Math.round(n / 3_600_000) + ' 小时';
  return Math.round(n / 86_400_000) + ' 天';
});
window.toast = window.toast || ((id, text, isErr) => {
  const el = typeof id === 'string' ? document.getElementById(id) : id;
  if (!el) return;
  el.textContent = text;
  el.className = isErr ? 'toast err' : 'toast';
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 2800);
});
