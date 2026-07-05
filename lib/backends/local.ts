// LocalBackend —— claudecode / pi 的 webtool 侧适配器
// 所有真实工作通过反向 WS 由本地 client 完成；这里只负责：
//   - listModels / listModelsByBackend：从 device_models 缓存读
//   - startSession / send / stop：经 sendToDevice 派发到本地 client
//   - onEvent：订阅全局 sessionEventBus（device-gateway 收到 client 上行时推）
//
// 设计：startSession 记录 sessionId → deviceId 内存映射，send/stop 走映射
// 而不查 DB（避免每个 turn 多一次 IO；也允许纯单元测试不必先建 DB 行）。
import { BackendAdapter, ModelInfo, ChatMessage } from './types';
import { WebtoolEvent } from '@/lib/protocol/events';
import { sessionEventBus } from '@/lib/events/session-bus';
import { sendToDevice } from '@/server/ws/device-gateway';
import { getDb } from '@/lib/db/client';
import { devices, deviceSupportedBackends, deviceModels, sessions } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { persistSessionEvent } from './persist';

export class LocalBackend implements BackendAdapter {
  // 声明 id 为 'claudecode'（pi 也共用此实现；router 在 backend 名为 'pi' 时返回同一 LocalBackend 实例）
  readonly id = 'claudecode' as const;
  // sessionId → deviceId（startSession 时记录，stop 时移除）
  private sessionToDevice = new Map<string, string>();
  // sessionId → EventBus unsubscribe（startSession 时挂订阅，stop 时清理）
  // 修复 REV-005-1（BLOCKER）：订阅全局事件总线，把 client 上行的 session.event 落库。
  // 之前这条路径只发 SSE 不入库——历史刷新全丢。这是 webtool 成为会话权威源的关键。
  private sessionUnsubscribers = new Map<string, () => void>();

  async listModels(deviceId?: string): Promise<ModelInfo[]> {
    if (!deviceId) return [];
    // 委托给 listModelsByBackend 聚合（避免重复解析逻辑）
    const db = await getDb();
    const rows = await db.select({ backend: deviceSupportedBackends.backend })
      .from(deviceSupportedBackends)
      .where(eq(deviceSupportedBackends.deviceId, deviceId));
    const all: ModelInfo[] = [];
    for (const { backend } of rows) {
      const ms = await this.listModelsByBackend(deviceId, backend);
      all.push(...ms);
    }
    return all;
  }

  async listModelsByBackend(deviceId: string, backend: string): Promise<ModelInfo[]> {
    const db = await getDb();
    const [row] = await db.select().from(deviceModels)
      .where(and(eq(deviceModels.deviceId, deviceId), eq(deviceModels.backend, backend)));
    if (!row) return [];
    try { return JSON.parse(row.modelsJson) as ModelInfo[]; }
    catch { return []; }
  }

  async startSession(opts: { sessionId: string; model: string; history: ChatMessage[]; deviceId?: string; backend?: 'claudecode' | 'pi' }): Promise<void> {
    if (!opts.deviceId) throw new Error('LocalBackend.startSession requires deviceId');
    const db = await getDb();
    const [device] = await db.select().from(devices).where(eq(devices.id, opts.deviceId)).limit(1);
    if (!device) throw new Error(`device not found: ${opts.deviceId}`);
    if (!device.online) throw new Error(`device offline: ${opts.deviceId}`);

    // 优先用 opts.backend；没有就回退 'claudecode'（兼容旧调用方）
    const backend = opts.backend ?? 'claudecode';

    const ok = sendToDevice(opts.deviceId, {
      type: 'session.start',
      sessionId: opts.sessionId,
      backend,
      model: opts.model,
      history: opts.history,
    });
    if (!ok) throw new Error(`device not connected: ${opts.deviceId}`);

    this.sessionToDevice.set(opts.sessionId, opts.deviceId);

    // 订阅全局事件总线：device-gateway 收到 client 上行的 session.event 后会 emit，
    // 这里订阅一份用于持久化（修复 REV-005-1）。失败也不影响 sendToDevice 已成功。
    const unsub = sessionEventBus.subscribe(opts.sessionId, (event: WebtoolEvent) => {
      persistSessionEvent(opts.sessionId, event).catch((err) => {
        console.error(`[local] persist failed sid=${opts.sessionId}:`, err);
      });
    });
    this.sessionUnsubscribers.set(opts.sessionId, unsub);
  }

  async send(sessionId: string, content: string): Promise<void> {
    // 优先用内存映射；缺失时回退查 sessions.deviceId（修复 REV-005-2 + REV-005-1 联动的依赖：
    // webtool 重启 / 设备重连后 sendToDevice 会推送 session.start，但 LocalBackend 内存
    // 里的 sessionToDevice 是空的；下一个 turn 仍能根据 DB 找到 deviceId 把消息送出去）。
    let deviceId = this.sessionToDevice.get(sessionId);
    if (!deviceId) {
      const db = await getDb();
      const [sess] = await db.select({ deviceId: sessions.deviceId })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      deviceId = sess?.deviceId ?? undefined;
      if (deviceId) this.sessionToDevice.set(sessionId, deviceId);
    }
    if (!deviceId) throw new Error(`session ${sessionId} not bound to a device`);
    const ok = sendToDevice(deviceId, { type: 'session.send', sessionId, content });
    if (!ok) throw new Error(`device not connected: ${deviceId}`);
  }

  async stop(sessionId: string): Promise<void> {
    let deviceId = this.sessionToDevice.get(sessionId);
    if (!deviceId) {
      const db = await getDb();
      const [sess] = await db.select({ deviceId: sessions.deviceId })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      deviceId = sess?.deviceId ?? undefined;
      if (deviceId) this.sessionToDevice.set(sessionId, deviceId);
    }
    if (!deviceId) return;
    sendToDevice(deviceId, { type: 'session.stop', sessionId });
    this.sessionToDevice.delete(sessionId);
    // 清理事件订阅；防止 session 删了订阅还残留导致内存泄漏
    this.sessionUnsubscribers.get(sessionId)?.();
    this.sessionUnsubscribers.delete(sessionId);
  }

  onEvent(sessionId: string, cb: (e: WebtoolEvent) => void): () => void {
    return sessionEventBus.subscribe(sessionId, cb);
  }
}
