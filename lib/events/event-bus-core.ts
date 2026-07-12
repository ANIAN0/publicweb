// EventBus 共享实现（LIB-001）：eve / local 双实例有意隔离，仅抽公共实现
// 禁止合并为全局单总线；调用方各自 new + globalThis 挂载
import type { WebtoolEvent } from '../protocol/events';

// 订阅者回调：eventId 供 SSE `id:` 与 Last-Event-ID 重连
export type EventBusCallback = (event: WebtoolEvent, eventId: number, runId?: string) => void;

interface BufferedEvent {
  id: number;
  event: WebtoolEvent;
  runId?: string;
}

interface SessionState {
  subscribers: Set<EventBusCallback>;
  events: BufferedEvent[];
  lastId: number;
}

// 每 session 缓冲上限（够覆盖 SSE 断开期间事件）
const DEFAULT_BUFFER_LIMIT = 1000;

/**
 * 环状缓冲 + sinceEventId 回放的会话事件总线。
 * eve 与 local 各持有独立实例，状态互不共享。
 */
export class EventBusCore {
  private sessions = new Map<string, SessionState>();

  constructor(private readonly bufferLimit = DEFAULT_BUFFER_LIMIT) {}

  private ensure(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { subscribers: new Set(), events: [], lastId: 0 };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  /** 订阅：若带 sinceEventId，先回放缓冲中 id 更大的事件，再收实时推送 */
  subscribe(sessionId: string, cb: EventBusCallback, sinceEventId?: number): () => void {
    const s = this.ensure(sessionId);
    if (sinceEventId !== undefined) {
      for (const be of s.events) {
        if (be.id > sinceEventId) {
          try {
            cb(be.event, be.id, be.runId);
          } catch {
            /* 回放单条失败不影响后续 */
          }
        }
      }
    }
    s.subscribers.add(cb);
    return () => {
      s.subscribers.delete(cb);
    };
  }

  /** 发事件：入缓冲并推订阅者；返回 eventId */
  emit(sessionId: string, event: WebtoolEvent, runId?: string): number {
    const s = this.ensure(sessionId);
    s.lastId += 1;
    const id = s.lastId;
    s.events.push({ id, event, runId });
    if (s.events.length > this.bufferLimit) {
      s.events.shift();
    }
    for (const cb of s.subscribers) {
      try {
        cb(event, id, runId);
      } catch {
        /* 单个订阅者抛错不影响其他 */
      }
    }
    return id;
  }

  /** 释放某 session 缓冲与订阅（会话删除时调用，防内存增长） */
  release(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** 测试用：当前 session 数 */
  sessionCount(): number {
    return this.sessions.size;
  }

  /** Current session cursor without creating a replay side effect. */
  getLastId(sessionId: string): number {
    return this.ensure(sessionId).lastId;
  }
}
