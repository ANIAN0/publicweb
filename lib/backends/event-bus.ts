import { WebtoolEvent } from '../protocol/events';

// 订阅者回调:eventId 为该事件的缓冲自增 id(供 SSE 发 `id:` 让前端 EventSource 自动重连带 Last-Event-ID)
type Callback = (event: WebtoolEvent, eventId: number) => void;

// 单条缓冲事件:带自增 eventId 供 sinceEventId 回放定位
interface BufferedEvent { id: number; event: WebtoolEvent }

// 每 session 的订阅者 + 环型缓冲(限量,淘汰最旧)
interface SessionState {
  subscribers: Set<Callback>;
  events: BufferedEvent[];   // 环型缓冲,超 BUFFER_LIMIT 淘汰最旧
  lastId: number;            // 自增 eventId
}

// 每 session 缓冲上限(够覆盖 SSE 断开期间事件)
const BUFFER_LIMIT = 1000;

export class EventBus {
  private sessions = new Map<string, SessionState>();

  private ensure(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { subscribers: new Set(), events: [], lastId: 0 };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  // 订阅:先回放缓冲中 eventId > sinceEventId 的事件(SSE 断开期间漏的),再转入实时
  subscribe(sessionId: string, cb: Callback, sinceEventId?: number): () => void {
    const s = this.ensure(sessionId);
    if (sinceEventId !== undefined) {
      for (const be of s.events) {
        if (be.id > sinceEventId) cb(be.event, be.id);
      }
    }
    s.subscribers.add(cb);
    return () => {
      s.subscribers.delete(cb);
    };
  }

  // 发事件:分配自增 eventId,入缓冲(超限淘汰最旧),推订阅者;返回 eventId 供调用方
  emit(sessionId: string, event: WebtoolEvent): number {
    const s = this.ensure(sessionId);
    s.lastId += 1;
    const id = s.lastId;
    s.events.push({ id, event });
    if (s.events.length > BUFFER_LIMIT) {
      s.events.shift();  // 环型限量:淘汰最旧
    }
    for (const cb of s.subscribers) {
      try { cb(event, id); } catch { /* 单个订阅者抛错不影响其他 */ }
    }
    return id;
  }
}

// global 挂载防 HMR 重置(参考 lib/events/session-bus.ts:30-36):subscribers/buffer 跨 HMR 保留
declare global {
  var __eventBus: EventBus | undefined;
}

export const eventBus: EventBus = global.__eventBus ?? new EventBus();
if (!global.__eventBus) global.__eventBus = eventBus;
