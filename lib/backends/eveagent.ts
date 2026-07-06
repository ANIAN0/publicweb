import { Client, MessageResponse } from 'eve/client';
import { BackendAdapter, ChatMessage, ExecutionTarget } from './types';
import { WebtoolEvent, type WebtoolMessageMetadata, type InputResponse } from '../protocol/events';
import { eventBus } from './event-bus';
import { getDb } from '../db/client';
import { sessions, messages, eveServices } from '../db/schema';
import { eq, and, asc, desc } from 'drizzle-orm';
import { persistSessionEvent, extractTextFromParts } from './persist';
import { isPendingStale } from './pending';
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// [eve] 调试日志：追加到 workplace/logs/eve-YYYYMMDD.log（AGENTS.md 第 13 条调试策略）
// 同步追加写，日志失败静默吞掉，不影响主流程
function eveLog(msg: string): void {
  const ts = new Date().toISOString();
  const day = ts.slice(0, 10);
  try {
    const dir = join(process.cwd(), '..', 'workplace', 'logs');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `eve-${day}.log`), `${ts} [eve] ${msg}\n`, 'utf8');
  } catch { /* 日志失败不影响主流程 */ }
}

// 从 db 行的 authType + authConfig 构造 eve ClientOptions 的 auth / headers(明文 token 从 authConfig JSON 读)
//   bearer → { auth: { bearer: token } }         注入 Authorization: Bearer <token>
//   headers → { headers: Record<string,string> } 注入自定义请求头(如 x-api-key)
//   none   → {}                                  无认证
// 返回结构对齐 eve ClientAuth/HeadersValue(eve client #resolveAuthHeaders/#resolveHeaders 消费)
function buildClientOptions(authType: string, authConfig: string | null): { auth?: { bearer: string }; headers?: Record<string, string> } {
  if (!authConfig) return {};
  let cfg: any;
  try { cfg = JSON.parse(authConfig); } catch { return {}; }  // 损坏配置当无 auth
  if (authType === 'bearer' && typeof cfg?.token === 'string' && cfg.token.length > 0) {
    return { auth: { bearer: cfg.token } };
  }
  if (authType === 'headers' && cfg?.headers && typeof cfg.headers === 'object') {
    return { headers: cfg.headers as Record<string, string> };
  }
  return {};
}

// 剥离 action,只保留前端 UI 可见的 inputRequest 字段(对齐 eve client toMessageInputRequest)
// 前端 InputRequestCard 据此渲染:prompt 问题文案 + display 三态 + options 选项 + allowFreeform 自定义文本
// 注意:options 用 mutable 数组(AI SDK toolMetadata 是 JSONValue,不接受 readonly JSONArray)
function toMessageInputRequest(request: any): {
  requestId: string;
  prompt: string;
  display?: 'confirmation' | 'select' | 'text';
  options?: { id: string; label: string; description?: string; style?: 'danger' | 'default' | 'primary' }[];
  allowFreeform?: boolean;
} {
  return {
    requestId: request.requestId,
    prompt: request.prompt,
    ...(request.display !== undefined ? { display: request.display } : {}),
    ...(request.options !== undefined ? { options: request.options } : {}),
    ...(request.allowFreeform !== undefined ? { allowFreeform: request.allowFreeform } : {}),
  };
}

/**
 * EveagentBackend — bridges webtool sessions with eve HTTP servers.
 *
 * 一个 eve 部署 = 一个 root agent = 一个 model(部署时 agent.ts 写死),
 * 所以每个 eve 服务(target)绑死一个模型,客户端不能选模型——选模型 = 选 eve 服务。
 * 多个 eve 服务(不同部署/不同模型)通过 eve_services 表管理,listTargets 从表读。
 */
export class EveagentBackend implements BackendAdapter {
  readonly id = 'eveagent' as const;
  readonly label = 'Eveagent';
  readonly description = '远程云端 agent';

  // serviceId → {client, host, authKey}:按 eve 服务缓存 Client。auth/host 变更(PATCH 后)下次 getClient 自动重建。
  private clients = new Map<string, { client: Client; host: string; authKey: string }>();
  // Per-webtool-session serialization: queue sends so each turn's response is
  // fully consumed before the next send() goes out. The eve docs require this:
  // "send one follow-up at a time and wait for the next session.waiting event".
  private turnChain = new Map<string, Promise<void>>();
  // Per-session AbortController：send 时建一个，stop 时 abort()，runTurn 结束后清理
  private abortControllers = new Map<string, AbortController>();
  // Per-session resume 锁:resume 进行中标记,防 SSE 重连触发并发 resume 重复追回(HIGH-1 防并发精神延伸)
  private resuming = new Set<string>();
  // 当前 turn 状态:turnId 用于 partId 合成(${turnId}:${stepIndex}:type),startedParts 记录已 part.start 的 partId(避免重复 start),turnEnded 去重边界事件
  private turnState = new Map<string, { turnId: string | null; startedParts: Set<string>; turnEnded: boolean }>();

