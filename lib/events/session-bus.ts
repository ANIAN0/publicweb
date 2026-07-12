// Local/device 侧 session 事件总线 —— 与 event-bus 共享 EventBusCore 实现，实例隔离（LIB-001）
// device-gateway 收本地 client 上行 session.event 时 push；SSE 经 LocalBackend.onEvent 订阅
// T-002b：emit 时同步 publish 到 generation-stream（run 级 seq 缓冲，展示续接）
// DEF-001：权威 persist 只在 emit 单点执行，禁止 LocalBackend 再 subscribe 一份（HMR 双订阅会双写 assistant）
import type { WebtoolEvent } from '../protocol/events';
import { EventBusCore } from './event-bus-core';
import { generationStream } from './generation-stream';
import { noteTurnEvent } from './turn-idle-tracker';
import { persistSessionEvent } from '@/lib/backends/persist';
import { debugLog } from '@/lib/debug-log';

declare global {
  // 避免 Next.js HMR 反复 new 丢缓冲
  // eslint-disable-next-line no-var
  var __sessionEventBus: EventBusCore | undefined;
  // sessionId → 串行 persist 链（防 messages.seq UNIQUE 撞车）
  // eslint-disable-next-line no-var
  var __sessionPersistChains: Map<string, Promise<void>> | undefined;
}

const core: EventBusCore = global.__sessionEventBus ?? new EventBusCore();
if (!global.__sessionEventBus) global.__sessionEventBus = core;

function persistChains(): Map<string, Promise<void>> {
  if (!global.__sessionPersistChains) global.__sessionPersistChains = new Map();
  return global.__sessionPersistChains;
}

/** emit 后串行落库（唯一权威路径） */
function enqueuePersist(sessionId: string, event: WebtoolEvent, runId?: string): void {
  const chains = persistChains();
  const prev = chains.get(sessionId) ?? Promise.resolve();
  const next = prev
    .then(() => persistSessionEvent(sessionId, event, runId))
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      debugLog('local', `persist failed sid=${sessionId} type=${(event as { type?: string }).type} err=${msg}`);
      console.error(`[session-bus] persist failed sid=${sessionId}:`, err);
    });
  chains.set(sessionId, next);
}

/**
 * 包装后的总线：行为与 EventBusCore 一致，额外在 emit 时写入 generation-stream + 权威 persist。
 * eventId 仍为 session 级总线 id；run 级 seq 见 generationStream.publish 返回值 / SSE 包装。
 */
export const sessionEventBus = {
  subscribe: core.subscribe.bind(core) as EventBusCore['subscribe'],
  release: core.release.bind(core) as EventBusCore['release'],
  sessionCount: core.sessionCount.bind(core) as EventBusCore['sessionCount'],
  emit(sessionId: string, event: WebtoolEvent, runIdHint?: string): number {
    const effectiveRunId = runIdHint ?? generationStream.getActiveRunId(sessionId);
    // 展示缓冲：有活跃 run 则赋 seq（无则 skip，不阻塞权威路径）
    try {
      generationStream.publish(sessionId, event, runIdHint);
    } catch (err) {
      console.error('[session-bus] generationStream.publish failed:', err);
    }
    // T-006：刷新 idle 计时
    try {
      noteTurnEvent(sessionId, event);
    } catch {
      /* ignore */
    }
    // 权威落库：单点串行（DEF-001）
    enqueuePersist(sessionId, event, effectiveRunId);
    return core.emit(sessionId, event);
  },
};
