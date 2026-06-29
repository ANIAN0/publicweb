import { describe, it, expect } from 'vitest';
import { EventBus } from '@/lib/backends/event-bus';

describe('EventBus', () => {
  it('emit 事件给所有订阅者，unsubscribe 后不收', () => {
    const bus = new EventBus();
    const received1: any[] = [];
    const received2: any[] = [];
    const unsub1 = bus.subscribe('session1', (event) => received1.push(event));
    const unsub2 = bus.subscribe('session1', (event) => received2.push(event));
    bus.emit('session1', { type: 'text.delta', data: { delta: 'hello' } });
    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
    unsub1();
    bus.emit('session1', { type: 'text.delta', data: { delta: 'world' } });
    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(2);
  });
});