  async listTargets(): Promise<ExecutionTarget[]> {
    const db = await getDb();
    const rows = await db.select().from(eveServices);
    // 并发探活每个服务:任何 HTTP 响应都算在线(服务在响应,即使需 auth),
    // 只有网络错误/超时才算离线
    const targets = await Promise.all(rows.map(async (svc) => {
      // 按 serviceId 取(或建)带 auth 的 Client,probe 走 client.fetch 自动注入 auth 头
      const client = this.getClient(svc.id, svc.host, svc.authType, svc.authConfig);
      const online = await this.probe(client);
      return {
        id: svc.id,
        name: svc.name,
        online,
        // 一个 eve 服务绑死一个模型(部署时写死),models 单元素
        models: [{ id: svc.model, label: svc.model, isDefault: true }],
        meta: { host: svc.host },
      } as ExecutionTarget;
    }));
    return targets;
  }

  // 探活:client.fetch /info(走 #resolveHeaders 自动注入 auth 头),任何 HTTP 响应 = 在线,网络错误/超时 = 离线。
  // 用 client.fetch 而非 client.info():info() 校验响应体 schema,401/非 JSON 抛错;fetch 只发请求不校验,符合"任何响应=在线"。
  // 超时 10s:云端 eve(hf.space)首次请求含 DNS+TLS 握手+冷启动,2s 易误判离线
  // (实测首次 ~2s+ 超时,热连接 ~1.8s)。probe 并发(Promise.all),10s 是总上限非 N×10s。
  private async probe(client: Client): Promise<boolean> {
    try {
      await client.fetch('/info', { signal: AbortSignal.timeout(10000) });
      return true;
    } catch {
      return false;
    }
  }

