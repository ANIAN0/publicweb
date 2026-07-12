// Eve 侧 EventBus 单例 —— 实现抽到 EventBusCore，本文件仅挂载独立实例（LIB-001）
// 与 session-bus 有意隔离，禁止合并全局总线
// T-008：emit 同步 publish generation-stream + idle，与 local 展示续接同构
import type { WebtoolEvent } from '../protocol/events';
import { EventBusCore } from '../events/event-bus-core';
import { generationStream } from '../events/generation-stream';
import { noteTurnEvent } from '../events/turn-idle-tracker';

export { EventBusCore as EventBus } from '../events/event-bus-core';

// global 挂载防 HMR 重置：subscribers/buffer 跨 HMR 保留
declare global {
  // eslint-disable-next-line no-var
  var __eventBus: EventBusCore | undefined;
}

const core: EventBusCore = global.__eventBus ?? new EventBusCore();
if (!global.__eventBus) global.__eventBus = core;

export const eventBus = {
  subscribe: core.subscribe.bind(core) as EventBusCore['subscribe'],
  release: core.release.bind(core) as EventBusCore['release'],
  sessionCount: core.sessionCount.bind(core) as EventBusCore['sessionCount'],
  getLastId: core.getLastId.bind(core) as EventBusCore['getLastId'],
  emit(sessionId: string, event: WebtoolEvent, runIdHint?: string): number {
    const effectiveRunId = runIdHint ?? generationStream.getActiveRunId(sessionId);
    try {
      generationStream.publish(sessionId, event, runIdHint);
    } catch (err) {
      console.error('[event-bus] generationStream.publish failed:', err);
    }
    try {
      noteTurnEvent(sessionId, event);
    } catch {
      /* ignore */
    }
    return core.emit(sessionId, event, effectiveRunId);
  },
};
