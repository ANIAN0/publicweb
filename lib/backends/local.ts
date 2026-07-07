// LocalBackend —— claudecode / pi 的 webtool 侧适配器
// 所有真实工作通过反向 WS 由本地 client 完成;这里只负责:
//   - listTargets:从 device + device_models 缓存读端点与模型
//   - startSession / send / stop:经 sendToDevice 派发到本地 client
//   - onEvent:订阅全局 sessionEventBus
//
// 设计:startSession 记录 sessionId → targetId(deviceId) 内存映射,send/stop 走映射
// 而不查 DB(避免每个 turn 多一次 IO)。
import { BackendAdapter, ModelInfo, ChatMessage, ExecutionTarget } from './types';
import { WebtoolEvent, InputResponse } from '@/lib/protocol/events';
import { sessionEventBus } from '@/lib/events/session-bus';
import { sendToDevice } from '@/server/ws/device-gateway';
import { getDb } from '@/lib/db/client';
import { devices, deviceSupportedBackends, deviceModels, sessions } from '@/lib/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { persistSessionEvent } from './persist';

export class LocalBackend implements BackendAdapter {
  // 构造参数化:claudecode/pi 共用 LocalBackend 实现,靠 id 区分(router 注册时传)
  constructor(
    readonly id: 'claudecode' | 'pi',
    readonly label: string,
    readonly description: string,
  ) {}

  // sessionId → targetId(deviceId),startSession 时记录,stop 时移除
  private sessionToTarget = new Map<string, string>();
  // sessionId → EventBus unsubscribe(startSession 时挂订阅,stop 时清理)
  private sessionUnsubscribers = new Map<string, () => void>();

  async listTargets(): Promise<ExecutionTarget[]> {
    const db = await getDb();
    // 查所有支持 this.id 后端的设备 id
    const supported = await db.select({ deviceId: deviceSupportedBackends.deviceId })
      .from(deviceSupportedBackends)
      .where(eq(deviceSupportedBackends.backend, this.id));
    if (supported.length === 0) return [];
    const deviceIds = supported.map((s) => s.deviceId);
    // 设备详情
    const deviceRows = await db.select().from(devices).where(inArray(devices.id, deviceIds));
    // 每个设备该后端的模型列表(从 device_models 缓存读)
    const modelRows = await db.select().from(deviceModels)
      .where(and(inArray(deviceModels.deviceId, deviceIds), eq(deviceModels.backend, this.id)));
    const modelsByDevice = new Map<string, ModelInfo[]>();
    for (const row of modelRows) {
      try { modelsByDevice.set(row.deviceId, JSON.parse(row.modelsJson) as ModelInfo[]); }
      catch { modelsByDevice.set(row.deviceId, []); }
    }
    // 组装端点:每个设备一个 target,models 是该设备该后端的模型列表(通常多个)
    return deviceRows.map((d) => ({
      id: d.id,
      name: d.name,
      online: d.online ?? false,
      models: modelsByDevice.get(d.id) ?? [],
      meta: { hostname: d.hostname ?? '' },
    }));
  }

  async startSession(opts: { sessionId: string; model: string; targetId: string; history: ChatMessage[] }): Promise<void> {
    const db = await getDb();
    const [device] = await db.select().from(devices).where(eq(devices.id, opts.targetId)).limit(1);
    if (!device) throw new Error(`device not found: ${opts.targetId}`);
    if (!device.online) throw new Error(`device offline: ${opts.targetId}`);

    // 读 sessions.localSessionRef 透传给 client 走 resume（reload 续接）
    const [sess] = await db.select({ localSessionRef: sessions.localSessionRef })
      .from(sessions).where(eq(sessions.id, opts.sessionId)).limit(1);

    const ok = sendToDevice(opts.targetId, {
      type: 'session.start',
      sessionId: opts.sessionId,
      backend: this.id,           // 用 this.id 区分 claudecode/pi(不再靠 opts.backend hack)
      model: opts.model,
      history: opts.history,
      backendSessionRef: sess?.localSessionRef ?? undefined,  // 透传 resume 引用
    });
    if (!ok) throw new Error(`device not connected: ${opts.targetId}`);

    this.sessionToTarget.set(opts.sessionId, opts.targetId);

    // 订阅全局事件总线:device-gateway 收到 client 上行的 session.event 后 emit,
    // 这里订阅一份用于持久化(修复 REV-005-1)。失败不影响 sendToDevice 已成功。
    const unsub = sessionEventBus.subscribe(opts.sessionId, (event: WebtoolEvent) => {
      persistSessionEvent(opts.sessionId, event).catch((err) => {
        console.error(`[local] persist failed sid=${opts.sessionId}:`, err);
      });
    });
    this.sessionUnsubscribers.set(opts.sessionId, unsub);
  }

  // local(claudecode/pi)的 HITL 走 Claude Code 自有 AskUserQuestion 格式(questions 数组),
  // 与 eve 的 inputResponses 不同路线;opts.inputResponses 透传到 client 由 adapter 解释
  async send(sessionId: string, content: string, opts?: { inputResponses?: InputResponse[] }): Promise<void> {
    // 优先用内存映射;缺失时回退查 sessions.targetId(webtool 重启/设备重连后内存映射空)
    let targetId = this.sessionToTarget.get(sessionId);
    if (!targetId) {
      const db = await getDb();
      const [sess] = await db.select({ targetId: sessions.targetId })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      targetId = sess?.targetId ?? undefined;
      if (targetId) this.sessionToTarget.set(sessionId, targetId);
    }
    if (!targetId) throw new Error(`session ${sessionId} not bound to a target`);
    // 透传 inputResponses（HITL 回答）到 client
    const ok = sendToDevice(targetId, { type: 'session.send', sessionId, content, inputResponses: opts?.inputResponses });
    if (!ok) throw new Error(`device not connected: ${targetId}`);
  }

  async stop(sessionId: string): Promise<void> {
    let targetId = this.sessionToTarget.get(sessionId);
    if (!targetId) {
      const db = await getDb();
      const [sess] = await db.select({ targetId: sessions.targetId })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      targetId = sess?.targetId ?? undefined;
      if (targetId) this.sessionToTarget.set(sessionId, targetId);
    }
    if (!targetId) return;
    sendToDevice(targetId, { type: 'session.stop', sessionId });
    this.sessionToTarget.delete(sessionId);
    // 清理事件订阅;防止 session 删了订阅还残留导致内存泄漏
    this.sessionUnsubscribers.get(sessionId)?.();
    this.sessionUnsubscribers.delete(sessionId);
  }

  onEvent(sessionId: string, cb: (e: WebtoolEvent, eventId?: number) => void, sinceEventId?: number): () => void {
    // LocalBackend 忽略 sinceEventId(sessionEventBus 无缓冲回放,保持现状);cb 签名兼容(eventId 传 undefined)
    return sessionEventBus.subscribe(sessionId, cb);
  }
}
