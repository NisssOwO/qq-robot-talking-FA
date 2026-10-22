// Backend 契约：bridge.js 只认这一层，不认具体后端。
//
// 两个实现：
//   - dsh.mjs        → 连正在运行的 DeepSeek Harness（Web API + remote.mux 事件流）
//   - standalone.mjs → 自建 agent 运行时（直连 OpenAI 兼容 / Responses / Anthropic 接口）
//
// 为什么接口**长得像 DSH**：bridge.js 有 60 多处调用 `api.workspace.create` /
// `api.sessions.prompt` / `api.events.follow` / `api.respond`，并且 pumpMux 直接消费
// DSH 的 session/event 帧（turn/start、tool/call、tool/result、assistant/message、turn/end）。
// 让 standalone 复刻同一套形状，bridge.js 的改动可以压到“换一个工厂函数”就完事——
// 这也意味着 standalone 有 bug 时能一键切回 DSH 对照，而不是两套逻辑各说各话。
//
// 方法清单（与 dsh-client.js 的 NodeApiClient 对齐）：
//   workspace.create({path})                    → RpcResponse<{workspace, created}>
//   workspace.rename({workspaceId,title})       → RpcResponse
//   workspace.archiveSession({sessionId})       → RpcResponse
//   sessions.create({workspaceId, agentPreset?})→ RpcResponse<{sessionId}>
//   sessions.prompt({sessionId,mode,content})   → RpcResponse<{accepted,turn?}>
//   sessions.selectModel({sessionId,provider,model,...}) → RpcResponse
//   sessions.list({})                           → RpcResponse<{sessions}>
//   settings.describe({}) / settings.update({ns,patch})
//   agentPresets.list({})                       → RpcResponse<{presets}>
//   events.follow(sessionId) / events.forget(sessionId) / events.mux({})
//   respond(message)                            → RpcResponse
//   stopSessionWork(sessionId,{signal,timeoutMs})
//   callUnary(method, payload)                  → RpcResponse
//
// RpcResponse 统一形状：{ result: { ok: true, value } } 或 { result: { ok:false, error:{code,message} } }，
// 由 dsh-client.js 的 unwrap() 拆包；standalone 必须产出同形状，否则 unwrap 会抛。

import { createDshBackend } from './dsh.mjs';
import { createStandaloneBackend } from './standalone.mjs';

/**
 * @param {object} cfg  bridge.js 的 loadConfig() 结果
 * @param {object} [options]
 * @param {(line: string) => void} [options.log]
 * @returns {object} Backend 实例（见上方方法清单）
 */
export function createBackend(cfg, options = {}) {
  const kind = String(cfg?.backend ?? 'dsh').trim().toLowerCase();
  if (kind === 'dsh') return createDshBackend(cfg);
  if (kind === 'standalone') return createStandaloneBackend(cfg, options);
  throw new Error(`config.json 的 backend "${cfg?.backend}" 未知：只支持 "dsh" 或 "standalone"`);
}

/** RpcResponse 成功形状；standalone 侧的每个方法都要包成这个。 */
export function rpcOk(value) {
  return { result: { ok: true, value } };
}

/** RpcResponse 失败形状。 */
export function rpcFail(code, message) {
  return { result: { ok: false, error: { code: String(code), message: String(message) } } };
}
