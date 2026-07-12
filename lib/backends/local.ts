// LocalBackend —— claudecode / pi 的 webtool 侧适配器
// 所有真实工作通过反向 WS 由本地 client 完成;这里只负责:
//   - listTargets:从 device + device_models 缓存读端点与模型
//   - startSession / send / stop:经 sendToDevice 派发到本地 client
//   - onEvent:订阅全局 sessionEventBus（带缓冲回放）
//   - bindRuntime:挂 persist 订阅 + session→device 映射（stop/auto-resume 不拆）
import { BackendAdapter, ModelInfo, ChatMessage, ExecutionTarget, MessageAttachmentRef } from './types';
import { WebtoolEvent, InputResponse } from '@/lib/protocol/events';
import { sessionEventBus } from '@/lib/events/session-bus';
import { sendToDevice } from '@/server/ws/device-connections';
import { getDb } from '@/lib/db/client';
import { devices, deviceSupportedBackends, deviceModels, sessions } from '@/lib/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { readAttachmentBuffer } from '@/lib/attachments/store';
import type { WsAttachmentPayload } from '@/lib/protocol/ws-messages';
import { debugLog } from '@/lib/debug-log';
import { ulid } from 'ulid';
import { generationStream } from '@/lib/events/generation-stream';
import { beginTurnIdle } from '@/lib/events/turn-idle-tracker';

/**
 * LIB-021：persist 失败可观测上报。
 * 导出供单测驱动真实路径，禁止仅 console 吞掉。
 *
 * 禁止再 emit turn.completed 进 sessionEventBus：
 * bindRuntime 的 persist 订阅会再次 persistSessionEvent → getOrCreate 新空 assistant →
 * 再失败 → 再 emit → 雪崩（实测单 turn 可刷出 30+ 条 finishReason=error 的空消息）。
 * UI 已通过同一条总线收到原始 part 流与 turn.completed；落库失败只记日志，不二次伪造 turn 边界。
 */
export function reportPersistFailure(
  sessionId: string,
  eventType: string,
  err: unknown,
): void {
  const msg = err instanceof Error ? err.message : String(err);
  debugLog('local', `persist failed sid=${sessionId} type=${eventType} err=${msg}`);
  console.error(`[local] persist failed sid=${sessionId}:`, err);
}

// HMR 安全：session→device 映射挂 global
declare global {
  // eslint-disable-next-line no-var
  var __localBackendRuntime: {
    sessionToTarget: Map<string, string>;
  } | undefined;
}

function localRuntime() {
  if (!global.__localBackendRuntime) {
    global.__localBackendRuntime = {
      sessionToTarget: new Map(),
    };
  }
  return global.__localBackendRuntime;
}

export class LocalBackend implements BackendAdapter {
  // 构造参数化:claudecode/pi 共用 LocalBackend 实现,靠 id 区分(router 注册时传)
  constructor(
    readonly id: 'claudecode' | 'pi',
    readonly label: string,
    readonly description: string,
  ) {}

  async listTargets(): Promise<ExecutionTarget[]> {
    const db = await getDb();
    const supported = await db.select({ deviceId: deviceSupportedBackends.deviceId })
      .from(deviceSupportedBackends)
      .where(eq(deviceSupportedBackends.backend, this.id));
    if (supported.length === 0) return [];
    const deviceIds = supported.map((s) => s.deviceId);
    const deviceRows = await db.select().from(devices).where(inArray(devices.id, deviceIds));
    const modelRows = await db.select().from(deviceModels)
      .where(and(inArray(deviceModels.deviceId, deviceIds), eq(deviceModels.backend, this.id)));
    const modelsByDevice = new Map<string, ModelInfo[]>();
    for (const row of modelRows) {
      try { modelsByDevice.set(row.deviceId, JSON.parse(row.modelsJson) as ModelInfo[]); }
      catch { modelsByDevice.set(row.deviceId, []); }
    }
    return deviceRows.map((d) => ({
      id: d.id,
      name: d.name,
      online: d.online ?? false,
      models: modelsByDevice.get(d.id) ?? [],
      meta: { hostname: d.hostname ?? '' },
    }));
  }

  /**
   * 绑定 session 运行时：可选映射 target + 挂 persist 订阅。
   * - 幂等：已有订阅则只更新 target，不重复 subscribe（防 delta 双倍）
   * - stop 不调用 release；auto-resume / send 失败路径都会 ensure
   */
  /**
   * 绑定 session→device。权威 persist 已迁到 sessionEventBus.emit 单点（DEF-001），
   * 此处不再 subscribe，避免 HMR/双实例双写 assistant。
   */
  bindRuntime(sessionId: string, targetId?: string): void {
    if (targetId) localRuntime().sessionToTarget.set(sessionId, targetId);
  }

  /**
   * 释放运行时（仅会话删除/彻底销毁时用；stop turn 不要调）
   * LIB-018：同步清 EventBus 缓冲，覆盖销毁路径
   */
  releaseRuntime(sessionId: string): void {
    localRuntime().sessionToTarget.delete(sessionId);
    sessionEventBus.release(sessionId);
    debugLog('local', `releaseRuntime sid=${sessionId}`);
  }

