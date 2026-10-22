// DSH 后端：把现有 NodeApiClient 包一层，行为与接入 backend 抽象之前完全一致。
//
// 这一层刻意保持“薄”：不缓存、不改写响应、不吞错。桥接里那些针对 DSH 的怪癖补丁
// （session/modelCatalog 回落、modelAppliedSessions、事件重放）都还在 bridge.js 里，
// 因为它们依赖桥接自己的会话状态机，搬进这里只会制造两份状态。

import { NodeApiClient } from '../dsh-client.js';

/**
 * @param {object} cfg bridge.js 的配置对象（只读 dsh.* 段）
 * @returns {object} NodeApiClient 实例，附加 kind 字段供日志/分支使用
 */
export function createDshBackend(cfg) {
  const client = new NodeApiClient(cfg.dsh.baseUrl, undefined, {
    token: cfg.dsh.authToken,
    // true=用户在 config.json 里显式填的；false=从日志猜的。猜来的不优先于离线铸造。
    tokenExplicit: cfg.dsh.authTokenExplicit === true,
    header: cfg.dsh.authHeader,
    prefix: cfg.dsh.authPrefix,
    // 默认只允许把 launch token 交给回环地址；远程 DSH 需要显式 opt-in（见 dsh-client.ensureAuth）。
    allowRemote: cfg.dsh.allowRemote === true
  });
  // 供 bridge.js 打日志 / 分支判断；不要用它做 instanceof 判断（standalone 也要有同名字段）。
  client.kind = 'dsh';
  return client;
}
