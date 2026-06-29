import { WebtoolEvent } from '../protocol/events';

type Callback = (event: WebtoolEvent) => void;

export class EventBus {
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
    if (callbacks) {
      for (const cb of callbacks) {
        cb(event);
      }
    }
  }
}