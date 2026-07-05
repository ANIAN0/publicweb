// 全局 session 事件总线：device-gateway 收本地 client 上行的 session.event 时 push，
// SSE 端点（通过 LocalBackend.onEvent）订阅。
// 与 lib/backends/event-bus.ts 区别：那个是 EveagentBackend 内部私用（避免互相干扰）。
import { WebtoolEvent } from '@/lib/protocol/events';

type Callback = (event: WebtoolEvent) => void;

class SessionEventBus {
  private subscribers = new Map<string, Set<Callback>>();

  subscribe(sessionId: string, cb: Callback): () => void {
    if (!this.subscribers.has(sessionId)) {
      this.subscribers.set(sessionId, new Set());
    }
    this.subscribers.get(sessionId)!.add(cb);
    return () => {
      this.subscribers.get(sessionId)?.delete(cb);
    };
  }

  emit(sessionId: string, event: WebtoolEvent): void {
    const callbacks = this.subscribers.get(sessionId);
    if (!callbacks) return;
    for (const cb of callbacks) {
      try { cb(event); } catch { /* 单个订阅者抛错不影响其他 */ }
    }
  }
}

declare global {
  // 避免 Next.js HMR 反复 new
  var __sessionEventBus: SessionEventBus | undefined;
}

export const sessionEventBus: SessionEventBus = global.__sessionEventBus ?? new SessionEventBus();
if (!global.__sessionEventBus) global.__sessionEventBus = sessionEventBus;
