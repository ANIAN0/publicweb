import { Client, MessageResponse } from 'eve/client';
import { BackendAdapter, ChatMessage, ExecutionTarget, MessageAttachmentRef } from './types';
import { parseAuthConfig, asAuthType, type AuthType } from './eve-auth';
import { WebtoolEvent, type WebtoolMessageMetadata, type InputResponse } from '../protocol/events';
import { eventBus } from './event-bus';
import { getDb } from '../db/client';
import { sessions, messages, eveServices } from '../db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { persistSessionEvent } from './persist';
import { isPendingStale } from './pending';
import { loadConversationHistory } from '@/lib/chat/history';
import { readAttachmentBuffer } from '../attachments/store';
import { debugLog } from '../debug-log';
import { getTurnRunId, settleTurnLock } from './turn-lock';

// [eve] 调试日志：异步缓冲写 workplace/logs（LIB-005：禁止热路径 appendFileSync）
function eveLog(msg: string): void {
  debugLog('eve', msg);
}

// 从 db 行的 authType + authConfig 构造 eve ClientOptions 的 auth / headers(明文 token 从 authConfig JSON 读)
//   bearer → { auth: { bearer: token } }         注入 Authorization: Bearer <token>
//   headers → { headers: Record<string,string> } 注入自定义请求头(如 x-api-key)
//   none   → {}                                  无认证
// 返回结构对齐 eve ClientAuth/HeadersValue(eve client #resolveAuthHeaders/#resolveHeaders 消费)
// LIB-017：authType 收窄为 AuthType，避免任意 string 穿透
function buildClientOptions(authType: AuthType, authConfig: string | null): { auth?: { bearer: string }; headers?: Record<string, string> } {
  // 复用 eve-auth.parseAuthConfig:解析 + 空值过滤统一,与 validateAuth 两处一致(buildClientOptions + 编辑回显共用)
  const parsed = parseAuthConfig(authConfig);
  if (authType === 'bearer' && parsed?.token) {
    return { auth: { bearer: parsed.token } };
  }
  if (authType === 'headers' && parsed?.headers) {
    return { headers: parsed.headers };
  }
  return {};
}