  async startSession(opts: {
    sessionId: string;
    model: string;
    targetId: string;
    history: ChatMessage[];
    cwd?: string;
  }): Promise<void> {
    const db = await getDb();
    const [device] = await db.select().from(devices).where(eq(devices.id, opts.targetId)).limit(1);
    if (!device) throw new Error(`device not found: ${opts.targetId}`);
    // T-009：离线明确可读，禁止静默成功
    if (!device.online) {
      throw new Error(`设备离线（${device.name || opts.targetId}）：请确认 webtool-client 已连接后再试`);
    }

    const [sess] = await db.select({ localSessionRef: sessions.localSessionRef })
      .from(sessions).where(eq(sessions.id, opts.sessionId)).limit(1);

    // 先挂 persist，再下发 start（auto-resume / 首包事件不丢库）
    this.bindRuntime(opts.sessionId, opts.targetId);

    // LIB-020：sendToDevice 返回 false 表示未连接；start/send/respond 必须 throw
    // （调用方/前端靠 HTTP 错误或 emitSendFailure 解锁），禁止静默成功
    const ok = sendToDevice(opts.targetId, {
      type: 'session.start',
      sessionId: opts.sessionId,
      backend: this.id,
      model: opts.model,
      history: opts.history,
      backendSessionRef: sess?.localSessionRef ?? undefined,
      cwd: opts.cwd,
    });
    if (!ok) throw new Error(`device not connected: ${opts.targetId}`);
  }

  /** 解析 session → deviceId（内存映射优先，缺失则回退 DB 并 bind） */
  private async resolveTargetId(sessionId: string): Promise<string | undefined> {
    let targetId = localRuntime().sessionToTarget.get(sessionId);
    if (!targetId) {
      const db = await getDb();
      const [sess] = await db.select({ targetId: sessions.targetId })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      targetId = sess?.targetId ?? undefined;
      if (targetId) this.bindRuntime(sessionId, targetId);
    }
    return targetId;
  }

  /**
   * 投递失败时：保证 bus 有订阅者看到 turn.completed，解锁 UI 并落库
   * （HTTP 已 201 时前端只等 SSE）
   */
  private emitSendFailure(sessionId: string, code: string, message: string): void {
    // 确保 persist + SSE 订阅能收到（startSession 从未成功时也要解锁 UI）
    this.bindRuntime(sessionId);

    sessionEventBus.emit(sessionId, {
      type: 'error',
      errorText: `${code}: ${message}`,
    });
  }

  async send(
    sessionId: string,
    content: string,
    opts?: { attachments?: MessageAttachmentRef[]; runId?: string },
  ): Promise<void> {
    try {
      const targetId = await this.resolveTargetId(sessionId);
      if (!targetId) throw new Error(`session ${sessionId} not bound to a target`);

      let attachments: WsAttachmentPayload[] | undefined;
      if (opts?.attachments?.length) {
        attachments = [];
        for (const ref of opts.attachments) {
          const buf = await readAttachmentBuffer(sessionId, ref.id);
          if (!buf) {
            throw new Error(`attachment not found: ${ref.id}`);
          }
          attachments.push({
            id: ref.id,
            filename: ref.filename || buf.filename,
            mediaType: ref.mediaType || 'application/octet-stream',
            dataBase64: buf.data.toString('base64'),
          });
        }
      }

      // D-006：中心在 turn send 路径分配 runId 并下发；执行端上行必须带回（禁止 client 自 mint）
      const runId = opts?.runId ?? ulid();
      // T-002b：打开生成流缓冲（仅用于展示续接，不承担业务超时）
      generationStream.openRun(sessionId, runId);
      // T-006：开始 idle 计时
      beginTurnIdle(sessionId);

      const ok = sendToDevice(targetId, {
        type: 'session.send',
        sessionId,
        content,
        runId,
        ...(attachments?.length ? { attachments } : {}),
      });
      if (!ok) throw new Error(`device not connected: ${targetId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emitSendFailure(sessionId, 'send_failed', msg);
      throw err;
    }
  }

  async respondInput(sessionId: string, responses: InputResponse[]): Promise<void> {
    try {
      const targetId = await this.resolveTargetId(sessionId);
      if (!targetId) throw new Error(`session ${sessionId} not bound to a target`);
      if (!responses.length) throw new Error('respondInput requires non-empty responses');
      const ok = sendToDevice(targetId, { type: 'session.respondInput', sessionId, responses });
      if (!ok) throw new Error(`device not connected: ${targetId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emitSendFailure(sessionId, 'respond_input_failed', msg);
      throw err;
    }
  }

  /**
   * 仅取消当前 turn（F-009）：下发 session.stop，不拆 persist、不卸映射
   * 否则后续 turn 事件静默丢库。
   * 同时服务端兜底 emit turn.completed(interrupted)：client 事件丢失时仍清 pending、解锁 UI。
   */
  async stop(sessionId: string): Promise<void> {
    const targetId = await this.resolveTargetId(sessionId);
    if (targetId) {
      // stop 尽力投递：设备已断线时无 throw（UI 已本地 interrupt）
      sendToDevice(targetId, { type: 'session.stop', sessionId });
    }
    // 确保 persist + SSE 能收到；client 可能未上行 interrupted
    // 仅显式 stop API 路径；禁止 reload/SSE 隐式调用本方法
    this.bindRuntime(sessionId);
    sessionEventBus.emit(sessionId, {
      type: 'abort',
      reason: 'user_stop',
    });
  }

  /**
   * LIB-019：薄封装有意为之——local 事件权威源是 sessionEventBus
   * （device-gateway 收 client 上行后 emit），adapter 不二次缓冲。
   * 与 eveagent.onEvent → eventBus 对称，仅总线实例不同。
   */
  onEvent(
    sessionId: string,
    cb: (e: WebtoolEvent, eventId: number) => void,
    sinceEventId?: number,
  ): () => void {
    // 转发缓冲回放；SSE 可带 Last-Event-ID
    return sessionEventBus.subscribe(
      sessionId,
      (event, eventId) => cb(event, eventId),
      sinceEventId,
    );
  }
}
