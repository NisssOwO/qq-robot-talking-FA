// 回合收场判定：这个 turn 是正常说完的，还是失败断掉的。
// 失败的话要把该会话的待唤醒状态清干净，否则残留的 lease / 计数会把下一轮唤醒卡死。

const FAILED_CODES = new Set([
  'turn_failed',
  'failed',
  'error',
  'aborted',
  'timeout',
  'interrupted'
]);

/**
 * @param {any} ended   mux 推来的 turn/end 帧
 * @param {string} key  会话 key（group:xxx / private:xxx）
 * @param {object} ctx  待清理的状态容器（Map 或带 delete 的对象）
 * @returns {boolean}   是否是失败回合
 */
export function clearFailedWakeTurn(ended, key, ctx = {}) {
  const code = String(ended?.reason?.code ?? '');
  const failed = ended?.reason?.kind === 'failed' || ended?.reason?.failed === true || FAILED_CODES.has(code);
  if (!failed) return false;
  const {
    pendingWakeKeys,
    disarmPendingWakeLease,
    wakeConfigUpdatedKeys,
    markReadCalledKeys,
    wakeConfigMissCount
  } = ctx || {};
  try { pendingWakeKeys?.delete?.(key); } catch { /* 状态容器形状不一致就跳过 */ }
  try { disarmPendingWakeLease?.(key); } catch { /* 同上 */ }
  try { wakeConfigUpdatedKeys?.delete?.(key); } catch { /* 同上 */ }
  try { markReadCalledKeys?.delete?.(key); } catch { /* 同上 */ }
  try { wakeConfigMissCount?.delete?.(key); } catch { /* 同上 */ }
  return true;
}