// LIB-007：HITL request 窄化后的 UI 可见字段（对齐 eve client toMessageInputRequest）
// 前端 InputRequestCard：prompt + display 三态 + options + allowFreeform
type MessageInputRequestView = {
  requestId: string;
  prompt: string;
  display?: 'confirmation' | 'select' | 'text';
  options?: { id: string; label: string; description?: string; style?: 'danger' | 'default' | 'primary' }[];
  allowFreeform?: boolean;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** 从 unknown 窄化为 InputRequest 视图；字段缺失用安全默认，不抛 */
function toMessageInputRequest(request: unknown): MessageInputRequestView {
  const r = isRecord(request) ? request : {};
  const requestId = typeof r.requestId === 'string' ? r.requestId : '';
  const prompt = typeof r.prompt === 'string' ? r.prompt : '';
  const display =
    r.display === 'confirmation' || r.display === 'select' || r.display === 'text'
      ? r.display
      : undefined;
  let options: MessageInputRequestView['options'];
  if (Array.isArray(r.options)) {
    options = r.options.map((o, i) => {
      const opt = isRecord(o) ? o : {};
      return {
        id: typeof opt.id === 'string' ? opt.id : String(i),
        label: typeof opt.label === 'string' ? opt.label : String(opt.id ?? i),
        ...(typeof opt.description === 'string' ? { description: opt.description } : {}),
        ...(opt.style === 'danger' || opt.style === 'default' || opt.style === 'primary'
          ? { style: opt.style }
          : {}),
      };
    });
  }
  const allowFreeform = typeof r.allowFreeform === 'boolean' ? r.allowFreeform : undefined;
  return {
    requestId,
    prompt,
    ...(display !== undefined ? { display } : {}),
    ...(options !== undefined ? { options } : {}),
    ...(allowFreeform !== undefined ? { allowFreeform } : {}),
  };
}

/** LIB-006：eve NDJSON 事件窄化入口 */
type EveStreamEvent = {
  type?: string;
  data?: Record<string, unknown>;
};

function asEveEvent(eveEvent: unknown): EveStreamEvent {
  if (!isRecord(eveEvent)) return {};
  const data = isRecord(eveEvent.data) ? eveEvent.data : {};
  return {
    type: typeof eveEvent.type === 'string' ? eveEvent.type : undefined,
    data,
  };
}

/** LIB-013：合成 partId 时避免 `undefined` 字面串；缺省用 0 / unknown */
function evePartId(
  turnId: unknown,
  stepIndex: unknown,
  kind: string,
  extra?: string,
): string {
  const turn =
    typeof turnId === 'string' && turnId.length > 0
      ? turnId
      : turnId != null && turnId !== ''
        ? String(turnId)
        : 'unknown';
  const step =
    typeof stepIndex === 'number' && Number.isFinite(stepIndex)
      ? stepIndex
      : typeof stepIndex === 'string' && stepIndex.length > 0
        ? stepIndex
        : 0;
  return extra !== undefined ? `${turn}:${step}:${kind}:${extra}` : `${turn}:${step}:${kind}`;
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
      const client = this.getClient(svc.id, svc.host, asAuthType(svc.authType), svc.authConfig);
      const online = await this.probe(client, svc.host);
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
  private async probe(client: Client, host: string): Promise<boolean> {
    try {
      await client.fetch('/info', { signal: AbortSignal.timeout(10000) });
      return true;
    } catch (err: unknown) {
      // LIB-039：统一 eveLog（debugLog 落文件）；不再 console.error 双写刷屏
      const e = err as { code?: string; name?: string; message?: string };
      const code = e?.code ?? e?.name ?? 'unknown';
      const msg = (e?.message ?? String(err)).slice(0, 200);
      eveLog(`probe failed host=${host} code=${code} msg=${msg}`);
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

  // 排队执行 turn：send / respondInput 共用串行链，避免并发撞 continuationToken
  private enqueueTurn(
    sessionId: string,
    content: string,
    inputResponses?: InputResponse[],
    runId?: string,
  ): Promise<void> {
    const prev = this.turnChain.get(sessionId) ?? Promise.resolve();
    const controller = new AbortController();
    this.abortControllers.set(sessionId, controller);
    // host+auth 由 runTurn 从 db 读 service 行获取(sessions.targetId → eve_services),无需内存映射
    const next = prev.then(() => this.runTurn(sessionId, content, controller.signal, inputResponses, runId)).catch(async (err) => {
      // clientSession.send 前失败也必须形成终态并释放锁，不能只记日志。
      const event = err?.name === 'AbortError'
        ? ({ type: 'abort' as const, reason: 'user_stop' })
        : ({ type: 'error' as const, errorText: `${err?.name ?? 'unknown'}: ${err?.message ?? String(err)}` });
      eventBus.emit(sessionId, event, runId);
      await persistSessionEvent(sessionId, event, runId).catch((persistErr) => {
        console.error(`[eveagent] dispatch failure persist sid=${sessionId}:`, persistErr);
      });
      await settleTurnLock(sessionId, runId);
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
    // BackendAdapter.send 的契约是“成功派发/入队即返回”，不能让 HTTP Route
    // 等待整个远端 turn。运行期错误由上面的 catch + 终态事件路径收敛。
    return Promise.resolve();
  }

  /**
   * 用户消息 + 可选附件。
   * eve 无本机路径：文本类嵌入正文；图片用 markdown data URL；其它二进制给 base64 说明。
   */
  async send(
    sessionId: string,
    content: string,
    opts?: { attachments?: MessageAttachmentRef[]; runId?: string },
  ): Promise<void> {
    // D-006：中心分配 runId；进程内 eve 同样走 generation-stream
    const { ulid } = await import('ulid');
    const { generationStream } = await import('@/lib/events/generation-stream');
    const { beginTurnIdle } = await import('@/lib/events/turn-idle-tracker');
    const runId = opts?.runId ?? ulid();
    generationStream.openRun(sessionId, runId);
    beginTurnIdle(sessionId);
    const message = await this.composeMessageWithAttachments(sessionId, content, opts?.attachments);
    return this.enqueueTurn(sessionId, message, undefined, runId);
  }

  /**
   * HITL 独立通道：空 message + inputResponses 续接 eve durable session
   *（createHandleMessageBody 要求 inputResponses 配 continuationToken）
   */
  async respondInput(sessionId: string, responses: InputResponse[]): Promise<void> {
    if (!responses.length) throw new Error('respondInput requires non-empty responses');
    return this.enqueueTurn(sessionId, '', responses, await getTurnRunId(sessionId));
  }

  /** 把已上传附件并入 eve 可读的 message 字符串（云端 agent 无法读 webtool 本机路径） */
  private async composeMessageWithAttachments(
    sessionId: string,
    content: string,
    attachments?: MessageAttachmentRef[],
  ): Promise<string> {
    if (!attachments?.length) return content;
    const blocks: string[] = [];
    for (const ref of attachments) {
      const buf = await readAttachmentBuffer(sessionId, ref.id);
      if (!buf) {
        blocks.push(`\n\n[附件缺失: ${ref.filename} id=${ref.id}]`);
        continue;
      }
      const mt = ref.mediaType || 'application/octet-stream';
      const name = ref.filename || buf.filename;
      if (mt.startsWith('text/') || mt === 'application/json' || mt === 'application/javascript') {
        // 文本直接嵌入，agent 无需二次拉取
        const text = buf.data.toString('utf8');
        blocks.push(`\n\n[附件: ${name} (${mt})]\n\`\`\`\n${text}\n\`\`\``);
      } else if (mt.startsWith('image/')) {
        const b64 = buf.data.toString('base64');
        blocks.push(`\n\n[图片附件: ${name}]\n![${name}](data:${mt};base64,${b64})`);
      } else {
        // 其它二进制：给元数据 + base64，供 agent 解码/工具处理
        const b64 = buf.data.toString('base64');
        blocks.push(
          `\n\n[二进制附件: ${name} (${mt}, ${buf.data.byteLength} bytes)]\n` +
            `base64:\n${b64}`,
        );
      }
    }
    const body = content.trim() ? content : '（见附件）';
    return body + blocks.join('');
  }

  private async runTurn(
    sessionId: string,
    content: string,
    signal: AbortSignal,
    inputResponses?: InputResponse[],
    runId?: string,
  ): Promise<void> {
    const db = await getDb();
    const history = await this.loadHistoryForContext(sessionId);

    // 一次 leftJoin 取 session + 关联 eve 服务(host+auth),替代原来两次独立 select(热路径减半查询)
    // service 已删时 host 为 null(原 svc 查不到),保留 throw 语义
    const [row] = await db.select({
      eveSessionId: sessions.eveSessionId,
      eveContinuationToken: sessions.eveContinuationToken,
      streamIndex: sessions.streamIndex,
      targetId: sessions.targetId,
      host: eveServices.host,
      authType: eveServices.authType,
      authConfig: eveServices.authConfig,
    }).from(sessions)
      .leftJoin(eveServices, eq(sessions.targetId, eveServices.id))
      .where(eq(sessions.id, sessionId)).limit(1);
    if (!row) throw new Error(`Session ${sessionId} not found`);
    if (!row.host || !row.targetId) throw new Error(`eve service not found: ${row.targetId ?? '(no target)'}`);
    const client = this.getClient(row.targetId, row.host, asAuthType(row.authType), row.authConfig);

    // resume eve durable session:从 db 取上次 turn 持久化的 sessionId + continuationToken,
    // 喂给 client.session(state)。否则每次 client.session() 都新建会话,HITL 回答(inputResponses-only)
    // 无 continuationToken,createHandleMessageBody 命中 "continuationToken===undefined && message===undefined"
    // 返回 null,抛 "Session.send requires a non-empty message, inputResponses, or both"
    // (eve client/session.ts:345-355:inputResponses 必须配 continuationToken 才能构造 body)
    // streamIndex 从 db 读(替代硬编码 0):eve client #createEventStream 用 state.streamIndex 作 startIndex 续接(session.ts:166)
    // [修复 continuationToken 400] sessionId 有但 continuationToken 缺失时,eve client #postTurn
    // 仍按 sessionId 走续接路径(POST /eve/v1/session/<id>),但 createHandleMessageBody 不把
    // undefined 的 continuationToken 放进 body -> 服务端 400 "Missing or empty 'continuationToken' field"
    // 缺 token 本就无法 resume,回退新建会话(clientContext 传历史保持上下文),并清失效的 eveSessionId 防再命中
    const canResume = Boolean(row.eveSessionId && row.eveContinuationToken);
    const sessionState = canResume
      ? { sessionId: row.eveSessionId!, continuationToken: row.eveContinuationToken!, streamIndex: row.streamIndex ?? 0 }
      : undefined;
    if (row.eveSessionId && !canResume) {
      eveLog(`continuationToken missing sid=${sessionId} eveSessionId=${row.eveSessionId} -> 回退新建会话,清除失效引用`);
      await db.update(sessions)
        .set({ eveSessionId: null, eveContinuationToken: null, streamIndex: 0 })
        .where(eq(sessions.id, sessionId));
    }
    if (sessionState) {
      eveLog(`resume sid=${sessionId} eveSessionId=${sessionState.sessionId} hasToken=${sessionState.continuationToken !== undefined} streamIndex=${sessionState.streamIndex} inputResponsesLen=${inputResponses?.length ?? 0}`);
    }
    const clientSession = client.session(sessionState);
    // eventCount 对齐 eve client currentStreamIndex(session.ts:182):从 db streamIndex 起始,每消费一个 eve event +1
    const eventCountStart = row.streamIndex ?? 0;

    const clientContext = history.length > 0
      ? JSON.stringify(history.map((m) => ({ role: m.role, content: m.content })))
      : undefined;

    // [eve] 记录请求：host + content 预览 + history 条数 + clientContext 长度 + inputResponses 条数
    eveLog(`runTurn sid=${sessionId} host=${row.host} content=${JSON.stringify(content.slice(0, 50))} historyLen=${history.length} clientContextLen=${clientContext?.length ?? 0} inputResponsesLen=${inputResponses?.length ?? 0}`);

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
    const { eventCount: finalCount, aborted, error } = await this.consumeStream(sessionId, response, signal, eventCountStart, runId);
    if (error && error.name !== 'AbortError' && !aborted) {
      // 非 abort 异常:emit+persist turn.completed(error) 解前端 isSending,再抛出(send.catch 吞)
      await this.handleTurnError(sessionId, error, finalCount, runId);
      return;
    }
    if (aborted) {
      // 主动停止:写 interrupted + emit turn.completed(interrupted) 让前端解开 isSending
      await this.handleAbort(sessionId, finalCount, runId);
      return;
    }
    // 正常结束
    await this.finalizeTurn(sessionId, finalCount, runId);
  }

  // 消费 eve NDJSON 流:逐事件 mapEveEventToWebtoolEvent → emit + persist + streamIndex 推进。
  // 返回 {eventCount, aborted, error}:runTurn 据此分发到异常/abort/正常收尾路径。
  // try/catch 捕获流错误:abort 抛 AbortError(error 填充,aborted=true)、非 abort 异常(error 填充)。
  private async consumeStream(
    sessionId: string,
    response: MessageResponse,
    signal: AbortSignal,
    eventCountStart: number,
    runId?: string,
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
          await persistSessionEvent(sessionId, we, runId);
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

  // 非 abort 异常收尾:emit+persist error chunk 解前端 isSending + finalizeTurn
  private async handleTurnError(sessionId: string, err: Error, eventCount: number, runId?: string): Promise<void> {
    const errorEvent = {
      type: 'error' as const,
      errorText: `${err?.name ?? 'unknown'}: ${err?.message ?? String(err)}`,
    };
    eventBus.emit(sessionId, errorEvent);
    await persistSessionEvent(sessionId, errorEvent, runId);
    await this.finalizeTurn(sessionId, eventCount, runId);
    eveLog(`turn error completed sid=${sessionId} streamIndex=${eventCount}`);
  }

  // 主动停止收尾:abort chunk + finalizeTurn
  private async handleAbort(sessionId: string, eventCount: number, runId?: string): Promise<void> {
    await this.markInterrupted(sessionId);
    const abortEvent = { type: 'abort' as const, reason: 'user_stop' };
    eventBus.emit(sessionId, abortEvent);
    await persistSessionEvent(sessionId, abortEvent, runId);
    await this.finalizeTurn(sessionId, eventCount, runId);
  }

  // turn 收尾(正常/异常/abort 三路径共用,去重):写回最终 streamIndex + 清 pending
  private async finalizeTurn(sessionId: string, eventCount: number, runId?: string): Promise<void> {
    const db = await getDb();
    await db.update(sessions).set({
      streamIndex: eventCount,
    }).where(eq(sessions.id, sessionId));
    await settleTurnLock(sessionId, runId);
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

  /**
   * 释放 session 级运行时态（LIB-002）。
   * 清理 turnChain / turnState / abortControllers / resuming；
   * clients 按 serviceId 缓存有意保留；EventBus 缓冲一并 release。
   * 在会话 DELETE 等路径调用。
   */
  releaseRuntime(sessionId: string): void {
    // 若仍有进行中的 turn，先 abort 再清 Map
    const controller = this.abortControllers.get(sessionId);
    if (controller) {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
    }
    this.abortControllers.delete(sessionId);
    this.turnChain.delete(sessionId);
    this.turnState.delete(sessionId);
    this.resuming.delete(sessionId);
    eventBus.release(sessionId);
    eveLog(`releaseRuntime sid=${sessionId}`);
  }

  // LIB-015：eventId 始终由 EventBus 提供
  onEvent(sessionId: string, cb: (e: WebtoolEvent, eventId: number, runId?: string) => void, sinceEventId?: number): () => void {
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
    // 读 db session state + 关联 eve 服务(host+auth)一次 leftJoin 取齐(对齐 runTurn,减一次查询)
    const [sessRow] = await db.select({
      eveSessionId: sessions.eveSessionId,
      eveContinuationToken: sessions.eveContinuationToken,
      streamIndex: sessions.streamIndex,
      pendingUserMessage: sessions.pendingUserMessage,
      targetId: sessions.targetId,
      host: eveServices.host,
      authType: eveServices.authType,
      authConfig: eveServices.authConfig,
    }).from(sessions)
      .leftJoin(eveServices, eq(sessions.targetId, eveServices.id))
      .where(eq(sessions.id, sessionId)).limit(1);

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

    // eve 服务(host+auth)已随上面 leftJoin 取到:无 service(host 为 null)→ 跳过
    if (!sessRow.host || !sessRow.targetId) {
      eveLog(`resume skip sid=${sessionId} reason=no-service`);
      return;
    }
    const client = this.getClient(sessRow.targetId, sessRow.host, asAuthType(sessRow.authType), sessRow.authConfig);

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
          // 兼容 legacy part.* 与 UIMessageChunk 去重
          const partId =
            'partId' in we && typeof (we as { partId?: string }).partId === 'string'
              ? (we as { partId: string }).partId
              : 'id' in we && typeof (we as { id?: string }).id === 'string'
                ? (we as { id: string }).id
                : 'toolCallId' in we && typeof (we as { toolCallId?: string }).toolCallId === 'string'
                  ? (we as { toolCallId: string }).toolCallId
                  : null;
          if (
            partId &&
            (we.type === 'part.start' ||
              we.type === 'part.delta' ||
              we.type === 'part.update' ||
              we.type === 'part.end' ||
              we.type === 'text-start' ||
              we.type === 'text-delta' ||
              we.type === 'text-end' ||
              we.type === 'reasoning-start' ||
              we.type === 'reasoning-delta' ||
              we.type === 'reasoning-end')
          ) {
            if (existingPartIds.has(partId) && (we.type === 'part.start' || we.type === 'text-start' || we.type === 'reasoning-start')) {
              eveLog(`resume dedup sid=${sessionId} partId=${partId} type=${we.type} -> skip persist`);
              continue;
            }
          }
          eventBus.emit(sessionId, we);
          await persistSessionEvent(sessionId, we);
          if (we.type === 'part.start' || we.type === 'text-start' || we.type === 'reasoning-start') {
            if (partId) existingPartIds.add(partId);
          }
          if (we.type === 'part.end' || we.type === 'text-end' || we.type === 'reasoning-end') hasPartEnd = true;
          if (
            we.type === 'turn.completed' ||
            we.type === 'finish' ||
            we.type === 'abort' ||
            we.type === 'error'
          ) {
            isBoundary = true;
          }
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
  // LIB-017：authType 使用联合类型，调用方经 asAuthType 收窄
  private getClient(serviceId: string, host: string, authType: AuthType, authConfig: string | null): Client {
    const authKey = `${authType}:${authConfig ?? ''}`;
    const cached = this.clients.get(serviceId);
    if (cached && cached.host === host && cached.authKey === authKey) {
      return cached.client;  // 复用:host+auth 未变
    }
    // 重建原因:cache miss / host 变更 / authKey 变更(PATCH auth 后下次调用命中此分支)
    // 用 eveLog 写入 workplace/logs/eve-YYYYMMDD.log,便于 V-011 验收阶段 grep 验证
    const reason = !cached
      ? 'cache miss'
      : cached.host !== host
        ? 'host changed'
        : 'authKey changed';
    eveLog(`[eveagent] client rebuild serviceId=${serviceId} reason=${reason}`);
    const authOpts = buildClientOptions(authType, authConfig);
    // 显式配置 maxReconnectAttempts:3——eve client #createEventStream(session.ts:157-221)已内置 stream 级断线重连
    // (isStreamDisconnectError 识别断线错误,用 currentStreamIndex 续接 openStreamBody);webtool 不外包 for await 重连(死代码,见 LOG-003)
    const client = new Client({ host, maxReconnectAttempts: 3, ...authOpts });
    this.clients.set(serviceId, { client, host, authKey });
    return client;
  }

  private async loadHistoryForContext(sessionId: string): Promise<ChatMessage[]> {
    // APP-008：复用 history helper（parts→text 降级点 #2 集中在 lib/chat）
    return loadConversationHistory(sessionId);
  }

  // eve 事件 → WebtoolEvent[](按 04-adapter-mapping.md eve 表 + 06 partId 规则)
  // 一个 eve 事件可能产多个 WebtoolEvent(actions.requested 遍历、message.appended 先 start 再 delta)
  // LIB-006/011：入口 unknown + 窄化；分支仍集中于此（拆文件会破坏与 04 映射表对照）
  private mapEveEventToWebtoolEvent(eveEvent: unknown, sessionId: string): WebtoolEvent[] {
    // LIB-012：仅在缺失时写入 Map，避免每 event 重复 set 同一引用
    let st = this.turnState.get(sessionId);
    if (!st) {
      st = { turnId: null, startedParts: new Set<string>(), turnEnded: false };
      this.turnState.set(sessionId, st);
    }
    const out: WebtoolEvent[] = [];
    const { type: t, data: d = {} } = asEveEvent(eveEvent);
    const activeTurn = () =>
      (typeof d.turnId === 'string' ? d.turnId : null) ?? st!.turnId;

    // turn.started:记录 turnId,重置 turnEnded + startedParts(新 turn 重新分配 partId)
    if (t === 'turn.started') {
      st.turnId = typeof d.turnId === 'string' ? d.turnId : d.turnId != null ? String(d.turnId) : null;
      st.turnEnded = false;
      st.startedParts.clear();
      return out;
    }

    // message.appended:text 增量 → text-start / text-delta
    if (t === 'message.appended') {
      const delta = d.messageDelta ?? d.delta;
      if (typeof delta !== 'string' || !delta) return out;
      const partId = evePartId(activeTurn(), d.stepIndex, 'text');
      if (!st.startedParts.has(partId)) {
        out.push({ type: 'text-start', id: partId });
        st.startedParts.add(partId);
      }
      out.push({ type: 'text-delta', id: partId, delta });
      return out;
    }

    // message.completed:text-end
    if (t === 'message.completed') {
      const partId = evePartId(activeTurn(), d.stepIndex, 'text');
      out.push({ type: 'text-end', id: partId });
      return out;
    }

    // reasoning.appended → reasoning-start / reasoning-delta
    if (t === 'reasoning.appended') {
      const delta = d.reasoningDelta ?? d.delta;
      if (typeof delta !== 'string' || !delta) return out;
      const partId = evePartId(activeTurn(), d.stepIndex, 'reasoning');
      if (!st.startedParts.has(partId)) {
        out.push({ type: 'reasoning-start', id: partId });
        st.startedParts.add(partId);
      }
      out.push({ type: 'reasoning-delta', id: partId, delta });
      return out;
    }

    // reasoning.completed → reasoning-end
    if (t === 'reasoning.completed') {
      const partId = evePartId(activeTurn(), d.stepIndex, 'reasoning');
      out.push({ type: 'reasoning-end', id: partId });
      return out;
    }

    // actions.requested:遍历整个 actions[](修原只取 [0] 的 bug);eve input 一次性给全 → state=input-available
    if (t === 'actions.requested' && Array.isArray(d.actions)) {
      for (const call of d.actions) {
        if (!isRecord(call) || typeof call.callId !== 'string') continue;
        const partId = call.callId;
        const toolName =
          (typeof call.toolName === 'string' && call.toolName) ||
          (typeof call.name === 'string' && call.name) ||
          'unknown';
        out.push({
          type: 'tool-input-start',
          toolCallId: call.callId,
          toolName,
          dynamic: true,
        });
        out.push({
          type: 'tool-input-available',
          toolCallId: call.callId,
          toolName,
          input: call.input ?? {},
          dynamic: true,
        });
        st.startedParts.add(partId);
      }
      return out;
    }

    // input.requested:HITL 问题(eve ask_question 或带 approval 的工具)。每个 request → dynamic-tool part
    // state=approval-requested,inputRequest 挂 toolMetadata.inputRequest(前端按 display 渲染卡片)
    // requestId(=action.callId)作 partId,与后续 action.result 的 callId 一致,part.update 能定位
    if (t === 'input.requested' && Array.isArray(d.requests)) {
      for (const request of d.requests) {
        if (!isRecord(request) || typeof request.requestId !== 'string') continue;
        const partId = request.requestId;
        const action = isRecord(request.action) ? request.action : {};
        const toolName =
          (typeof action.toolName === 'string' && action.toolName) || 'ask_question';
        const toolCallId =
          (typeof action.callId === 'string' && action.callId) || request.requestId;
        out.push({
          type: 'part.start', partId,
          part: {
            type: 'dynamic-tool',
            toolName,
            toolCallId,
            state: 'approval-requested',
            input: action.input ?? {},
            approval: { id: request.requestId },
            toolMetadata: {
              inputRequest: toMessageInputRequest(request),
              kind: (typeof action.kind === 'string' && action.kind) || 'tool-call',
              name: toolName,
            },
          },
        });
        st.startedParts.add(partId);
      }
      return out;
    }

    // action.result:更新 tool part state + output
    if (t === 'action.result') {
      const r = isRecord(d.result) ? d.result : {};
      const partId = typeof r.callId === 'string' ? r.callId : undefined;
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

    // step.completed:token/成本(usage 嵌套在 d.usage)。不写 finishReason（turn 边界专用）
    if (t === 'step.completed') {
      const meta: Partial<WebtoolMessageMetadata> = {};
      if (isRecord(d.usage)) {
        const u = d.usage;
        meta.usage = {
          inputTokens: typeof u.inputTokens === 'number' ? u.inputTokens : undefined,
          outputTokens: typeof u.outputTokens === 'number' ? u.outputTokens : undefined,
          cachedInputTokens: typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : undefined,
        };
        if (typeof u.costUsd === 'number') meta.cost = u.costUsd;
      }
      if (meta.usage || meta.cost != null) out.push({ type: 'message.metadata', metadata: meta });
      return out;
    }

    // session.started:提取 modelId(runtime identity)
    if (t === 'session.started') {
      const runtime = isRecord(d.runtime) ? d.runtime : undefined;
      if (runtime && typeof runtime.modelId === 'string') {
        out.push({ type: 'message.metadata', metadata: { modelId: runtime.modelId } });
      }
      return out;
    }

    // subagent.event:不递归 map（避免污染父 turnState）；partId 加 sub: 前缀隔离
    if (t === 'subagent.event' && isRecord(d.event)) {
      const sub = d.event;
      const subType = typeof sub.type === 'string' ? sub.type : undefined;
      const subData = isRecord(sub.data) ? sub.data : {};
      const subCallId = d.callId;
      const subName = typeof d.subagentName === 'string' ? d.subagentName : 'subagent';
      if (subType === 'actions.requested' && Array.isArray(subData.actions)) {
        for (const action of subData.actions) {
          if (!isRecord(action) || typeof action.callId !== 'string') continue;
          const partId = `sub:${String(subCallId ?? 'x')}:${action.callId}`;
          const toolName =
            (typeof action.toolName === 'string' && action.toolName) ||
            (typeof action.name === 'string' && action.name) ||
            `subagent:${subName}`;
          out.push({
            type: 'part.start', partId,
            part: {
              type: 'dynamic-tool',
              toolName,
              toolCallId: action.callId,
              state: 'input-available',
              input: action.input ?? {},
            },
          });
          st.startedParts.add(partId);
        }
        return out;
      }
      if (subType && (subType.startsWith('message.') || subType.startsWith('reasoning.'))) {
        const partId = `sub:${String(subCallId ?? 'x')}:reasoning`;
        if (subType.endsWith('.completed')) {
          if (st.startedParts.has(partId)) {
            out.push({ type: 'part.end', partId, part: { type: 'reasoning', text: '', state: 'done' } });
          }
          return out;
        }
        const deltaRaw = subData.messageDelta ?? subData.reasoningDelta ?? '';
        const delta = typeof deltaRaw === 'string' ? deltaRaw : '';
        if (delta) {
          if (!st.startedParts.has(partId)) {
            out.push({
              type: 'part.start',
              partId,
              part: { type: 'reasoning', text: `[子 agent ${subName}]\n`, state: 'streaming' },
            });
            st.startedParts.add(partId);
          }
          out.push({ type: 'part.delta', partId, field: 'reasoning', delta });
        }
        return out;
      }
      return out;
    }

    // compaction：一 turn 一个 reasoning 提示
    if (t === 'compaction.requested' || t === 'compaction.completed') {
      const turn = activeTurn() ?? 'unknown';
      const partId = `${turn}:compaction`;
      if (!st.startedParts.has(partId)) {
        out.push({ type: 'part.start', partId, part: { type: 'reasoning', text: '上下文已压缩', state: 'done' } });
        st.startedParts.add(partId);
      }
      return out;
    }

    // authorization.required → dynamic-tool + approval
    if (t === 'authorization.required') {
      const name = typeof d.name === 'string' ? d.name : 'auth';
      const partId = evePartId(activeTurn(), d.stepIndex, 'auth', name);
      out.push({
        type: 'part.start', partId,
        part: {
          type: 'dynamic-tool',
          toolName: `auth:${name}`,
          toolCallId: partId,
          state: 'approval-requested',
          input: { description: d.description, name },
          approval: { id: partId },
          toolMetadata: { kind: 'authorization', name },
        },
      });
      st.startedParts.add(partId);
      return out;
    }

    if (t === 'authorization.completed') {
      const name = typeof d.name === 'string' ? d.name : 'auth';
      const partId = evePartId(activeTurn(), d.stepIndex, 'auth', name);
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

    // result.completed → text part 展示结构化输出
    if (t === 'result.completed') {
      const partId = evePartId(activeTurn(), d.stepIndex ?? 0, 'result');
      out.push({ type: 'part.start', partId, part: { type: 'text', text: '', state: 'streaming' } });
      out.push({
        type: 'part.end',
        partId,
        part: { type: 'text', text: JSON.stringify(d.result ?? ''), state: 'done' },
      });
      st.startedParts.add(partId);
      return out;
    }

    // 边界事件:turn.completed/failed/session.waiting/completed/failed(去重)
    const isBoundary =
      t === 'turn.completed' ||
      t === 'turn.failed' ||
      t === 'session.waiting' ||
      t === 'session.completed' ||
      t === 'session.failed';
    if (isBoundary) {
      if (!st.turnEnded) {
        if (t === 'turn.failed' || t === 'session.failed') {
          const message =
            typeof d.message === 'string' ? d.message : (t ?? 'error');
          out.push({
            type: 'error',
            errorText: `${t ?? 'error'}: ${message}`,
          });
        } else {
          out.push({ type: 'finish', finishReason: 'stop' });
        }
        st.turnEnded = true;
      }
      if (t === 'session.failed') {
        out.push({ type: 'session.disconnected', reason: 'restart' });
      }
      return out;
    }

    return out;
  }
}