  async startSession(opts: { sessionId: string; model: string; targetId: string; history: ChatMessage[] }): Promise<void> {
    // targetId = eve_service.id,校验服务存在。
    // model 由服务端绑定(eve 不接受 client 传 model),这里仅由调用方记录到 sessions.model(展示用)。
    // host+auth 不在此记:runTurn/resume 统一从 db 读 service 行(含 authType/authConfig),无内存映射。
    const { sessionId, targetId } = opts;
    const db = await getDb();
    const [svc] = await db.select().from(eveServices).where(eq(eveServices.id, targetId)).limit(1);
    if (!svc) throw new Error(`eve service not found: ${targetId}`);
    // 校验 session 行存在(原逻辑)
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!session) throw new Error(`Session ${sessionId} not found`);
  }

  async send(sessionId: string, content: string, opts?: { inputResponses?: InputResponse[] }): Promise<void> {
    // 取消上一次未结束的 controller（防御性，正常 UI 不会在跑时再点发送）
    const prev = this.turnChain.get(sessionId) ?? Promise.resolve();
    const controller = new AbortController();
    this.abortControllers.set(sessionId, controller);
    // HITL 回答(inputResponses)透传到 runTurn → clientSession.send;eve 同 session 续接(durable)
    const inputResponses = opts?.inputResponses;

    // host+auth 由 runTurn 从 db 读 service 行获取(sessions.targetId → eve_services),无需内存映射
    const next = prev.then(() => this.runTurn(sessionId, content, controller.signal, inputResponses)).catch((err) => {
      // abort 抛 AbortError 是预期路径，不打 ERROR 噪音
      if (err?.name !== 'AbortError') {
        console.error(`[eveagent] turn error sid=${sessionId}:`, err);
      }
    }).finally(() => {
      // 收尾：仅当仍是同一个 controller 时清理（防止 stop 后 send 又覆盖）
      if (this.abortControllers.get(sessionId) === controller) {
        this.abortControllers.delete(sessionId);
      }
    });
    this.turnChain.set(sessionId, next);
    return next;
  }

  private async runTurn(sessionId: string, content: string, signal: AbortSignal, inputResponses?: InputResponse[]): Promise<void> {
    const db = await getDb();
    const history = await this.loadHistoryForContext(sessionId);

    // 读 session 行:resume 标识 + targetId(= eve_service.id,用于取 host+auth)
    const [sessRow] = await db.select({
      eveSessionId: sessions.eveSessionId,
      eveContinuationToken: sessions.eveContinuationToken,
      streamIndex: sessions.streamIndex,
      targetId: sessions.targetId,
    }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!sessRow) throw new Error(`Session ${sessionId} not found`);

    // 取 eve 服务(host + auth),按 serviceId 缓存带 auth 的 Client
    const [svc] = await db.select({ host: eveServices.host, authType: eveServices.authType, authConfig: eveServices.authConfig })
      .from(eveServices).where(eq(eveServices.id, sessRow.targetId)).limit(1);
    if (!svc) throw new Error(`eve service not found: ${sessRow.targetId}`);
    const client = this.getClient(sessRow.targetId, svc.host, svc.authType, svc.authConfig);

    // resume eve durable session:从 db 取上次 turn 持久化的 sessionId + continuationToken,
    // 喂给 client.session(state)。否则每次 client.session() 都新建会话,HITL 回答(inputResponses-only)
    // 无 continuationToken,createHandleMessageBody 命中 "continuationToken===undefined && message===undefined"
    // 返回 null,抛 "Session.send requires a non-empty message, inputResponses, or both"
    // (eve client/session.ts:345-355:inputResponses 必须配 continuationToken 才能构造 body)
    // streamIndex 从 db 读(替代硬编码 0):eve client #createEventStream 用 state.streamIndex 作 startIndex 续接(session.ts:166)
    const sessionState = sessRow.eveSessionId
      ? { sessionId: sessRow.eveSessionId, continuationToken: sessRow.eveContinuationToken ?? undefined, streamIndex: sessRow.streamIndex ?? 0 }
      : undefined;
    if (sessionState) {
      eveLog(`resume sid=${sessionId} eveSessionId=${sessionState.sessionId} hasToken=${sessionState.continuationToken !== undefined} streamIndex=${sessionState.streamIndex} inputResponsesLen=${inputResponses?.length ?? 0}`);
    }
    const clientSession = client.session(sessionState);
    // eventCount 对齐 eve client currentStreamIndex(session.ts:182):从 db streamIndex 起始,每消费一个 eve event +1
    const eventCountStart = sessRow.streamIndex ?? 0;

    const clientContext = history.length > 0
      ? JSON.stringify(history.map((m) => ({ role: m.role, content: m.content })))
      : undefined;

    // [eve] 记录请求：host + content 预览 + history 条数 + clientContext 长度 + inputResponses 条数
    eveLog(`runTurn sid=${sessionId} host=${svc.host} content=${JSON.stringify(content.slice(0, 50))} historyLen=${history.length} clientContextLen=${clientContext?.length ?? 0} inputResponsesLen=${inputResponses?.length ?? 0}`);

    // eve client send 允许只有 inputResponses 无 message(HITL 回答);content 为空时传 undefined
    // (session.ts 校验:message 或 inputResponses 至少一个非空)
    const response: MessageResponse = await clientSession.send({
      message: content || undefined,
      signal,
      ...(inputResponses?.length ? { inputResponses } : {}),
      ...(clientContext ? { clientContext } : {}),
    });

    // [eve] 记录 eve 返回的 session 标识（用于诊断 resume / continuation）
    eveLog(`response sid=${sessionId} eveSessionId=${response.sessionId ?? '-'} continuationToken=${response.continuationToken ?? '-'}`);

    // Persist the latest eve identifiers for diagnostics / future resume work.
    if (response.sessionId) {
      await db.update(sessions)
        .set({
          eveSessionId: response.sessionId,
          eveContinuationToken: response.continuationToken ?? null,
        })
        .where(eq(sessions.id, sessionId));
    }

    // 消费 NDJSON 流 + 按结果分发(异常/abort/正常)。Single-use MessageResponse:iterate to consume
    // the stream and advance the client cursor. Loop exits on turn boundary or signal abort.
    const { eventCount: finalCount, aborted, error } = await this.consumeStream(sessionId, response, signal, eventCountStart);
    if (error && error.name !== 'AbortError' && !aborted) {
      // 非 abort 异常:emit+persist turn.completed(error) 解前端 isSending,再抛出(send.catch 吞)
      await this.handleTurnError(sessionId, error, finalCount);
      throw error;
    }
    if (aborted) {
      // 主动停止:写 interrupted + emit turn.completed(interrupted) 让前端解开 isSending
      await this.handleAbort(sessionId, finalCount);
      return;
    }
    // 正常结束
    await this.finalizeTurn(sessionId, finalCount);
  }

  // 消费 eve NDJSON 流:逐事件 mapEveEventToWebtoolEvent → emit + persist + streamIndex 推进。
  // 返回 {eventCount, aborted, error}:runTurn 据此分发到异常/abort/正常收尾路径。
  // try/catch 捕获流错误:abort 抛 AbortError(error 填充,aborted=true)、非 abort 异常(error 填充)。
  private async consumeStream(
    sessionId: string,
    response: MessageResponse,
    signal: AbortSignal,
    eventCountStart: number,
  ): Promise<{ eventCount: number; aborted: boolean; error: Error | null }> {
    const db = await getDb();
    let eventCount = eventCountStart;
    try {
      for await (const event of response) {
        if (signal.aborted) break;
        eventCount += 1;  // 每消费一个 eve event +1(对齐 eve client currentStreamIndex += 1,session.ts:182)
        // [eve] 记录每个流式事件的 type + data 顶层字段名（截断防刷屏）
        // event 是 HandleMessageStreamEvent 联合,部分成员(如 SessionCompletedStreamEvent)无 data,用 narrowing
        const eventData = 'data' in event ? (event as { data?: Record<string, unknown> }).data : undefined;
        const dataKeys = eventData ? Object.keys(eventData).join(',') : '-';
        eveLog(`event sid=${sessionId} type=${event?.type} dataKeys=${dataKeys} eventCount=${eventCount}`);
        // 一个 eve 事件可能映射出多个 WebtoolEvent(actions.requested 遍历、message.appended 先 start 再 delta)
        const webtoolEvents = this.mapEveEventToWebtoolEvent(event, sessionId);
        if (webtoolEvents.length === 0) {
          // [eve] 未映射的事件（system/status 等），记录后跳过
          eveLog(`event unmapped sid=${sessionId} type=${event?.type} -> skip`);
          continue;
        }
        let hasPartEnd = false;  // 是否含 part.end(折中粒度更新 db streamIndex 的触发点)
        for (const we of webtoolEvents) {
          eveLog(`event mapped sid=${sessionId} eveType=${event?.type} -> webtoolType=${we.type}`);
          eventBus.emit(sessionId, we);
          await persistSessionEvent(sessionId, we);
          if (we.type === 'part.end') hasPartEnd = true;
        }
        // 每 part.end 更新 db streamIndex(折中粒度缩小崩溃窗口,对齐 template advanceBrowserSession;崩溃窗口靠 T-006 _pid 去重兜底)
        if (hasPartEnd) {
          await db.update(sessions).set({ streamIndex: eventCount }).where(eq(sessions.id, sessionId));
          eveLog(`streamIndex advance sid=${sessionId} streamIndex=${eventCount}`);
        }
      }
      // [eve] 流正常结束
      eveLog(`stream end sid=${sessionId} aborted=${signal.aborted} streamIndex=${eventCount}`);
      return { eventCount, aborted: signal.aborted, error: null };
    } catch (err: any) {
      // [eve] 记录异常：名字 + 消息，判断是 abort 还是真错误
      eveLog(`error sid=${sessionId} name=${err?.name} msg=${err?.message} aborted=${signal.aborted}`);
      return { eventCount, aborted: signal.aborted, error: err as Error };
    }
  }

  // 非 abort 异常收尾:emit+persist turn.completed(error) 解前端 isSending + finalizeTurn
  // (原 throw 被 send.catch 吞不写 turn.completed,前端 use-session-messages.ts 依赖 turn.completed 解开 → 卡死)
  private async handleTurnError(sessionId: string, err: Error, eventCount: number): Promise<void> {
    const errorEvent = {
      type: 'turn.completed' as const,
      finishReason: 'error' as const,
      error: { code: err?.name ?? 'unknown', message: err?.message ?? String(err) },
    };
    eventBus.emit(sessionId, errorEvent);
    await persistSessionEvent(sessionId, errorEvent);
    await this.finalizeTurn(sessionId, eventCount);
    eveLog(`turn error completed sid=${sessionId} streamIndex=${eventCount}`);
  }

  // 主动停止收尾:写最后一条 assistant interrupted + emit turn.completed(interrupted) + finalizeTurn
  private async handleAbort(sessionId: string, eventCount: number): Promise<void> {
    await this.markInterrupted(sessionId);
    eventBus.emit(sessionId, { type: 'turn.completed', finishReason: 'interrupted' });
    await persistSessionEvent(sessionId, { type: 'turn.completed', finishReason: 'interrupted' });
    await this.finalizeTurn(sessionId, eventCount);
  }

  // turn 收尾(正常/异常/abort 三路径共用,去重):写回最终 streamIndex + 清 pending
  private async finalizeTurn(sessionId: string, eventCount: number): Promise<void> {
    const db = await getDb();
    await db.update(sessions).set({
      streamIndex: eventCount,
      pendingUserMessage: null,
      pendingUserMessageCreatedAt: null,
    }).where(eq(sessions.id, sessionId));
  }

  // 把 session 当前最后一条 assistant 消息标记为 interrupted finishReason
  private async markInterrupted(sessionId: string): Promise<void> {
    const db = await getDb();
    const [lastAssistant] = await db.select().from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'assistant')))
      .orderBy(desc(messages.seq))
      .limit(1);
    if (!lastAssistant) return;
    // finishReason 现存于 metadata JSON 列(非旧 finishReason 列)
    let meta: Record<string, unknown> = {};
    try { meta = lastAssistant.metadata ? JSON.parse(lastAssistant.metadata) : {}; } catch { /* 损坏元数据当空 */ }
    if (meta.finishReason === undefined) {
      meta.finishReason = 'interrupted';
      await db.update(messages)
        .set({ metadata: JSON.stringify(meta) })
        .where(eq(messages.id, lastAssistant.id));
    }
  }

  async stop(sessionId: string): Promise<void> {
    const controller = this.abortControllers.get(sessionId);
    if (!controller) return;
    controller.abort();
    // 清理工作交给 send 的 .finally 收尾；这里不立即 delete 以避免竞态
  }

  onEvent(sessionId: string, cb: (e: WebtoolEvent, eventId?: number) => void, sinceEventId?: number): () => void {
    return eventBus.subscribe(sessionId, cb, sinceEventId);
  }

  /**
   * resume(BackendAdapter.resume 实现):reload 后追回崩溃窗口遗漏的 eve 事件(REV-001 HIGH-1 三层兜底之一)。
   * 触发:SSE 连接时(events/route.ts start)调 adapter.resume?.(sessionId, signal)。
   * 防重复三层:
   *   1. abortControllers.has → turn 正在跑(已在 emit 实时事件给 EventBus,SSE subscribe 即收到),不 resume 防并发重复订阅导致 part.delta 重复累加
   *   2. open turn 检查(最后 assistant finishReason 未定 OR pending 非 stale,复用 T-005 isPendingStale)→ 非 open 不 resume
   *   3. _pid 幂等去重(已落库 partId 跳过 persist)+ persist.ts part.start 兜底去重(T-006 步骤 4)
   * 追回:client.session(state).stream({startIndex: db streamIndex, signal}) 重订阅,boundary 后停止(步骤 5)。
   */
  async resume(sessionId: string, signal: AbortSignal): Promise<void> {
    // HIGH-1:turn 正在跑(abortControllers 有值)→ 已在 emit 实时事件给 EventBus,SSE subscribe 即收到,不 resume
    if (this.abortControllers.has(sessionId)) {
      eveLog(`resume skip sid=${sessionId} reason=turn-running`);
      return;
    }
    // 防并发 resume:SSE 重连可能触发第二次 resume(resuming 有值)→ 跳过,靠 eventBus 缓冲回放补事件
    if (this.resuming.has(sessionId)) {
      eveLog(`resume skip sid=${sessionId} reason=already-resuming`);
      return;
    }
    this.resuming.add(sessionId);
    try {
      await this.doResume(sessionId, signal);
    } finally {
      this.resuming.delete(sessionId);
    }
  }

  // 实际 resume 追回逻辑(由 resume 加锁后调用)
  private async doResume(sessionId: string, signal: AbortSignal): Promise<void> {
    const db = await getDb();
    // 读 db session state(eveSessionId, continuationToken, streamIndex, pendingUserMessage, targetId)
    const [sessRow] = await db.select({
      eveSessionId: sessions.eveSessionId,
      eveContinuationToken: sessions.eveContinuationToken,
      streamIndex: sessions.streamIndex,
      pendingUserMessage: sessions.pendingUserMessage,
      targetId: sessions.targetId,
    }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);

    // 无 eve session(尚未 send 过)→ 无法 resume
    if (!sessRow?.eveSessionId) {
      eveLog(`resume skip sid=${sessionId} reason=no-eve-session`);
      return;
    }

    // 读最后一条 assistant 消息:finishReason(open turn 判定)+ parts _pid 集合(幂等去重)
    const [lastAssistant] = await db.select({ metadata: messages.metadata, parts: messages.parts })
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'assistant')))
      .orderBy(desc(messages.seq))
      .limit(1);

    let finishReason: unknown = undefined;
    const existingPartIds = new Set<string>();
    if (lastAssistant) {
      try {
        const meta = lastAssistant.metadata ? JSON.parse(lastAssistant.metadata) : {};
        finishReason = meta?.finishReason;
      } catch { /* 损坏元数据当空 */ }
      try {
        const parts = lastAssistant.parts ? JSON.parse(lastAssistant.parts) : [];
        if (Array.isArray(parts)) {
          for (const p of parts) {
            const pid = (p as { _pid?: string })._pid;
            if (pid) existingPartIds.add(pid);
          }
        }
      } catch { /* 损坏 parts 当空 */ }
    }

    // open turn 判定:最后 assistant finishReason 未定 OR pending 非 stale(复用 T-005 isPendingStale)
    const openByAssistant = finishReason === undefined;
    const pendingNonStale = sessRow.pendingUserMessage !== null && !(await isPendingStale(sessionId));
    if (!openByAssistant && !pendingNonStale) {
      eveLog(`resume skip sid=${sessionId} reason=not-open-turn finishReason=${String(finishReason)}`);
      return;
    }

    // 取 eve 服务(host + auth),按 serviceId 缓存带 auth 的 Client(对齐 runTurn)
    const [svc] = await db.select({ host: eveServices.host, authType: eveServices.authType, authConfig: eveServices.authConfig })
      .from(eveServices).where(eq(eveServices.id, sessRow.targetId)).limit(1);
    if (!svc) {
      eveLog(`resume skip sid=${sessionId} reason=no-service`);
      return;
    }
    const client = this.getClient(sessRow.targetId, svc.host, svc.authType, svc.authConfig);

    const streamIndex = sessRow.streamIndex ?? 0;
    // sessionState 喂 client.session:eve client #streamAndAdvance 用 startIndex 覆盖 state.streamIndex 追回
    const sessionState = {
      sessionId: sessRow.eveSessionId,
      continuationToken: sessRow.eveContinuationToken ?? undefined,
      streamIndex,
    };
    const clientSession = client.session(sessionState);

    eveLog(`resume start sid=${sessionId} eveSessionId=${sessionState.sessionId} streamIndex=${streamIndex} existingPartIds=${existingPartIds.size} openByAssistant=${openByAssistant} pendingNonStale=${pendingNonStale}`);

    // 重订阅追回:stream({startIndex, signal}) 从 db streamIndex 追回
    // openStreamIterable yield 所有事件直到流关闭,不在 boundary 自动停 → resume 自己 break(步骤 5)
    let eventCount = streamIndex;
    try {
      for await (const event of clientSession.stream({ startIndex: streamIndex, signal })) {
        if (signal.aborted) break;
        eventCount += 1;  // 对齐 runTurn eventCount 语义(每消费一个 eve event +1)
        const webtoolEvents = this.mapEveEventToWebtoolEvent(event, sessionId);
        if (webtoolEvents.length === 0) continue;
        let hasPartEnd = false;
        let isBoundary = false;
        for (const we of webtoolEvents) {
          // _pid 幂等去重:part.* 事件,partId 已在 db parts 集合则跳过 persist
          // (防崩溃窗口重复追回已落库事件导致 parts 重复段 / text 重复累加)
          if (we.type === 'part.start' || we.type === 'part.delta' || we.type === 'part.update' || we.type === 'part.end') {
            if (existingPartIds.has(we.partId)) {
              eveLog(`resume dedup sid=${sessionId} partId=${we.partId} type=${we.type} -> skip persist`);
              continue;
            }
          }
          eventBus.emit(sessionId, we);
          await persistSessionEvent(sessionId, we);
          // 新 part.start 记入集合:防本 turn 后续 delta/update/end 重复 persist(同 partId)
          if (we.type === 'part.start') existingPartIds.add(we.partId);
          if (we.type === 'part.end') hasPartEnd = true;
          if (we.type === 'turn.completed') isBoundary = true;
        }
        // 每 part.end 更新 db streamIndex(对齐 T-003 推进语义,缩小再次崩溃窗口)
        if (hasPartEnd) {
          await db.update(sessions).set({ streamIndex: eventCount }).where(eq(sessions.id, sessionId));
        }
        // boundary 后停止追回(步骤 5):turn.completed/failed/session.waiting 映射出的 turn.completed
        if (isBoundary) {
          eveLog(`resume boundary stop sid=${sessionId} streamIndex=${eventCount}`);
          break;
        }
      }
      // 追回结束写回最终 streamIndex
      await db.update(sessions).set({ streamIndex: eventCount }).where(eq(sessions.id, sessionId));
      eveLog(`resume end sid=${sessionId} streamIndex=${eventCount} aborted=${signal.aborted}`);
    } catch (err: any) {
      // resume 失败不抛(SSE 触发,抛了污染 SSE 响应);记日志即可
      // 不写 turn.completed:resume 失败可能是网络瞬断,turn 实际可能还在跑,误写会 prematurely 结束 turn
      eveLog(`resume error sid=${sessionId} name=${err?.name} msg=${err?.message}`);
    }
  }

  // 按 serviceId 缓存带 auth 的 Client(一个 eve 服务一个 Client 实例,auth 跟着 service 走)。
  // host 或 authKey(authType:authConfig)变更(PATCH 后)→ 下次调用重建 Client,自动生效新 auth,无需重启。
  private getClient(serviceId: string, host: string, authType: string, authConfig: string | null): Client {
    const authKey = `${authType}:${authConfig ?? ''}`;
    const cached = this.clients.get(serviceId);
    if (cached && cached.host === host && cached.authKey === authKey) {
      return cached.client;  // 复用:host+auth 未变
    }
    const authOpts = buildClientOptions(authType, authConfig);
    // 显式配置 maxReconnectAttempts:3——eve client #createEventStream(session.ts:157-221)已内置 stream 级断线重连
    // (isStreamDisconnectError 识别断线错误,用 currentStreamIndex 续接 openStreamBody);webtool 不外包 for await 重连(死代码,见 LOG-003)
    const client = new Client({ host, maxReconnectAttempts: 3, ...authOpts });
    this.clients.set(serviceId, { client, host, authKey });
    return client;
  }

  private async loadHistoryForContext(sessionId: string): Promise<ChatMessage[]> {
    const db = await getDb();
    // 新 schema 无 content 列,从 parts 提取 text(降级点 #2:eve clientContext 仅需文本;完整 parts 传递见 05 后续 adapter 改造)
    const rows = await db.select({ role: messages.role, parts: messages.parts })
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(asc(messages.seq));
    return rows
      .filter((r) => r.role === 'user' || r.role === 'assistant')
      .map((r) => ({ role: r.role as 'user' | 'assistant', content: extractTextFromParts(r.parts) }))
      .filter((r) => r.content);
  }

  // eve 事件 → WebtoolEvent[](按 04-adapter-mapping.md eve 表 + 06 partId 规则)
  // 一个 eve 事件可能产多个 WebtoolEvent(actions.requested 遍历、message.appended 先 start 再 delta)
  private mapEveEventToWebtoolEvent(eveEvent: any, sessionId: string): WebtoolEvent[] {
    const st = this.turnState.get(sessionId) ?? { turnId: null as string | null, startedParts: new Set<string>(), turnEnded: false };
    this.turnState.set(sessionId, st);
    const out: WebtoolEvent[] = [];
    const t = eveEvent?.type;
    const d = eveEvent?.data ?? {};

    // turn.started:记录 turnId,重置 turnEnded + startedParts(新 turn 重新分配 partId)
    if (t === 'turn.started') {
      st.turnId = d.turnId ?? null;
      st.turnEnded = false;
      st.startedParts.clear();
      return out;
    }

    // message.appended:text 增量;首次先 part.start(streaming),后续 part.delta
    if (t === 'message.appended') {
      const delta = d.messageDelta ?? d.delta;
      if (!delta) return out;
      const partId = `${d.turnId ?? st.turnId}:${d.stepIndex}:text`;
      if (!st.startedParts.has(partId)) {
        out.push({ type: 'part.start', partId, part: { type: 'text', text: '', state: 'streaming' } });
        st.startedParts.add(partId);
      }
      out.push({ type: 'part.delta', partId, field: 'text', delta });
      return out;
    }

    // message.completed:text part 结束(带最终 message 校正)
    if (t === 'message.completed') {
      const partId = `${d.turnId ?? st.turnId}:${d.stepIndex}:text`;
      out.push({ type: 'part.end', partId, part: { type: 'text', text: d.message ?? '', state: 'done' } });
      return out;
    }

    // reasoning.appended:reasoning 增量
    if (t === 'reasoning.appended') {
      const delta = d.reasoningDelta ?? d.delta;
      if (!delta) return out;
      const partId = `${d.turnId ?? st.turnId}:${d.stepIndex}:reasoning`;
      if (!st.startedParts.has(partId)) {
        out.push({ type: 'part.start', partId, part: { type: 'reasoning', text: '', state: 'streaming' } });
        st.startedParts.add(partId);
      }
      out.push({ type: 'part.delta', partId, field: 'reasoning', delta });
      return out;
    }

    // reasoning.completed:reasoning part 结束
    if (t === 'reasoning.completed') {
      const partId = `${d.turnId ?? st.turnId}:${d.stepIndex}:reasoning`;
      out.push({ type: 'part.end', partId, part: { type: 'reasoning', text: d.reasoning ?? '', state: 'done' } });
      return out;
    }

    // actions.requested:遍历整个 actions[](修原只取 [0] 的 bug);eve input 一次性给全 → state=input-available
    if (t === 'actions.requested' && Array.isArray(d.actions)) {
      for (const call of d.actions) {
        if (!call?.callId) continue;
        const partId = call.callId;
        out.push({
          type: 'part.start', partId,
          part: {
            type: 'dynamic-tool',
            toolName: call.toolName ?? call.name ?? 'unknown',
            toolCallId: call.callId,
            state: 'input-available',
            input: call.input ?? {},
          },
        });
        st.startedParts.add(partId);
      }
      return out;
    }

    // input.requested:HITL 问题(eve ask_question 或带 approval 的工具)。每个 request → dynamic-tool part
    // state=approval-requested,inputRequest 挂 toolMetadata.eve.inputRequest(前端按 display 渲染卡片)
    // requestId(=action.callId)作 partId,与后续 action.result 的 callId 一致,part.update 能定位
    // 对齐 eve client message-reducer.ts:147-169 的投影
    if (t === 'input.requested' && Array.isArray(d.requests)) {
      for (const request of d.requests) {
        if (!request?.requestId) continue;
        const partId = request.requestId;
        const action = request.action ?? {};
        out.push({
          type: 'part.start', partId,
          part: {
            type: 'dynamic-tool',
            toolName: action.toolName ?? 'ask_question',
            toolCallId: action.callId ?? request.requestId,
            state: 'approval-requested',
            input: action.input ?? {},
            // approval.id=requestId:对齐 eve client,使 ai-elements Confirmation 也可关联
            approval: { id: request.requestId },
            toolMetadata: {
              eve: {
                inputRequest: toMessageInputRequest(request),
                kind: action.kind ?? 'tool-call',
                name: action.toolName ?? 'ask_question',
              },
            },
          },
        });
        st.startedParts.add(partId);
      }
      return out;
    }

    // action.result:更新 tool part state + output(completed→output-available / failed→output-error / rejected→output-denied)
    if (t === 'action.result') {
      const r = d.result ?? {};
      const partId = r.callId;
      if (!partId) return out;
      const status = d.status;
      const patch: Record<string, unknown> = {
        state: status === 'failed' ? 'output-error' : status === 'rejected' ? 'output-denied' : 'output-available',
        output: typeof r.output === 'string' ? r.output : JSON.stringify(r.output ?? ''),
      };
      if (status === 'failed') patch.errorText = r.output ?? '';
      out.push({ type: 'part.update', partId, patch });
      return out;
    }

    // step.completed:token/成本(usage 嵌套在 d.usage:costUsd/inputTokens/outputTokens/cacheReadTokens)。
    // 不写 finishReason 到 metadata——那是 turn 级边界标志(只由 turn.completed 写),
    // 否则 tool-loop 中间 step 的 finishReason='tool-calls' 会让 persist.getOrCreateCurrentAssistant
    // 误判 turn 已结束,把同一 turn 的后续 step 拆到新 assistant 消息(破坏一 turn 一 assistant 语义)。
    if (t === 'step.completed') {
      const meta: Partial<WebtoolMessageMetadata> = {};
      if (d.usage) {
        meta.usage = {
          inputTokens: d.usage.inputTokens,
          outputTokens: d.usage.outputTokens,
          // eve 字段名是 cacheReadTokens,映射到 WebtoolMessageMetadata.usage.cachedInputTokens
          cachedInputTokens: d.usage.cacheReadTokens,
        };
        // cost 也在 d.usage 里(非顶层 d.costUsd)
        if (d.usage.costUsd != null) meta.cost = d.usage.costUsd;
      }
      if (Object.keys(meta).length > 0) out.push({ type: 'message.metadata', metadata: meta });
      return out;
    }

    // session.started:提取 modelId(runtime identity)
    if (t === 'session.started') {
      if (d.runtime?.modelId) out.push({ type: 'message.metadata', metadata: { modelId: d.runtime.modelId } });
      return out;
    }

    // subagent.event:子 agent 流式事件(data.event 是嵌套 HandleMessageStreamEvent,见 eve protocol/message.ts:253-260)
    // 不直接递归 mapEveEventToWebtoolEvent——子事件的 turnState(turn.started 重置 startedParts)/turn.completed
    // 会污染父 turn(重复结束父 assistant 消息)。改为按子事件类型映射,partId 加 sub: 前缀隔离避免与父 part 冲突
    if (t === 'subagent.event' && d.event) {
      const sub = d.event;
      const subType = sub.type;
      const subCallId = d.callId;
      const subName = d.subagentName ?? 'subagent';
      // 子事件含工具调用 → dynamic-tool part(对齐父 actions.requested 投影)
      if (subType === 'actions.requested' && Array.isArray(sub.data?.actions)) {
        for (const action of sub.data.actions) {
          if (!action?.callId) continue;
          const partId = `sub:${subCallId}:${action.callId}`;
          out.push({
            type: 'part.start', partId,
            part: {
              type: 'dynamic-tool',
              toolName: action.toolName ?? action.name ?? `subagent:${subName}`,
              toolCallId: action.callId,
              state: 'input-available',
              input: action.input ?? {},
            },
          });
          st.startedParts.add(partId);
        }
        return out;
      }
      // 子事件 text/reasoning 增量或完成 → reasoning part(累积子 agent 推理/文本,标记子 agent 活动)
      if (typeof subType === 'string' && (subType.startsWith('message.') || subType.startsWith('reasoning.'))) {
        const partId = `sub:${subCallId}:reasoning`;
        // 子事件完成 → 结束 reasoning part
        if (subType.endsWith('.completed')) {
          if (st.startedParts.has(partId)) {
            out.push({ type: 'part.end', partId, part: { type: 'reasoning', text: '', state: 'done' } });
          }
          return out;
        }
        // 子事件增量 → part.delta(首次先 part.start 带子 agent 名前缀)
        const delta = sub.data?.messageDelta ?? sub.data?.reasoningDelta ?? '';
        if (delta) {
          if (!st.startedParts.has(partId)) {
            out.push({ type: 'part.start', partId, part: { type: 'reasoning', text: `[子 agent ${subName}]\n`, state: 'streaming' } });
            st.startedParts.add(partId);
          }
          out.push({ type: 'part.delta', partId, field: 'reasoning', delta });
        }
        return out;
      }
      // 子边界事件(turn.*/session.*/step.*)不映射,避免重复 turn.completed 结束父 turn
      return out;
    }

    // compaction.requested/completed:上下文压缩提示(eve reducer 不投影,webtool 加 reasoning 折叠提示让用户感知)
    // 一 turn 一个 compaction reasoning part(turnId:compaction),startedParts 去重
    if (t === 'compaction.requested' || t === 'compaction.completed') {
      const partId = `${d.turnId ?? st.turnId}:compaction`;
      if (!st.startedParts.has(partId)) {
        out.push({ type: 'part.start', partId, part: { type: 'reasoning', text: '上下文已压缩', state: 'done' } });
        st.startedParts.add(partId);
      }
      return out;
    }

    // authorization.required:权限授权请求(eve 用 authorization part,webtool 统一用 dynamic-tool+approval 对齐 input.requested 语义)
    // partId=${turnId}:${stepIndex}:auth:${name},对齐 eve partKey(authorization:turnId:stepIndex:name,见 message-reducer.ts:508)
    if (t === 'authorization.required') {
      const partId = `${d.turnId ?? st.turnId}:${d.stepIndex}:auth:${d.name}`;
      out.push({
        type: 'part.start', partId,
        part: {
          type: 'dynamic-tool',
          toolName: `auth:${d.name}`,
          toolCallId: partId,
          state: 'approval-requested',
          input: { description: d.description, name: d.name },
          approval: { id: partId },
          toolMetadata: { eve: { kind: 'authorization', name: d.name } },
        },
      });
      st.startedParts.add(partId);
      return out;
    }

    // authorization.completed:授权结果(authorized→output-available / declined/failed/timed-out→output-denied)
    if (t === 'authorization.completed') {
      const partId = `${d.turnId ?? st.turnId}:${d.stepIndex}:auth:${d.name}`;
      const outcome = d.outcome;
      out.push({
        type: 'part.update', partId,
        patch: {
          state: outcome === 'authorized' ? 'output-available' : 'output-denied',
          output: outcome,
          approval: { id: partId, approved: outcome === 'authorized', reason: d.reason },
        },
      });
      return out;
    }

    // result.completed:结构化输出(eve reducer 投影到 metadata.result,见 message-reducer.ts:263-264;
    // webtool WebtoolMessageMetadata 无 result 字段且不改 events.ts,映射为 text part 显示最终结构化输出)
    if (t === 'result.completed') {
      const partId = `${d.turnId ?? st.turnId}:${d.stepIndex ?? 0}:result`;
      out.push({ type: 'part.start', partId, part: { type: 'text', text: '', state: 'streaming' } });
      out.push({ type: 'part.end', partId, part: { type: 'text', text: JSON.stringify(d.result ?? ''), state: 'done' } });
      st.startedParts.add(partId);
      return out;
    }

    // 边界事件:turn.completed/failed/session.waiting/completed/failed(去重,首个边界发 turn.completed)
    const isBoundary = t === 'turn.completed' || t === 'turn.failed' || t === 'session.waiting' || t === 'session.completed' || t === 'session.failed';
    if (isBoundary) {
      if (!st.turnEnded) {
        if (t === 'turn.failed' || t === 'session.failed') {
          out.push({ type: 'turn.completed', finishReason: 'error', error: { code: t, message: d.message ?? t } });
        } else {
          out.push({ type: 'turn.completed', finishReason: 'stop' });
        }
        st.turnEnded = true;
      }
      // session.failed 表示会话死亡,追加 disconnected
      if (t === 'session.failed') {
        out.push({ type: 'session.disconnected', reason: 'restart' });
      }
      return out;
    }

    return out; // step.started(无 UI 可见信息,stepIndex 已在后续事件 data 里)/message.received(D-005:user 消息由 POST /messages 落库为权威源,映射会重复)暂未映射
  }
}
